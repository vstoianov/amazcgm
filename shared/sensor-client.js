import { BLEMaster } from '../lib/ble-master'
import { queryPermission, requestPermission } from '@zos/app'
import { Time } from '@zos/sensor'
import {
  hexToBytes,
  bytesToHex,
  streamingUnlockPayload,
  decryptBLE,
  bleCrcOk,
  parseCurrent,
  parseTrend
} from './crypto'
import {
  getSensor,
  getUnlockCount,
  bumpUnlockCount,
  setSessionWanted,
  loadLastReading,
  getLiveMac,
  setLiveMac,
  hasStoredScan,
  bumpBleStuckRuns,
  loadAdvertPhase,
  saveAdvertPhase,
  getBlePids
} from './session'
import { later, cancelLater, every, cancelEvery } from './defer'
import { trace, flushTrace } from './trace'

function toBytes(data, length) {
  if (data == null) return new Uint8Array(0)
  if (typeof data === 'string') {
    const hex = data.replace(/[^0-9a-fA-F]/g, '')
    if (hex.length >= 2) {
      const even = hex.length % 2 === 0 ? hex : hex.slice(0, hex.length - 1)
      const out = new Uint8Array(even.length / 2)
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(even.substr(i * 2, 2), 16)
      }
      const n = length > 0 ? Math.min(length, out.length, 64) : Math.min(out.length, 64)
      return out.slice(0, n)
    }
    const raw = new Uint8Array(Math.min(data.length, 64))
    for (let i = 0; i < raw.length; i++) raw[i] = data.charCodeAt(i) & 0xff
    return raw
  }
  try {
    const view =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data)
    const n = length > 0 ? Math.min(length, view.length, 64) : Math.min(view.length, 64)
    return view.slice(0, n)
  } catch (e) {
    return new Uint8Array(0)
  }
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

const BLE_BASE = '00001000800000805F9B34FB'

function uuidTail(value) {
  if (typeof value === 'number') {
    return (value & 0xffff).toString(16).toUpperCase().padStart(4, '0')
  }
  const text = String(value || '')
    .replace(/-/g, '')
    .toUpperCase()
  if (!text) return ''
  // 0000FDE3-0000-1000-8000-00805F9B34FB → FDE3, not the base UUID tail 34FB
  if (text.length >= 32 && text.slice(text.length - 24) === BLE_BASE) {
    return text.slice(text.length - 28, text.length - 24)
  }
  if (text.length === 8 && text.slice(0, 4) === '0000') return text.slice(4, 8)
  if (text.length <= 4) return text.padStart(4, '0')
  return text.slice(-4)
}

/** 128-bit UUID, lowercase, using the Bluetooth base UUID. */
function ble128(id) {
  const t = String(id || '')
    .replace(/-/g, '')
    .toLowerCase()
  if (t.length === 4) return '0000' + t + '-0000-1000-8000-00805f9b34fb'
  if (t.length === 32) {
    return (
      t.slice(0, 8) +
      '-' +
      t.slice(8, 12) +
      '-' +
      t.slice(12, 16) +
      '-' +
      t.slice(16, 20) +
      '-' +
      t.slice(20)
    )
  }
  return String(id || '').toLowerCase()
}

function sameUuid(a, b) {
  const left = uuidTail(a)
  const right = uuidTail(b)
  if (!left || !right) return true
  return left === right
}


function macKey(mac) {
  return String(mac || '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '')
}

function reverseMac(mac) {
  const hex = macKey(mac)
  if (hex.length !== 12) return ''
  return hex.match(/.{2}/g).reverse().join(':')
}

function formatMac(hex12) {
  const hex = macKey(hex12)
  if (hex.length !== 12) return String(hex12 || '')
  return hex.match(/.{2}/g).join(':')
}

function macMatches(seen, expected) {
  const a = macKey(seen)
  const b = macKey(expected)
  if (a.length !== 12 || b.length !== 12) return false
  return a === b || a === macKey(reverseMac(expected))
}

/** 2EU+ often advertises the MAC as the device name (no ABBOTT prefix). */
function asMac(value) {
  const hex = macKey(value)
  if (hex.length !== 12) return ''
  return formatMac(hex)
}

function deviceName(device) {
  const raw = device && (device.dev_name || device.name)
  if (raw == null || raw === '') return ''
  if (typeof raw === 'string') return raw
  try {
    const view =
      raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : ArrayBuffer.isView(raw)
          ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
          : null
    if (!view) return String(raw)
    let out = ''
    for (let i = 0; i < view.length; i++) {
      const c = view[i]
      if (c === 0) break
      if (c >= 32 && c < 127) out += String.fromCharCode(c)
    }
    return out
  } catch (e) {
    return ''
  }
}

function asciiFromHex(hex) {
  const h = String(hex || '').replace(/[^0-9a-fA-F]/g, '')
  let out = ''
  for (let i = 0; i + 1 < h.length; i += 2) {
    const c = parseInt(h.substr(i, 2), 16)
    if (c >= 32 && c < 127) out += String.fromCharCode(c)
  }
  return out
}

function nameMatches(name, serial) {
  const n = String(name || '')
    .toUpperCase()
    .replace(/[\s_-]/g, '')
  const s = String(serial || '')
    .toUpperCase()
    .replace(/[\s_-]/g, '')
  if (!n) return false
  // Advertised name is ABBOTT followed by the serial.
  if (n.indexOf('ABBOTT') === 0 && s && n.indexOf(s) >= 0) return true
  if (s && (n === s || n.indexOf(s) >= 0)) return true
  return false
}

function containsMac(haystack, expected) {
  const h = macKey(haystack)
  const b = macKey(expected)
  if (b.length !== 12 || h.length < 12) return false
  return h.indexOf(b) >= 0 || h.indexOf(macKey(reverseMac(expected))) >= 0
}

function hasLibreService(device) {
  if (uuidTail(device && device.uuid) === 'FDE3') return true
  const list = device && device.service_uuid_array
  if (list) {
    for (let i = 0; i < list.length; i++) {
      if (uuidTail(list[i]) === 'FDE3') return true
    }
  }
  const sd = device && device.service_data_array
  if (sd) {
    for (let i = 0; i < sd.length; i++) {
      if (uuidTail(sd[i] && sd[i].uuid) === 'FDE3') return true
    }
  }
  return false
}

function advertisedMac(device, expected) {
  const addr = asMac(device && device.dev_addr)
  const fromName = asMac(deviceName(device))
  if (expected) {
    if (macMatches(addr, expected)) return addr
    if (macMatches(fromName, expected)) return fromName
  }
  return addr || fromName || ''
}

function advertHint(device) {
  const name = deviceName(device) || '-'
  const mac = advertisedMac(device) || '-'
  const short = name.length > 14 ? name.slice(0, 14) : name
  return short + ' ' + mac
}

function isSensorAdvertisement(device, sensor) {
  const name = deviceName(device)
  const vendor = asciiFromHex(device && device.vendor_data)
  const expected = sensor && sensor.bleAddress
  if (hasLibreService(device)) return true
  if (nameMatches(name, sensor && sensor.serial) || nameMatches(vendor, sensor && sensor.serial)) {
    return true
  }
  const live = getLiveMac()
  if (macMatches(device && device.dev_addr, expected) || macMatches(device && device.dev_addr, live)) {
    return true
  }
  if (macMatches(asMac(name), expected) || macMatches(asMac(name), live)) return true
  if (macMatches(asMac(vendor), expected) || macMatches(asMac(vendor), live)) return true
  if (containsMac(name, expected) || containsMac(vendor, expected)) return true
  if (containsMac(device && device.vendor_data, expected)) return true
  if (containsMac(device && device.dev_name, expected)) return true
  const sd = device && device.service_data_array
  if (sd) {
    for (let i = 0; i < sd.length; i++) {
      if (containsMac(sd[i] && sd[i].service_data, expected)) return true
    }
  }
  return false
}

function unlockBytes(sensor, count) {
  // Always derive from uid + patchInfo + the stored unlock code. The scan
  // JSON carries no precomputed payloads.
  return streamingUnlockPayload(
    hexToBytes(sensor.uidHex),
    hexToBytes(sensor.patchInfoHex),
    sensor.unlockCode,
    count
  )
}

export function ensureBlePermission() {
  return new Promise((resolve, reject) => {
    const perms = ['device:os.ble']
    const status = queryPermission({ permissions: perms })
    if (status && status[0] === 2) {
      resolve()
      return
    }
    requestPermission({
      permissions: perms,
      callback: (result) => {
        if (result && result[0] === 2) resolve()
        else reject(new Error('Bluetooth permission denied'))
      }
    })
  })
}

function radioIsUp(ble) {
  try {
    return !!(ble.get && ble.get.isConnected && ble.get.isConnected())
  } catch (e) {
    return false
  }
}

let heldClient = null

export function getHeldClient() {
  if (heldClient) return heldClient
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    const g = app && (app.globalData || (app._options && app._options.globalData))
    if (g && g.sensorClient) heldClient = g.sensorClient
  } catch (e) {}
  return heldClient
}

export function holdClient(client) {
  heldClient = client
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    const g = app && (app.globalData || (app._options && app._options.globalData))
    if (g) g.sensorClient = client
  } catch (e) {}
}

export function clearHeldClient() {
  heldClient = null
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    const g = app && (app.globalData || (app._options && app._options.globalData))
    if (g) g.sensorClient = null
  } catch (e) {}
}

export function createSensorClient(initialHooks) {
  let hooks = initialHooks || {}
  let ble = new BLEMaster()
  BLEMaster.SetDebugLevel(1)
  let connecting = false
  let linkUp = false
  let unlockSent = false
  let loginWritten = false
  let notifyReady = false
  let gotGlucose = false
  let hadLive = false
  let dropping = false
  let sessionWanted = false
  let preferScan = false
  let lastLiveMac = getLiveMac()
  let liveMacFails = 0
  let sameProcessReconnect = false
  let silentLogins = 0
  let outageSilents = 0
  let quietReconnects = 0
  let noIdFails = 0
  let burstTries = 0
  let burstTimer = null
  let bleReboots = 0
  let scanEmptyPasses = 0
  let linkLostAt = 0
  let kpiScanAt = 0
  let kpiAdvertAt = 0
  let kpiConnectAt = 0
  let kpiAclAt = 0
  let prepareFails = 0
  let buildFalse = false
  let buildFalseStreak = 0
  let preferLongProfile = false
  let needsNfc = false
  let connectTime = 0
  let handshakeAt = 0
  let retries = 0
  let retryStartedAt = 0
  let macIndex = 0
  let macsToTry = []
  let busyTries = 0
  let sessionUnlockCount = 0
  let gattWrite = 'F001'
  let gattNotify = 'F002'
  let lastCccd = '?'
  let scanLive = null
  let scanStartedAt = 0
  let retryTimer = null
  let retryDueAt = 0
  let lastWdTickAt = 0
  let unlockAt = 0
  let silentTimer = null
  let scanTick = null
  let scanPulse = null
  let scanDeadline = null
  let listenTimer = null
  let gattTimer = null
  let connectDelay = null
  let connectWait = null
  let connectTick = null
  let loginTimer = null
  let streamTick = null
  let unlockAttempt = 0
  let unlockRewritten = false
  let listenTries = 0
  let connectGen = 0
  let loginQuietUntil = 0
  let lastBle = 'no BLE yet'
  let lastPacketAt = 0
  let wdGraceUntil = 0
  let advertPhaseMs = -1
  let phaseLoaded = false
  let slotMisses = 0
  let slotLimited = false
  let scanWaiting = false
  let scanWaitUntil = 0
  let scanWaitTimer = null
  let startSlotScan = null
  let scanRadioAt = 0
  let scanCount = 0
  let scanSeconds = 0
  let scanStatKey = ''
  let lastSoftLostAt = 0
  let prepareOk = false
  let timeSensor = null
  let wdMinuteCb = null
  let notifyBuf = new Uint8Array(0)
  let pack1 = false
  let pack2 = false
  let lastFragAt = 0
  const frame = new Uint8Array(46)
  const PACKET = 46
  // Wait up to 3s for the rest of a split frame.
  const FRAGMENT_WAIT_MS = 3000
  const FAST_RETRY_MS = 2000
  const FAST_RETRY_WINDOW_MS = 120000
  const SLOW_RETRY_MS = 15000
  // Scan up to 390s, pause 60s, then scan again.
  const SCAN_TIMEOUT_MS = 390000
  const SCAN_PAUSE_MS = 60000
  const SCAN_REFRESH_MS = 40000
  const SLOT_LEAD_MS = 4000
  const SLOT_AFTER_MS = 15000
  const SLOT_SOON_MS = 12000
  const SLOT_MISS_MAX = 3
  const SLOT_RECENT_MS = 15 * 60 * 1000
  const SOFT_LOST_WINDOW_MS = 10 * 60 * 1000
  // Libre 2 advertises fleetingly every ~120s while disconnected. Stay on
  // the radio for 15 min after a loss so we do not miss a burst.
  const HOT_SCAN_MS = 15 * 60 * 1000
  // 1.3.14 connected in well under 8s. A 40s wait left a pending mstConnect
  // that blocked the next attempt.
  const CONNECT_TIMEOUT_MS = 8000
  const CONNECT_RETRY_MS = 2000
  const LOGIN_QUIET_MS = 12000
  const LIVE_TICK_MS = 30000
  const QUIET_NOTIFY_MS = 30000
  const QUICK_SILENT_MS = 20000
  // Live frames arrive ~every 60s. 75s is enough slack to reconnect faster
  // than the 90s post-login window (first F002 can take 60–90s).
  const LIVE_QUIET_MS = 75000
  // Treat the stream as stale after 330s (about 11 missed minutes).
  const LIVE_STALE_MS = 330000
  // Do not reconnect an ACL younger than 60s.
  const CONNECT_HOLD_MS = 60000
  const REPOKE_NOTIFY_MS = 15000
  // Stay on the ACL. First frame is ~60s. Only hint after 150s.
  const FIRST_PACKET_HINT_MS = 150000
  const PREPARE_GIVE_UP_MS = 20000
  // After this many consecutive prepare timeouts the watch stack is stuck
  // (only a reboot clears it). Slow the retry so the radio and wake lock rest.
  const PREPARE_STUCK_N = 5
  const PREPARE_STUCK_RETRY_MS = 180000
  const LIVE_MAC_FAILS_MAX = 2
  // Notify is up and the unlock is written, but no frame arrives. After an
  // NFC re-scan the sensor ignores the old payload; stop burning counts.
  const UNLOCK_REJECT_N = 3
  const UNLOCK_REJECT_RETRY_MS = 180000

  function rememberMac(mac) {
    const n = formatMac(mac)
    if (!n || macKey(n).length !== 12) return
    lastLiveMac = n
  }

  function sessionHadLive() {
    if (hadLive) return true
    const last = loadLastReading()
    if (last && last.at && Date.now() - last.at < LIVE_STALE_MS) return true
    const sensor = getSensor()
    const first = sensor.firstUnlockCount || 1
    return getUnlockCount() > first
  }

  function log(message) {
    try {
      trace(message)
    } catch (e) {}
    if (hooks.onStatus) hooks.onStatus(message)
  }

  function status(message) {
    if (hooks.onStatus) hooks.onStatus(message)
  }

  function nativeReset(why, opts) {
    let pids = 0
    if (opts && opts.freeAll) {
      try {
        pids = getBlePids().length
      } catch (e) {}
    }
    try {
      if (ble.resetNative) ble.resetNative(opts)
    } catch (e) {}
    try {
      trace(
        'resetNative' +
          (why ? ' ' + why : '') +
          (opts && opts.freeAll ? ' pids=' + pids : '')
      )
    } catch (e) {}
  }

  function clearRetry() {
    cancelLater(retryTimer)
    retryTimer = null
    retryDueAt = 0
    cancelLater(silentTimer)
    silentTimer = null
    cancelLater(burstTimer)
    burstTimer = null
    cancelEvery(scanTick)
    scanTick = null
    scanPulse = null
    cancelLater(scanDeadline)
    scanDeadline = null
    cancelLater(listenTimer)
    listenTimer = null
    cancelLater(gattTimer)
    gattTimer = null
    cancelLater(connectDelay)
    connectDelay = null
    cancelLater(connectWait)
    connectWait = null
    cancelEvery(connectTick)
    connectTick = null
    cancelLater(loginTimer)
    loginTimer = null
    cancelEvery(streamTick)
    streamTick = null
  }

  function resetNotify() {
    notifyBuf = new Uint8Array(0)
    pack1 = false
    pack2 = false
    lastFragAt = 0
  }

  function closeBle() {
    dropping = true
    if (hadLive || sessionHadLive()) {
      nativeReset('closeBle')
      dropLink()
      return
    }
    try {
      ble.stopScan()
    } catch (e) {}
    try {
      ble.quit()
    } catch (e) {}
  }

  function canSelfRecover() {
    return hasStoredScan()
  }

  function rebootBle(immediate, delayMs) {
    bleReboots++
    connecting = false
    linkUp = false
    unlockSent = false
    loginWritten = false
    prepareOk = false
    preferScan = true
    sameProcessReconnect = false
    silentLogins = 0
    quietReconnects = 0
    scanEmptyPasses = 0
    connectGen++
    loginQuietUntil = 0
    lastBle = 'no BLE yet'
    resetNotify()
    clearRetry()
    dropLink()
    nativeReset('rebootBle')
    ble = new BLEMaster()
    BLEMaster.SetDebugLevel(1)
    log('Rebuilding BLE…')
    try {
      flushTrace()
    } catch (e) {}
    const start = () => {
      retryDueAt = 0
      // A rescanApplied() reconnect may already be up. Do not tear it down.
      if (!sessionWanted || dropping || needsNfc || linkUp) return
      dropping = false
      beginConnect()
    }
    if (delayMs > 0) {
      // handshakeAt must stay 0: the minute watchdog's handshake branch
      // would otherwise beginConnect 20s into the backoff.
      handshakeAt = 0
      retryDueAt = Date.now() + delayMs
      if (hooks.onKeepAwake) hooks.onKeepAwake(false)
      status('Link stuck, retry in 3 min')
      later(delayMs, start)
      return
    }
    if (immediate) {
      start()
      return
    }
    retryDueAt = Date.now() + 700
    later(700, start)
  }

  function reconnectQuietStream(reason) {
    if (!reason && (hadLive || canSelfRecover())) {
      if (!linkLostAt) linkLostAt = Date.now()
      try {
        trace('quiet live reboot')
      } catch (e) {}
      if (hooks.onDisconnected) hooks.onDisconnected()
      rebootBle(true)
      return
    }
    quietReconnects++
    if (!linkLostAt) linkLostAt = Date.now()
    // MAC-first only on the first quiet while the radio still looks up
    // (fake drop). A real drop means the sensor only advertises.
    if (quietReconnects === 1 && radioIsUp(ble)) {
      preferScan = false
      sameProcessReconnect = true
    } else {
      preferScan = true
      sameProcessReconnect = false
      nativeReset('quiet')
    }
    try {
      trace(
        'quiet ' +
          (reason || 'Stream quiet') +
          ' n=' +
          quietReconnects +
          (preferScan ? ' scan' : ' mac')
      )
    } catch (e) {}
    dropLink()
    scheduleReconnect(reason || 'Stream quiet')
  }

  /** Drop the GATT link without quit()/mstOffAllCb so the next mstConnect still works. */
  function dropLink() {
    try {
      if (ble.destroyProfile) ble.destroyProfile()
    } catch (e) {}
    try {
      ble.stopScan()
    } catch (e) {}
    try {
      if (ble.disconnect) ble.disconnect()
    } catch (e) {}
  }

  function giveUpPrepare() {
    try {
      trace('giveUpPrepare fails=' + prepareFails)
    } catch (e) {}
    cancelEvery(streamTick)
    streamTick = null
    cancelLater(gattTimer)
    gattTimer = null
    if (ble.destroyProfile) {
      try {
        ble.destroyProfile()
      } catch (e) {}
    }
    prepareFails++
    if (buildFalse && !prepareOk) {
      buildFalseStreak++
      if (buildFalseStreak >= 2) {
        preferLongProfile = !preferLongProfile
        try {
          trace(
            'build-false freeAll long=' +
              (preferLongProfile ? 1 : 0) +
              ' n=' +
              buildFalseStreak
          )
        } catch (e) {}
        nativeReset('build-false', { freeAll: true })
      }
    } else {
      buildFalseStreak = 0
    }
    if (sessionHadLive() || canSelfRecover()) {
      if (prepareFails >= PREPARE_STUCK_N) {
        let runs = 0
        try {
          runs = bumpBleStuckRuns()
        } catch (e) {}
        try {
          trace('prepare-stuck n=' + prepareFails + ' runs=' + runs)
        } catch (e) {}
        if (runs >= 3) {
          try {
            trace('ble-stuck runs=' + runs)
          } catch (e) {}
          if (hooks.onBleStuck) hooks.onBleStuck(runs)
          nativeReset('ble-stuck', { freeAll: true })
          rebootBle(false, PREPARE_STUCK_RETRY_MS)
          status('Watch Bluetooth stuck\nReboot the watch')
          return
        }
        if (runs === 2) {
          try {
            if (ble.quit) ble.quit()
          } catch (e) {}
        }
        nativeReset('prepare-stuck', { freeAll: true })
        rebootBle(false, PREPARE_STUCK_RETRY_MS)
        return
      }
      rebootBle(true)
      return
    }
    waitForNfc()
  }

  // A page relaunch destroys the page that armed the 8s connectWait timer
  // (and loses the mstConnect callback), while the client itself survives
  // in globalData with connecting=true and scanPulse=null. No other watchdog
  // branch runs while connecting, so this one turns a stale mstConnect into
  // the normal "timed out" retry path.
  function rescueStaleConnect(now) {
    if (!sessionWanted || dropping || needsNfc) return false
    if (!connecting || linkUp || scanPulse || retryDueAt || !kpiConnectAt) return false
    if (now - kpiConnectAt <= CONNECT_TIMEOUT_MS + 5000) return false
    try {
      trace('wd connect-late ' + Math.round((now - kpiConnectAt) / 1000) + 's')
    } catch (e) {}
    cancelLater(connectWait)
    connectWait = null
    cancelEvery(connectTick)
    connectTick = null
    kpiConnectAt = 0
    onConnectFailed(getSensor(), { connected: false, status: 'timed out' })
    return true
  }

  function rearmWatchdog() {
    if (timeSensor) {
      try {
        if (timeSensor.offPerMinute) {
          timeSensor.offPerMinute(wdMinuteCb)
          timeSensor.offPerMinute()
        }
      } catch (e) {}
      timeSensor = null
      wdMinuteCb = null
    }
    wdGraceUntil = Date.now() + 120000
    ensureWatchdog()
    // The page re-adopts a held client here; do not wait a minute if its
    // connect is already dead.
    rescueStaleConnect(Date.now())
  }

  function ensureWatchdog() {
    if (timeSensor) return
    try {
      const sensor = new Time()
      const cb = () => {
        if (sensor !== timeSensor) return
        if (hooks.onMinute) hooks.onMinute()
        if (!sessionWanted || dropping || needsNfc) return
        const now = Date.now()
        if (now - lastWdTickAt < 5000) return
        lastWdTickAt = now
        if (!connecting && !linkUp && retryDueAt && now >= retryDueAt + 1000) {
          const lateS = Math.round((now - retryDueAt) / 1000)
          try {
            if (lateS > 5) trace('wd timer-late ' + lateS + 's')
            else trace('wd overdue-retry')
          } catch (e) {}
          cancelLater(retryTimer)
          retryTimer = null
          retryDueAt = 0
          handshakeAt = 0
          beginConnect()
          return
        }
        if (rescueStaleConnect(now)) return
        // setInterval freezes with the screen off. The scan pulse is wall-clock,
        // so one call here refreshes or times out a scan the 5s tick never reached.
        if (
          connecting &&
          scanLive &&
          scanPulse &&
          scanStartedAt &&
          now - scanStartedAt > SCAN_REFRESH_MS
        ) {
          try {
            trace('wd scan-pulse ' + Math.round((now - scanStartedAt) / 1000) + 's')
          } catch (e) {}
          scanPulse()
          return
        }
        if (!connecting && gotGlucose && lastPacketAt && (linkUp || !retryDueAt)) {
          const quiet = now - lastPacketAt
          const limit = now < wdGraceUntil ? LIVE_QUIET_MS + 60000 : LIVE_QUIET_MS
          if (quiet >= limit) {
            try {
              trace('wd live-quiet ' + Math.round(quiet / 1000) + 's')
            } catch (e) {}
            reconnectQuietStream()
            return
          }
        }
        if (!connecting && !linkUp && handshakeAt && now - handshakeAt > PREPARE_GIVE_UP_MS) {
          if (scanLive) {
            if (scanStartedAt && now - scanStartedAt > SCAN_TIMEOUT_MS + 60000) {
              try {
                trace('wd scan-stale')
              } catch (e) {}
              connecting = false
              dropLink()
              beginConnect()
            }
            return
          }
          try {
            trace('wd handshake')
          } catch (e) {}
          connecting = false
          dropLink()
          beginConnect()
          return
        }
        if (linkUp && !prepareOk && connectTime && now - connectTime > PREPARE_GIVE_UP_MS) {
          try {
            trace('wd prepare')
          } catch (e) {}
          giveUpPrepare()
          return
        }
        if (
          linkUp &&
          prepareOk &&
          !gotGlucose &&
          !notifyReady &&
          !unlockSent &&
          connectTime &&
          now - connectTime > 5000 &&
          (hadLive || canSelfRecover())
        ) {
          try {
            trace('no-nfy 5s reboot')
          } catch (e) {}
          rebootBle(true)
          return
        }
        if (linkUp && prepareOk && !gotGlucose && unlockAt && now - unlockAt > QUICK_SILENT_MS) {
          try {
            trace('wd quick-silent')
          } catch (e) {}
          onQuickSilent(getSensor())
          return
        }
        if (linkUp && prepareOk && !gotGlucose && connectTime && now - connectTime > QUIET_NOTIFY_MS) {
          try {
            trace('wd no-f002')
          } catch (e) {}
          reconnectQuietStream('No F002')
        }
      }
      timeSensor = sensor
      wdMinuteCb = cb
      sensor.onPerMinute(cb)
    } catch (e) {}
  }

  function drop(message, keepWanted) {
    sessionWanted = !!keepWanted
    if (!keepWanted) setSessionWanted(false)
    connecting = false
    linkUp = false
    unlockSent = false
    loginWritten = false
    unlockAttempt = 0
    unlockRewritten = false
    listenTries = 0
    busyTries = 0
    sessionUnlockCount = 0
    connectGen++
    loginQuietUntil = 0
    lastBle = 'no BLE yet'
    lastPacketAt = 0
    prepareOk = false
    hadLive = false
    preferScan = false
    sameProcessReconnect = false
    connectTime = 0
    resetNotify()
    clearRetry()
    log(message)
    dropLink()
    if (hooks.onDisconnected) hooks.onDisconnected()
  }

  function waitForNfc() {
    needsNfc = true
    connecting = false
    linkUp = false
    dropping = false
    clearRetry()
    haltScan()
    dropLink()
    log('NFC the sensor, then Sync')
    try {
      flushTrace()
    } catch (e) {}
  }

  function beginConnect() {
    if (!sessionWanted || connecting || needsNfc) return
    connecting = true
    retryDueAt = 0
    unlockAt = 0
    burstTries = 0
    handshakeAt = Date.now()
    if (hooks.onKeepAwake) hooks.onKeepAwake(true)
    linkUp = false
    unlockSent = false
    loginWritten = false
    unlockAttempt = 0
    unlockRewritten = false
    listenTries = 0
    busyTries = 0
    sessionUnlockCount = 0
    connectGen++
    loginQuietUntil = 0
    lastBle = 'no BLE yet'
    prepareOk = false
    gotGlucose = false
    macIndex = 0
    macsToTry = []
    scanLive = null
    resetNotify()
    kpiConnectAt = 0
    kpiAclAt = 0
    const mac = lastLiveMac || getLiveMac()
    const useSavedMac =
      sameProcessReconnect && !preferScan && mac && liveMacFails < LIVE_MAC_FAILS_MAX
    preferScan = false
    if (useSavedMac) {
      kpiScanAt = 0
      kpiAdvertAt = 0
      macsToTry = [mac]
      macIndex = 0
      connectMac(getSensor(), mac)
      return
    }
    sameProcessReconnect = false
    scanThenConnect(getSensor())
  }

  function scheduleReconnect(reason, delayMs) {
    if (!sessionWanted || dropping || needsNfc) return
    let jumpNote = ''
    if (unlockSent && !gotGlucose) {
      silentLogins++
      outageSilents++
      const last = loadLastReading()
      const recent = !!(last && last.at && Date.now() - last.at < 15 * 60 * 1000)
      if (!canSelfRecover() && !hadLive && !recent && silentLogins >= 5) {
        waitForNfc()
        return
      }
      // Drop and scan. Rebuild every 2nd silent login (1.4.87 cadence)
      // without the 60s radio-quiet pause.
      preferScan = true
      if (!notifyReady && (hadLive || canSelfRecover())) {
        try {
          trace('silent-login no-nfy reboot')
        } catch (e) {}
        rebootBle(true)
        return
      }
      if (notifyReady && outageSilents >= UNLOCK_REJECT_N && (hadLive || canSelfRecover())) {
        try {
          trace('unlock-rejected n=' + outageSilents)
        } catch (e) {}
        if (hooks.onUnlockRejected) hooks.onUnlockRejected(outageSilents)
        status('Sensor ignores unlock\nRe-scan, then Sync')
        rebootBle(false, UNLOCK_REJECT_RETRY_MS)
        return
      }
      if (silentLogins >= 2 && (hadLive || canSelfRecover())) {
        try {
          trace('silent-login n=' + silentLogins + ' reboot')
        } catch (e) {}
        rebootBle(true)
        return
      }
      try {
        trace('silent-login n=' + silentLogins)
      } catch (e) {}
    }
    retries++
    connecting = false
    linkUp = false
    unlockSent = false
    loginWritten = false
    unlockAttempt = 0
    unlockRewritten = false
    listenTries = 0
    busyTries = 0
    sessionUnlockCount = 0
    connectGen++
    loginQuietUntil = 0
    lastBle = 'no BLE yet'
    prepareOk = false
    resetNotify()
    const elapsed = Date.now() - retryStartedAt
    const delay =
      delayMs > 0
        ? delayMs
        : elapsed > FAST_RETRY_WINDOW_MS
          ? SLOW_RETRY_MS
          : FAST_RETRY_MS
    const waitSec = Math.round(delay / 1000)
    log((jumpNote || reason || 'Link lost') + '. Retry in ' + waitSec + 's')
    if (delay <= FAST_RETRY_MS && hooks.onKeepAwake) hooks.onKeepAwake(true)
    if (hadLive && !linkLostAt) linkLostAt = Date.now()
    if (hadLive && hooks.onDisconnected) hooks.onDisconnected()
    clearRetry()
    // After Live never quit() or mstOffAllCb — that latches Zepp so the
    // next connect never settles. Close GATT only, then the known MAC.
    if (!hadLive) {
      try {
        if (ble.abortConnect) ble.abortConnect()
      } catch (e) {}
    }
    dropLink()
    dropping = false
    sameProcessReconnect = !!hadLive
    // Keep the handshake watchdog from beginConnect 20s into this backoff.
    handshakeAt = 0
    retryDueAt = Date.now() + delay
    retryTimer = later(delay, () => {
      retryTimer = null
      retryDueAt = 0
      dropping = false
      beginConnect()
    })
  }

  function decodePacket(sensor, encrypted) {
    let plain
    try {
      plain = decryptBLE(hexToBytes(sensor.uidHex), encrypted)
    } catch (e) {
      log('Decrypt failed')
      return
    }
    if (!bleCrcOk(plain)) {
      log('Bad BLE checksum')
      return
    }
    const now = Date.now()
    const firstAfterGap = !hadLive || !!linkLostAt
    const lostAt = linkLostAt
    const reboots = bleReboots
    const silents = outageSilents
    gotGlucose = true
    hadLive = true
    unlockAt = 0
    cancelLater(silentTimer)
    silentTimer = null
    linkLostAt = 0
    silentLogins = 0
    outageSilents = 0
    quietReconnects = 0
    noIdFails = 0
    burstTries = 0
    bleReboots = 0
    scanEmptyPasses = 0
    prepareFails = 0
    liveMacFails = 0
    if (lastLiveMac) setLiveMac(lastLiveMac)
    if (hooks.onKeepAwake) hooks.onKeepAwake(false)
    lastPacketAt = now
    loginQuietUntil = now + LOGIN_QUIET_MS
    retries = 0
    retryStartedAt = now
    if (firstAfterGap) {
      const lostS = lostAt ? Math.round((now - lostAt) / 1000) : 0
      const scanEnd = kpiAdvertAt || kpiConnectAt || now
      const scanS = kpiScanAt ? Math.round((scanEnd - kpiScanAt) / 1000) : 0
      const connS =
        kpiConnectAt && kpiAclAt ? Math.round((kpiAclAt - kpiConnectAt) / 1000) : 0
      const loginS = kpiAclAt ? Math.round((now - kpiAclAt) / 1000) : 0
      const totalS = lostAt
        ? lostS
        : kpiScanAt
          ? Math.round((now - kpiScanAt) / 1000)
          : 0
      try {
        trace(
          'recovered lost=' +
            lostS +
            's scan=' +
            scanS +
            's connect=' +
            connS +
            's login=' +
            loginS +
            's total=' +
            totalS +
            's reboots=' +
            reboots +
            ' silents=' +
            silents
        )
        flushTrace()
      } catch (e) {}
    }
    const cal = getSensor().calibration || sensor.calibration
    const sample = parseCurrent(plain, cal)
    sample.rawMmol = sample.mmol
    try {
      sample.trend = parseTrend(plain, cal)
    } catch (e) {
      sample.trend = []
    }
    if (firstAfterGap) {
      try {
        if (cal) {
          trace('cal i2=' + cal.i2 + ' i3=' + cal.i3 + ' i4=' + cal.i4 + ' i6=' + cal.i6)
        } else {
          trace('cal none (raw/10)')
        }
      } catch (e) {}
    }
    if (hooks.onGlucose) hooks.onGlucose(sample)
    startLiveTick(sensor)
  }

  function liveAgeText() {
    if (!lastPacketAt) return 'Live'
    const sec = Math.floor((Date.now() - lastPacketAt) / 1000)
    if (sec < 20) return 'Live'
    if (sec < 60) return 'Live · ' + sec + 's ago'
    return 'Live · ' + Math.floor(sec / 60) + 'm ago'
  }

  function startLiveTick(sensor) {
    cancelEvery(streamTick)
    streamTick = every(LIVE_TICK_MS, () => {
      if (!sessionWanted || dropping || !linkUp) {
        cancelEvery(streamTick)
        streamTick = null
        return
      }
      if (!gotGlucose) return
      status(liveAgeText())
      const quiet = lastPacketAt ? Date.now() - lastPacketAt : 0
      if (quiet >= 60000 && quiet < LIVE_QUIET_MS) {
        try {
          ble.on.charaNotification((uuid, data, length) => {
            onNotify(sensor, uuid, data, length)
          })
        } catch (e) {}
        try {
          ble.write.enableCharaNotifications(sensor.notifyChar, true)
        } catch (e) {}
        return
      }
      if (quiet >= LIVE_QUIET_MS) {
        reconnectQuietStream()
      }
    })
  }

  function handleNotify(sensor, bytes) {
    if (!bytes || !bytes.length) return
    const now = Date.now()
    if (
      lastFragAt &&
      now - lastFragAt > FRAGMENT_WAIT_MS &&
      (pack1 || pack2 || notifyBuf.length > 0)
    ) {
      resetNotify()
    }
    lastFragAt = now
    const n = bytes.length
    if (n === 46) {
      pack1 = false
      pack2 = false
      decodePacket(sensor, bytes)
      return
    }
    // Libre 2 gen1 sends the 46-byte frame as 20 + 18 + 8.
    if (n === 20) {
      frame.set(bytes, 0)
      pack1 = true
      pack2 = false
      status('Packet 20/46')
      return
    }
    if (n === 18 && pack1) {
      frame.set(bytes, 20)
      pack2 = true
      status('Packet 38/46')
      return
    }
    if (n === 8 && pack1 && pack2) {
      frame.set(bytes, 38)
      pack1 = false
      pack2 = false
      decodePacket(sensor, frame)
      return
    }
    notifyBuf = concatBytes(notifyBuf, bytes)
    if (notifyBuf.length > PACKET * 2) {
      notifyBuf = bytes.length <= PACKET ? bytes : bytes.slice(bytes.length - PACKET)
    }
    while (notifyBuf.length >= PACKET) {
      const packet = notifyBuf.slice(0, PACKET)
      notifyBuf = notifyBuf.slice(PACKET)
      decodePacket(sensor, packet)
    }
    if (notifyBuf.length > 0) status('Packet ' + notifyBuf.length + '/' + PACKET)
  }

  let lastNotifyAt = 0
  let lastNotifyLen = -1
  function onNotify(sensor, uuid, data, length) {
    const tail = uuidTail(uuid)
    const bytes = toBytes(data, length)
    const now = Date.now()
    if (bytes.length === lastNotifyLen && now - lastNotifyAt < 40) return
    lastNotifyLen = bytes.length
    lastNotifyAt = now
    lastBle = 'BLE ' + (tail || '?') + ' n=' + bytes.length
    status(lastBle)
    if (tail === 'F001') return
    if (!bytes.length) return
    handleNotify(sensor, bytes)
  }

  function markStreaming(sensor) {
    cancelLater(loginTimer)
    loginTimer = null
    loginQuietUntil = Date.now() + LOGIN_QUIET_MS
    const count = sessionUnlockCount || getUnlockCount()
    log('Streaming, CCCD ' + lastCccd + ' · count ' + count)
    cancelEvery(streamTick)
    const startedAt = Date.now()
    let lastRepoke = Date.now()
    streamTick = every(2000, () => {
      if (!sessionWanted || dropping || !linkUp || gotGlucose) {
        cancelEvery(streamTick)
        streamTick = null
        return
      }
      loginQuietUntil = Date.now() + LOGIN_QUIET_MS
      const elapsed = Date.now() - startedAt
      const sec = Math.floor(elapsed / 1000)
      const clock = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0')
      const waiting =
        lastBle === 'no BLE yet'
          ? elapsed >= FIRST_PACKET_HINT_MS
            ? 'no F002 yet'
            : 'waiting'
          : lastBle
      status(
        'Streaming ' +
          clock +
          ', ' +
          waiting +
          ' · CCCD ' +
          lastCccd +
          (notifyReady ? ' · nfy' : '') +
          ' · count ' +
          count
      )
      // First Libre 2 frame after a fresh login is often ~60–90s. Never tear
      // a CCCD-true login down here — the 90s watchdog (reconnectQuietStream)
      // is the only pre-first-frame teardown. Keep poking CCCD instead.
      if (sensor && lastBle === 'no BLE yet' && !notifyReady && Date.now() - lastRepoke >= REPOKE_NOTIFY_MS) {
        lastRepoke = Date.now()
        lastCccd = writeCccd(sensor)
      }
    })
  }

  function writeCccd(sensor) {
    if (!ble.write.notifyNow) return '?'
    const ids = [gattNotify]
    const short = String((sensor && sensor.notifyChar) || 'F002').toUpperCase()
    const long = ble128((sensor && sensor.notifyChar) || 'F002')
    if (ids.indexOf(short) < 0) ids.push(short)
    if (ids.indexOf(long) < 0) ids.push(long)
    let last = '?'
    for (let i = 0; i < ids.length; i++) {
      try {
        last = ble.write.notifyNow(ids[i], true)
        if (last === 0 || last === true) return last
      } catch (e) {
        last = 'err'
      }
    }
    return last
  }

  function enableNotify(sensor) {
    if (loginWritten) return
    loginWritten = true
    loginQuietUntil = Date.now() + LOGIN_QUIET_MS
    lastCccd = writeCccd(sensor)
    log('CCCD ' + lastCccd)
    markStreaming(sensor)
    later(2000, () => {
      if (!sessionWanted || dropping || !linkUp || gotGlucose || notifyReady) return
      if (lastBle !== 'no BLE yet') return
      lastCccd = writeCccd(sensor)
      log('CCCD retry ' + lastCccd)
    })
    later(3000, () => {
      if (!sessionWanted || dropping || !linkUp || gotGlucose || notifyReady || unlockSent) return
      if (!(hadLive || canSelfRecover())) return
      try {
        trace('no-nfy 5s reboot')
      } catch (e) {}
      rebootBle(true)
    })
  }

  function onQuickSilent(sensor) {
    // A sensor that accepts the unlock answers in ~1s. Rewriting during an
    // outage only burns the next count.
    if (outageSilents >= 1) {
      reconnectQuietStream('No F002')
      return
    }
    if (linkUp && !unlockRewritten && sensor && notifyReady) {
      unlockRewritten = true
      try {
        trace('silent unlock-rewrite')
      } catch (e) {}
      unlockSent = false
      sessionUnlockCount = 0
      lastCccd = writeCccd(sensor)
      writeUnlock(sensor)
      return
    }
    reconnectQuietStream('No F002')
  }

  function writeUnlock(sensor) {
    if (unlockSent) return
    if (!sessionUnlockCount) sessionUnlockCount = getUnlockCount()
    unlockSent = true
    unlockAttempt++
    const live = getSensor()
    const used = {
      uidHex: live.uidHex || sensor.uidHex,
      patchInfoHex: live.patchInfoHex || sensor.patchInfoHex,
      unlockCode: live.unlockCode != null ? live.unlockCode : sensor.unlockCode
    }
    const payload = bytesToHex(unlockBytes(used, sessionUnlockCount))
    log('Unlock count ' + sessionUnlockCount + ' · code ' + used.unlockCode)
    try {
      trace('unlock write n=' + sessionUnlockCount)
    } catch (e) {}
    try {
      ble.write.characteristic(gattWrite, payload, false)
    } catch (e) {}
    bumpUnlockCount()
    unlockAt = Date.now()
    cancelLater(silentTimer)
    silentTimer = later(QUICK_SILENT_MS, () => {
      silentTimer = null
      if (!sessionWanted || dropping || !linkUp || gotGlucose || !unlockSent) return
      try {
        trace('quick silent')
      } catch (e) {}
      onQuickSilent(sensor)
    })
  }

  function communicate(sensor) {
    // Enable F002 notifications first, then write F001 after notify is confirmed.
    ble.on.charaNotification((uuid, data, length) => {
      onNotify(sensor, uuid, data, length)
    })
    ble.on.charaValueArrived((uuid, data, length) => {
      onNotify(sensor, uuid, data, length)
    })
    ble.on.charaWriteComplete((uuid, status) => {
      if (!sameUuid(uuid, sensor.writeChar)) return
      if (status != 0 && status != null) log('Unlock write failed (' + status + ')')
    })

    enableNotify(sensor)
    if (notifyReady) writeUnlock(sensor)
    cancelLater(loginTimer)
    loginTimer = later(700, () => {
      loginTimer = null
      if (!sessionWanted || dropping || !linkUp || gotGlucose || unlockSent) return
      log('CCCD silent, writing unlock')
      writeUnlock(sensor)
    })
  }

  function listen(sensor) {
    if (hooks.onKeepAwake) hooks.onKeepAwake(true)
    buildFalse = false
    unlockSent = false
    loginWritten = false
    notifyReady = false
    lastCccd = '?'
    unlockAttempt = 0
    resetNotify()
    if (ble.destroyProfile) {
      try {
        ble.destroyProfile()
      } catch (e) {}
    }
    if (ble.attachNotify) {
      ble.attachNotify((uuid, data, length) => {
        onNotify(sensor, uuid, data, length)
      })
    }
    if (ble.attachDescComplete) {
      ble.attachDescComplete((chara, desc, status) => {
        const ok = status == 0 || status == null
        if (ok) notifyReady = true
        log((ok ? 'Notify ready' : 'Notify setup ' + status) + ' ' + (uuidTail(chara) || '?') + '/' + (uuidTail(desc) || '?'))
        if (ok) writeUnlock(sensor)
      })
    }
    // 1.3.14: one short FDE3/F001/F002/2902 profile. Flipping long/short
    // every 8s stacked firmware profiles until a watch reboot.
    const shortServices = {
      [String(sensor.service || 'FDE3').toUpperCase()]: {
        [String(sensor.writeChar || 'F001').toUpperCase()]: [],
        [String(sensor.notifyChar || 'F002').toUpperCase()]: ['2902']
      }
    }
    const longServices = {
      [ble128(sensor.service)]: {
        [ble128(sensor.writeChar)]: [],
        [ble128(sensor.notifyChar)]: ['2902']
      }
    }
    const shortProfile = ble.generateProfileObject(shortServices)
    const longProfile = ble.generateProfileObject(longServices)
    const profile = preferLongProfile
      ? longProfile && longProfile.success !== false
        ? longProfile
        : shortProfile
      : shortProfile && shortProfile.success !== false
        ? shortProfile
        : longProfile
    if (preferLongProfile) {
      try {
        trace('profile long')
      } catch (e) {}
    }
    if (!profile || profile.success === false) {
      const err =
        (profile && profile.error) ||
        (shortProfile && shortProfile.error) ||
        (longProfile && longProfile.error) ||
        ''
      preferScan = true
      if (String(err).indexOf('bad connect id') >= 0 || String(err).indexOf('private field') >= 0) {
        dropLink()
        scheduleReconnect('Bad connect id', CONNECT_RETRY_MS)
        return
      }
      scheduleReconnect(err ? 'Profile failed\n' + err : 'Profile failed', CONNECT_RETRY_MS)
      return
    }
    if (profile.pair !== undefined) profile.pair = false
    const useShort = profile === shortProfile
    gattWrite = useShort
      ? String(sensor.writeChar || 'F001').toUpperCase()
      : ble128(sensor.writeChar)
    gattNotify = useShort
      ? String(sensor.notifyChar || 'F002').toUpperCase()
      : ble128(sensor.notifyChar)
    loginQuietUntil = Date.now() + 120000
    const gen = connectGen
    const startedAt = Date.now()
    let settled = false
    let buildTraced = false
    prepareOk = false
    log('GATT login… id ' + profile.id)
    ble.startListener(profile, (response) => {
      if (settled || gen !== connectGen) return
      if (!response.success) {
        if (response.code === 'PREPARE_SEEN') {
          buildFalse = false
          log('Prepare seen ' + (response.message || ''))
          return
        }
        // mstBuildProfile often returns false and prepare still succeeds.
        // Tearing down here is the "Prepare BUILD_FALSE, Retry in 2s" loop.
        if (response.code === 'BUILD_FALSE' || response.code === 'BUILD_OK') {
          buildFalse = response.code === 'BUILD_FALSE'
          if (!buildTraced) {
            buildTraced = true
            try {
              trace(response.code === 'BUILD_OK' ? 'build ok' : 'build false')
            } catch (e) {}
          }
          return
        }
        if (
          response.code === 'ONPREPARE_FALSE' ||
          response.code === 'BUILD_THREW'
        ) {
          settled = true
          cancelEvery(streamTick)
          streamTick = null
          preferScan = true
          dropLink()
          scheduleReconnect('Prepare ' + response.code, CONNECT_RETRY_MS)
          return
        }
        if (response.code || response.message) {
          log('Prepare ' + (response.code || response.message))
        }
        return
      }
      settled = true
      buildFalse = false
      prepareOk = true
      prepareFails = 0
      buildFalseStreak = 0
      preferLongProfile = false
      try {
        trace('prepare-ok ' + Math.round((Date.now() - startedAt) / 1000) + 's')
      } catch (e) {}
      cancelLater(gattTimer)
      gattTimer = null
      cancelEvery(streamTick)
      streamTick = null
      communicate(sensor)
    })
    cancelEvery(streamTick)
    streamTick = every(2000, () => {
      if (settled || gen !== connectGen || !sessionWanted || dropping) {
        cancelEvery(streamTick)
        streamTick = null
        return
      }
      const elapsed = Date.now() - startedAt
      loginQuietUntil = Date.now() + LOGIN_QUIET_MS
      status('GATT login ' + Math.floor(elapsed / 1000) + 's')
      if (elapsed < PREPARE_GIVE_UP_MS) return
      giveUpPrepare()
    })
  }

  function onConnectFailed(sensor, result) {
    const status = result && result.status ? result.status : 'failed'
    // Zepp reuses the mstConnect callback: startListener/mstBuildProfile often
    // emits "disconnected" while login is still running. Do not tear the link down.
    // Zepp re-fires mstConnect as disconnected during prepare AND after Live.
    // Tearing down after the first packets is why the display froze on the
    // last reading.
    if (status === 'disconnected' && sessionWanted && linkUp) {
      const age = lastPacketAt ? Date.now() - lastPacketAt : Infinity
      const sinceAcl = connectTime ? Date.now() - connectTime : Infinity
      const waitingFirst = hadLive && !gotGlucose && sinceAcl < FIRST_PACKET_HINT_MS
      const freshLive = gotGlucose && age < LIVE_STALE_MS
      // Fake disconnect during login. After Live, ignore only while the
      // radio is still up — a real drop used to freeze the last reading.
      if (buildFalse && !prepareOk && sinceAcl >= 2500) {
        connecting = false
        try {
          trace('dc-build-false ' + Math.round(sinceAcl / 1000) + 's')
        } catch (e) {}
        giveUpPrepare()
        return
      }
      if (Date.now() < loginQuietUntil || waitingFirst) {
        connecting = false
        try {
          if (!prepareOk) {
            trace('dc-login ' + Math.round(sinceAcl / 1000) + 's')
          } else if (waitingFirst) {
            trace('dc-first ' + Math.round(sinceAcl / 1000) + 's')
          }
        } catch (e) {}
        return
      }
      if (freshLive && radioIsUp(ble) && age < QUIET_NOTIFY_MS) {
        connecting = false
        try {
          trace('dc-ignore age=' + Math.round(age / 1000) + 's')
        } catch (e) {}
        return
      }
      if (freshLive && !radioIsUp(ble)) {
        try {
          trace('dc-drop age=' + Math.round(age / 1000) + 's')
        } catch (e) {}
        preferScan = true
      } else if (freshLive && age >= LIVE_QUIET_MS) {
        try {
          trace('dc-late age=' + Math.round(age / 1000) + 's')
        } catch (e) {}
        preferScan = true
      }
    }
    connecting = false
    if (status === 'stale-connected') {
      if (linkUp) {
        try {
          trace('acl-stale ignored')
        } catch (e) {}
        return
      }
      scheduleReconnect('Stale connect', CONNECT_RETRY_MS)
      return
    }
    if (status === 'no id') {
      // Zepp re-fires the stale mstConnect callback with "no id" during a
      // healthy stream. The live-quiet watchdog is the real judge of health.
      if (linkUp && gotGlucose && lastPacketAt && Date.now() - lastPacketAt < LIVE_QUIET_MS) {
        try {
          trace('no-id ignored live')
        } catch (e) {}
        return
      }
      liveMacFails++
      noIdFails++
      const rawId = result && result.raw_id != null ? result.raw_id : '?'
      try {
        trace('no-id n=' + noIdFails + ' raw=' + rawId)
      } catch (e) {}
      const burstMac = macsToTry[macIndex] || lastLiveMac
      if (noIdFails <= 1 && burstTries < 2 && burstMac) {
        burstTries++
        try {
          if (ble.disconnectId) ble.disconnectId(1)
        } catch (e) {}
        try {
          trace('no-id burst-retry ' + burstTries)
        } catch (e) {}
        cancelLater(burstTimer)
        burstTimer = later(400, () => {
          burstTimer = null
          if (!sessionWanted || dropping || linkUp || connecting) return
          connecting = true
          connectMac(sensor, burstMac)
        })
        return
      }
      const recoverable = sessionHadLive() || canSelfRecover()
      if (!recoverable) {
        preferScan = true
        nativeReset('no-id')
        dropLink()
        waitForNfc()
        return
      }
      // resetNative on every no-id is how Zepp returns connect_id <= 0 forever.
      if (noIdFails === 1) {
        sameProcessReconnect = true
      } else if (noIdFails === 2) {
        preferScan = true
        nativeReset('no-id')
      } else if (noIdFails === 3 || noIdFails % 5 === 0) {
        rebootBle(true)
        return
      } else {
        preferScan = true
      }
      dropLink()
      scheduleReconnect('No connect id', CONNECT_RETRY_MS)
      return
    }
    const lost = status === 'disconnected' && (linkUp || gotGlucose || hadLive)
    if (!sessionWanted) {
      drop('Connect failed: ' + status)
      return
    }
    if (status === 'in progress') {
      busyTries++
      if (busyTries >= 3) {
        if (hadLive) {
          preferScan = !scanLive
          scheduleReconnect('BLE stuck')
          return
        }
        log('BLE stuck, resetting radio')
        closeBle()
        retryDueAt = Date.now() + 1000
        later(1000, () => {
          retryDueAt = 0
          if (!sessionWanted) return
          dropping = false
          connecting = false
          beginConnect()
        })
        return
      }
      log('Connect still busy, waiting')
      later(800, () => {
        if (!sessionWanted || connecting || linkUp || dropping) return
        connecting = true
        const mac = macsToTry[macIndex]
        if (mac) connectMac(sensor, mac)
        else beginConnect()
      })
      return
    }
    if (sameProcessReconnect && !scanLive && !linkUp) {
      liveMacFails++
    }
    if (lost) {
      if (!linkLostAt) linkLostAt = Date.now()
      const recent = recentLive()
      const first = !lastSoftLostAt || Date.now() - lastSoftLostAt >= SOFT_LOST_WINDOW_MS
      if (recent && first) {
        lastSoftLostAt = Date.now()
        try {
          trace('lost soft')
        } catch (e) {}
        preferScan = true
        sameProcessReconnect = false
        connecting = false
        linkUp = false
        dropLink()
        beginConnect()
        return
      }
      try {
        trace('lost reboot')
      } catch (e) {}
      log('Link lost, rebuilding')
      rebootBle(true)
      return
    }
    if (status === 'timed out') {
      if (!scanLive) preferScan = true
      scheduleReconnect('Connect timed out', CONNECT_RETRY_MS)
      return
    }
    preferScan = true
    scheduleReconnect('Connect failed (' + status + ')', CONNECT_RETRY_MS)
  }

  function rollScanStats() {
    const day = new Date()
    const key = day.getFullYear() + '-' + (day.getMonth() + 1) + '-' + day.getDate()
    if (key === scanStatKey) return
    scanStatKey = key
    scanCount = 0
    scanSeconds = 0
  }

  function noteScanStart() {
    rollScanStats()
    if (!scanRadioAt) scanCount++
    scanRadioAt = Date.now()
  }

  function noteScanStop() {
    if (!scanRadioAt) return
    scanSeconds += Math.max(0, Math.round((Date.now() - scanRadioAt) / 1000))
    scanRadioAt = 0
  }

  function ensurePhase() {
    if (phaseLoaded) return
    phaseLoaded = true
    try {
      const n = loadAdvertPhase()
      if (n >= 0 && n < 60000) advertPhaseMs = n
    } catch (e) {}
  }

  function phaseKnown() {
    return advertPhaseMs >= 0 && advertPhaseMs < 60000
  }

  function recentLive() {
    if (lastPacketAt && Date.now() - lastPacketAt < SLOT_RECENT_MS) return true
    const last = loadLastReading()
    return !!(last && last.at && Date.now() - last.at < SLOT_RECENT_MS)
  }

  function nextSlotDelay(now) {
    const mod = ((now % 60000) + 60000) % 60000
    let delta = advertPhaseMs - mod
    if (delta < 0) delta += 60000
    return delta
  }

  function rememberPhase(at) {
    const phase = ((Number(at) % 60000) + 60000) % 60000
    advertPhaseMs = phase
    phaseLoaded = true
    slotMisses = 0
    try {
      saveAdvertPhase(phase)
    } catch (e) {}
  }

  function cancelScanWait() {
    scanWaiting = false
    scanWaitUntil = 0
    cancelLater(scanWaitTimer)
    scanWaitTimer = null
  }

  function haltScan() {
    cancelScanWait()
    startSlotScan = null
    noteScanStop()
    cancelEvery(scanTick)
    scanTick = null
    scanPulse = null
    cancelLater(scanDeadline)
    scanDeadline = null
    scanStartedAt = 0
    try {
      ble.stopScan()
    } catch (e) {}
  }

  function onAclUp(sensor, result) {
    if (scanLive) scanLive.handedOff = true
    haltScan()
    linkUp = true
    connectTime = Date.now()
    kpiAclAt = connectTime
    connecting = false
    busyTries = 0
    unlockSent = false
    loginWritten = false
    unlockAttempt = 0
    sessionUnlockCount = 0
    loginQuietUntil = Date.now() + LOGIN_QUIET_MS
    liveMacFails = 0
    noIdFails = 0
    burstTries = 0
    rememberMac(macsToTry[macIndex] || lastLiveMac)
    const cid = result && result.connect_id != null ? result.connect_id : '?'
    const connS = kpiConnectAt ? Math.round((kpiAclAt - kpiConnectAt) / 1000) : 0
    try {
      trace('acl-up id=' + cid + ' ' + connS + 's')
    } catch (e) {}
    log('Connected, logging in…')
    if (hooks.onConnected) hooks.onConnected()
    listen(sensor)
  }

  function connectMac(sensor, mac) {
    // Keep the LE scan up until ACL is up. Stopping it first is how Zepp
    // drops the advertiser and mstConnect then sits until timeout.
    cancelEvery(scanTick)
    scanTick = null
    scanPulse = null
    cancelLater(connectDelay)
    cancelLater(connectWait)
    connectWait = null
    cancelEvery(connectTick)
    connectTick = null
    log('Connecting\n' + mac)
    if (hooks.onKeepAwake) hooks.onKeepAwake(true)
    const gen = ++connectGen
    let started = false
    let called = false
    const startedAt = Date.now()
    kpiConnectAt = startedAt
    try {
      trace('mstConnect ' + mac)
    } catch (e) {}
    try {
      started = ble.connect(mac, (result) => {
        if (gen !== connectGen) return
        called = true
        cancelLater(connectWait)
        connectWait = null
        cancelEvery(connectTick)
        connectTick = null
        if (dropping) return
        if (result.connected) {
          if (linkUp) {
            const dupId = result.connect_id != null ? result.connect_id : '?'
            try {
              trace('acl-dup id=' + dupId)
            } catch (e) {}
            return
          }
          onAclUp(sensor, result)
          return
        }
        onConnectFailed(sensor, result)
      })
    } catch (e) {
      if (hooks.onBleUnavailable) hooks.onBleUnavailable(e)
      drop(e && e.message ? e.message : 'BLE unavailable', true)
      return
    }
    if (started === false && !called) {
      onConnectFailed(sensor, { connected: false, status: 'failed' })
      return
    }
    connectTick = every(5000, () => {
      if (called || linkUp || gen !== connectGen || !sessionWanted || dropping) {
        cancelEvery(connectTick)
        connectTick = null
        return
      }
      const elapsed = Math.floor((Date.now() - startedAt) / 1000)
      status('Connecting ' + elapsed + 's\n' + mac)
    })
    connectWait = later(CONNECT_TIMEOUT_MS, () => {
      connectWait = null
      cancelEvery(connectTick)
      connectTick = null
      if (called || !sessionWanted || dropping || linkUp) return
      onConnectFailed(sensor, { connected: false, status: 'timed out' })
    })
  }

  function scanThenConnect(sensor) {
    haltScan()
    const savedMac = formatMac(sensor.bleAddress)
    log('Scanning ' + (sensor.serial || savedMac || 'Libre'))
    const found = { handedOff: false }
    scanLive = found
    let sawCount = 0
    let slotsFreed = false
    let lastHint = ''
    let lastRefresh = Date.now()
    let startedAt = Date.now()
    scanStartedAt = startedAt
    kpiScanAt = startedAt
    kpiAdvertAt = 0
    try {
      trace('scan start')
    } catch (e) {}
    const go = (device) => {
      const mac = device && device.dev_addr
      if (found.handedOff || !mac) return
      found.handedOff = true
      scanEmptyPasses = 0
      burstTries = 0
      macsToTry = [mac]
      macIndex = 0
      rememberMac(mac)
      const label = deviceName(device) || mac
      kpiAdvertAt = Date.now()
      rememberPhase(kpiAdvertAt)
      const rssi = device.rssi != null ? device.rssi : device.RSSI
      const scanS = Math.round((kpiAdvertAt - startedAt) / 1000)
      try {
        trace(
          'advert ' +
            mac +
            ' rssi=' +
            (rssi != null ? rssi : '?') +
            ' scan=' +
            scanS +
            's'
        )
      } catch (e) {}
      log('Found ' + label + '\n' + mac)
      connectMac(sensor, mac)
    }
    const onAdvert = (device) => {
      if (found.handedOff || !sessionWanted) return
      sawCount++
      lastHint = advertHint(device)
      if (isSensorAdvertisement(device, sensor)) go(device)
    }
    const beginScan = () => {
      if (found.handedOff || !sessionWanted) return false
      if (scanRadioAt) return true
      cancelScanWait()
      let started = false
      try {
        started = ble.startScan(onAdvert, { allow_duplicates: true, throttle_interval: 1000 })
      } catch (e) {
        if (hooks.onBleUnavailable) hooks.onBleUnavailable(e)
        connecting = false
        scanLive = null
        if (sessionHadLive() || canSelfRecover()) {
          rebootBle()
          return false
        }
        scheduleReconnect('Scan threw')
        return false
      }
      if (started === false) {
        connecting = false
        scanLive = null
        scheduleReconnect('Scan failed')
        return false
      }
      lastRefresh = Date.now()
      noteScanStart()
      return true
    }
    if (!beginScan()) return
    const pulse = () => {
      if (found.handedOff || !sessionWanted) {
        cancelEvery(scanTick)
        scanTick = null
        scanPulse = null
        return
      }
      const now = Date.now()
      const sec = Math.floor((now - startedAt) / 1000)
      const clock = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0')
      let msg = 'Scanning ' + clock + ' · ' + sawCount + ' BLE'
      if (lastHint) msg += '\n' + lastHint
      else if (sec >= 8) msg += '\nNo advert yet'
      status(msg)
      if (
        !slotsFreed &&
        !found.handedOff &&
        sessionHadLive() &&
        now - startedAt >= 120000
      ) {
        slotsFreed = true
        try {
          trace('scan-empty free-slots')
        } catch (e) {}
        try {
          if (ble.disconnectId) {
            ble.disconnectId(0)
            ble.disconnectId(1)
          }
        } catch (e) {}
      }
      if (now - startedAt >= SCAN_TIMEOUT_MS) {
        const hot =
          (sessionHadLive() || canSelfRecover()) &&
          linkLostAt &&
          Date.now() - linkLostAt < HOT_SCAN_MS
        if (hot) {
          scanEmptyPasses++
          if (scanEmptyPasses >= 2) {
            try {
              trace('scan empty-pass reboot n=' + scanEmptyPasses)
            } catch (e) {}
            cancelEvery(scanTick)
            scanTick = null
            scanLive = null
            haltScan()
            connecting = false
            rebootBle()
            return
          }
          try {
            trace('scan hot-restart pass=' + scanEmptyPasses)
          } catch (e) {}
          startedAt = Date.now()
          scanStartedAt = startedAt
          lastRefresh = Date.now()
          noteScanStop()
          try {
            ble.stopScan()
          } catch (e) {}
          nativeReset('scan-hot', scanEmptyPasses === 1 ? { freeAll: true } : undefined)
          if (!beginScan()) {
            cancelEvery(scanTick)
            scanTick = null
            scanPulse = null
          }
          return
        }
        scanLive = null
        haltScan()
        connecting = false
        // After the 15 min hot window, pause 60s between 390s scans.
        // preferScan: the saved MAC just failed to advertise, so do not
        // mstConnect it on the retry.
        if (sessionHadLive() || canSelfRecover()) {
          preferScan = true
          scheduleReconnect('No advert', SCAN_PAUSE_MS)
          return
        }
        waitForNfc()
        return
      }
      // The stack may silently stop LE scan; one pass lasts 6.5 min.
      if (now - lastRefresh >= SCAN_REFRESH_MS && !found.handedOff) {
        try {
          trace('scan refresh ' + Math.round((now - lastRefresh) / 1000) + 's')
        } catch (e) {}
        noteScanStop()
        try {
          ble.stopScan()
        } catch (e) {}
        if (!beginScan()) {
          cancelEvery(scanTick)
          scanTick = null
          scanPulse = null
        }
        return
      }
    }
    scanPulse = pulse
    scanTick = every(5000, pulse)
  }

  function parkLink() {
    connecting = false
    linkUp = false
    unlockSent = false
    loginWritten = false
    prepareOk = false
    dropping = false
    connectGen++
    clearRetry()
    dropLink()
  }

  function forceReconnectNow() {
    if (!sessionWanted) return
    parkLink()
    dropping = false
    beginConnect()
  }

  return {
    connect() {
      const fresh =
        linkUp && lastPacketAt && Date.now() - lastPacketAt < QUIET_NOTIFY_MS
      if (sessionWanted && fresh) return
      sessionWanted = true
      setSessionWanted(true)
      retries = 0
      retryStartedAt = Date.now()
      silentLogins = 0
      outageSilents = 0
      quietReconnects = 0
      noIdFails = 0
      bleReboots = 0
      scanEmptyPasses = 0
      prepareFails = 0
      buildFalseStreak = 0
      preferLongProfile = false
      linkLostAt = 0
      gotGlucose = false
      hadLive = sessionHadLive()
      preferScan = false
      sameProcessReconnect = false
      liveMacFails = 0
      lastLiveMac = getLiveMac()
      needsNfc = false
      lastPacketAt = 0
      connectTime = 0
      clearRetry()
      ensureWatchdog()
      log('Requesting Bluetooth…')
      const start = () => {
        retryDueAt = 0
        if (!sessionWanted) return
        dropping = false
        beginConnect()
      }
      const boot = () => {
        nativeReset('connect boot', { freeAll: true })
        dropLink()
        // A frozen 700ms timer must still be rescued by the minute watchdog.
        handshakeAt = 0
        retryDueAt = Date.now() + 700
        later(700, start)
      }
      try {
        ensureBlePermission()
          .then(boot)
          .catch((err) => {
            if (hooks.onBleUnavailable) hooks.onBleUnavailable(err)
            drop(err.message || 'Permission error', true)
          })
      } catch (e) {
        if (hooks.onBleUnavailable) hooks.onBleUnavailable(e)
        drop(e && e.message ? e.message : 'BLE unavailable', true)
      }
    },
    disconnect() {
      drop('Disconnected')
    },
    detach() {
      // Leave scan, connect, GATT, and login running. Page destroy must not
      // abort the unlock handshake (F002 CCCD, then F001).
    },
    release() {
      sessionWanted = false
      connecting = false
      linkUp = false
      unlockSent = false
      loginWritten = false
      prepareOk = false
      preferScan = false
      sameProcessReconnect = false
      connectTime = 0
      resetNotify()
      clearRetry()
      closeBle()
      hadLive = false
    },
    setHooks(next) {
      hooks = next || {}
    },
    rearmWatchdog() {
      rearmWatchdog()
    },
    park() {
      sessionWanted = false
      hooks = {}
      parkLink()
      try {
        trace('parked')
      } catch (e) {}
    },
    resumeStale() {
      if (lastPacketAt && Date.now() - lastPacketAt < LIVE_QUIET_MS) return
      // The parked BLEMaster's startScan throws. Rebuild first, then scan.
      rebootBle(true)
    },
    forceReconnect() {
      forceReconnectNow()
    },
    kick() {
      forceReconnectNow()
    },
    isBusy() {
      return connecting
    },
    isLinked() {
      return linkUp
    },
    hadLive() {
      return hadLive
    },
    lastPacketAt() {
      return lastPacketAt
    },
    retryDueAt() {
      return retryDueAt
    },
    isWanted() {
      return sessionWanted
    },
    rescanApplied() {
      silentLogins = 0
      outageSilents = 0
      unlockRewritten = false
      sessionUnlockCount = 0
      advertPhaseMs = -1
      phaseLoaded = true
      slotMisses = 0
      try {
        saveAdvertPhase(-1)
      } catch (e) {}
      forceReconnectNow()
    },
    scanStats() {
      rollScanStats()
      const open = scanRadioAt ? Math.max(0, Math.round((Date.now() - scanRadioAt) / 1000)) : 0
      return { n: scanCount, sec: scanSeconds + open }
    },
    isUnlockRejected() {
      return outageSilents >= UNLOCK_REJECT_N
    }
  }
}
