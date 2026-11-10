/**
 * Pull the activation scan straight from AmazCGM for Android on an Android phone over
 * Bluetooth LE. No Zepp app, iPhone or Wi-Fi in the path.
 *
 * Only run this while the sensor client is parked: ble-master keeps its
 * callbacks in statics and the watch has one GATT client at a time.
 * Never calls quit()/abortConnect(): mstOffAllCb latches the next
 * mstConnect, and the sensor client must be able to reconnect afterwards.
 */
import { BLEMaster } from '../lib/ble-master'
import { crc32, utf8Text } from './crypto'
import {
  PHONE_SERVICE,
  PHONE_CONTROL,
  PHONE_DATA,
  matchPhoneAdvert,
  describeAdvert,
  advertName,
  uuidTail,
  frameBytes,
  createFrameAssembler
} from './phone-frames'
import { trace } from './trace'

/** Scan phases: unfiltered, then native name filter, then native service filter. */
const SCAN_PHASES = [
  { filter: null, ms: 6000 },
  { filter: { device_name: 'AMZCGM', fuzzy_mode: '1' }, ms: 6000 },
  { filter: { service_uuid: 'AC10' }, ms: 6000 }
]
const SCAN_MS = SCAN_PHASES.reduce((a, p) => a + p.ms, 0)
const TOTAL_MS = SCAN_MS + 30000
const GET_RETRY_MS = 3000
const MAX_GET = 4
const CCCD_FALLBACK_MS = 800
const ACK_SETTLE_MS = 400

function ble128(id) {
  return '0000' + String(id).toLowerCase() + '-0000-1000-8000-00805f9b34fb'
}

function ascii(text) {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f
  return out
}

function log(text) {
  try {
    trace('phone ' + text)
  } catch (e) {}
}

/**
 * Resolves (never rejects) with one of:
 *   { json, crc }            new scan received and verified
 *   { upToDate: true, crc }  phone advertises the scan the watch already has
 *   { error, detail }        'ble-off' | 'not-found' | 'connect' | 'transfer' | 'crc'
 * Every result also carries `stats`: what the scan saw, for the sync subtitle
 * when no log can leave the watch.
 */
export function pullScanOverBle(options) {
  const opts = options || {}
  const storedCrc = opts.storedCrc == null ? null : opts.storedCrc >>> 0
  const status = (text) => {
    try {
      if (opts.onStatus) opts.onStatus(text)
    } catch (e) {}
  }

  return new Promise((resolve) => {
    let ble = null
    let done = false
    let linked = false
    let ready = false
    let advCrc = null
    let gets = 0
    let wroteGet = false
    let received = false
    let ids = { ctrl: PHONE_CONTROL, data: PHONE_DATA }
    const timers = []
    const assembler = createFrameAssembler()
    // sample: rows for the watch's "Nearby devices" screen (the log cannot leave the watch).
    const stats = { adverts: 0, withService: 0, withVendor: 0, sample: [], phase: 0 }

    const after = (ms, fn) => {
      const t = setTimeout(() => {
        if (!done) fn()
      }, ms)
      timers.push(t)
      return t
    }

    const cleanup = () => {
      timers.forEach((t) => clearTimeout(t))
      if (!ble) return
      try {
        ble.stopScan()
      } catch (e) {}
      if (!linked) return
      try {
        if (ble.destroyProfile) ble.destroyProfile()
      } catch (e) {}
      try {
        if (ble.disconnect) ble.disconnect()
      } catch (e) {}
    }

    const finish = (result) => {
      if (done) return
      done = true
      log(
        result.json
          ? 'ok ' + result.json.length + 'b'
          : result.upToDate
            ? 'up-to-date'
            : 'fail ' + result.error + (result.detail ? ' ' + result.detail : '')
      )
      cleanup()
      result.stats = stats
      resolve(result)
    }

    const write = (text) => {
      try {
        if (ble.write.characteristicNow) return ble.write.characteristicNow(ids.ctrl, ascii(text), false)
        return ble.write.characteristic(ids.ctrl, ascii(text), false)
      } catch (e) {
        return 'throw'
      }
    }

    const onFrame = (uuid, data, length) => {
      if (done || received) return
      const frame = frameBytes(data, length)
      const out = assembler.add(frame)
      if (!out) {
        const n = assembler.received()
        if (n === 1 || n % 4 === 0) status('Receiving ' + n + '/' + assembler.expected())
        return
      }
      const crc = crc32(out)
      if (advCrc != null && crc !== advCrc) {
        finish({ error: 'crc', detail: crc.toString(16) + '!=' + advCrc.toString(16) })
        return
      }
      received = true
      const json = utf8Text(out)
      write('ACK')
      log('frames ' + assembler.expected() + ' crc ok')
      // Let the ACK leave before the link is dropped.
      after(ACK_SETTLE_MS, () => finish({ json, crc }))
    }

    const sendGet = () => {
      if (done || gets >= MAX_GET) return
      gets++
      wroteGet = true
      const r = write('GET')
      log('GET #' + gets + ' ' + r)
      status('Receiving from phone…')
      after(GET_RETRY_MS, () => {
        if (gets >= MAX_GET) {
          finish({
            error: 'transfer',
            detail: assembler.received() + '/' + Math.max(0, assembler.expected()) + ' frames'
          })
          return
        }
        sendGet()
      })
    }

    const onPrepared = () => {
      if (ready) return
      ready = true
      log('prepare ok')
      try {
        ble.on.charaNotification(onFrame)
      } catch (e) {}
      let cccd = '?'
      try {
        cccd = ble.write.notifyNow ? ble.write.notifyNow(ids.data, true) : '?'
      } catch (e) {
        cccd = 'throw'
      }
      log('cccd ' + cccd)
      // GET goes out on CCCD-complete, or after a short wait if Zepp never reports it.
      after(CCCD_FALLBACK_MS, () => {
        if (!wroteGet) sendGet()
      })
    }

    const buildProfile = () => {
      try {
        if (ble.destroyProfile) ble.destroyProfile()
      } catch (e) {}
      if (ble.attachNotify) ble.attachNotify(onFrame)
      if (ble.attachDescComplete) {
        ble.attachDescComplete((chara, desc, st) => {
          log('desc ' + st)
          if (ready && !wroteGet) sendGet()
        })
      }
      const short = ble.generateProfileObject({
        [PHONE_SERVICE]: { [PHONE_CONTROL]: [], [PHONE_DATA]: ['2902'] }
      })
      let profile = short
      if (!short || short.success === false) {
        profile = ble.generateProfileObject({
          [ble128(PHONE_SERVICE)]: { [ble128(PHONE_CONTROL)]: [], [ble128(PHONE_DATA)]: ['2902'] }
        })
        ids = { ctrl: ble128(PHONE_CONTROL), data: ble128(PHONE_DATA) }
      }
      if (!profile || profile.success === false) {
        finish({ error: 'connect', detail: 'profile ' + ((profile && profile.error) || '') })
        return
      }
      if (profile.pair !== undefined) profile.pair = false
      status('Connecting to phone…')
      ble.startListener(profile, (response) => {
        if (done) return
        if (response && response.success) {
          onPrepared()
          return
        }
        const code = (response && response.code) || ''
        // mstBuildProfile often reports false and prepare still succeeds.
        if (code === 'PREPARE_SEEN' || code === 'BUILD_FALSE' || code === 'BUILD_OK') {
          log('build ' + code)
          return
        }
        if (code === 'ONPREPARE_FALSE' || code === 'BUILD_THREW') {
          finish({ error: 'connect', detail: code })
        }
      })
    }

    const connect = (mac) => {
      log('connect ' + mac)
      status('Connecting to phone…')
      let started
      try {
        // Keep the scan running until the ACL is up (see sensor-client connectMac).
        started = ble.connect(mac, (result) => {
          if (done) return
          if (result && result.connected) {
            if (linked) return
            linked = true
            try {
              ble.stopScan()
            } catch (e) {}
            buildProfile()
            return
          }
          // Zepp re-fires the connect callback as "disconnected" during prepare.
          if (linked || (result && result.status === 'in progress')) return
          finish({ error: 'connect', detail: (result && result.status) || 'failed' })
        })
      } catch (e) {
        finish({ error: 'connect', detail: (e && e.message) || 'throw' })
        return
      }
      if (started === false && !linked) finish({ error: 'connect', detail: 'not started' })
    }

    try {
      ble = new BLEMaster()
    } catch (e) {
      finish({ error: 'ble-off', detail: (e && e.message) || '' })
      return
    }

    after(TOTAL_MS, () => {
      finish(
        linked
          ? {
              error: 'transfer',
              detail: ready ? assembler.received() + ' frames' : 'no prepare'
            }
          : { error: 'not-found' }
      )
    })
    after(SCAN_MS, () => {
      if (!linked && advCrc == null) finish({ error: 'not-found' })
    })

    status('Looking for phone…')
    let matched = false
    let phaseIdx = 0
    const seen = {}
    const onDevice = (device) => {
          if (done || matched || !device) return
          // Evidence for "phone not visible": count distinct devices and what
          // Zepp reports for them. The subtitle shows this when no log can.
          const key = String(device.dev_addr || '')
          if (!seen[key]) {
            seen[key] = true
            stats.adverts++
            const sd = device.service_data_array
            const hasSvc =
              !!uuidTail(device.uuid) ||
              !!(device.service_uuid_array && device.service_uuid_array.length) ||
              !!(sd && sd.length)
            if (hasSvc) stats.withService++
            if (device.vendor_data) stats.withVendor++
            if (stats.sample.length < 12) {
              stats.sample.push({
                text: describeAdvert(device),
                name: advertName(device),
                mac: String(device.dev_addr || ''),
                svc: (device.service_uuid_array || []).map(uuidTail).join(','),
                sdUuid: (sd || []).map((x) => uuidTail(x && x.uuid)).join(','),
                rssi: device.rssi,
                phase: phaseIdx
              })
            }
            if (stats.adverts <= 12) log('adv p' + phaseIdx + ' ' + describeAdvert(device) + ' rssi ' + device.rssi)
          }
          let adv = matchPhoneAdvert(device)
          // Under a native filter the firmware did the matching; accept a device
          // that carries no identifying fields at all (nothing else can match the filter).
          if (!adv && phaseIdx > 0) {
            const sd2 = device.service_data_array
            const bare =
              !advertName(device) &&
              !(device.service_uuid_array && device.service_uuid_array.length) &&
              !(sd2 && sd2.length) &&
              !uuidTail(device.uuid)
            if (bare) adv = { crc: null, via: 'filter-p' + phaseIdx }
          }
          if (!adv) return
          matched = true
          advCrc = adv.crc
          log(
            'found ' + device.dev_addr + ' via ' + adv.via + ' rssi ' + device.rssi +
              ' crc ' + (adv.crc == null ? '?' : adv.crc.toString(16))
          )
          if (storedCrc != null && adv.crc != null && adv.crc === storedCrc) {
            finish({ upToDate: true, crc: adv.crc })
            return
          }
          connect(device.dev_addr)
    }
    const startPhase = (idx) => {
      if (done || matched) return
      phaseIdx = idx
      stats.phase = idx
      const phase = SCAN_PHASES[idx]
      if (idx > 0) {
        try {
          ble.stopScan()
        } catch (e) {}
      }
      const opts = { allow_duplicates: true, throttle_interval: 500 }
      if (phase.filter) opts.filter = phase.filter
      let ok
      try {
        ok = ble.startScan(onDevice, opts)
      } catch (e) {
        if (idx === 0) {
          finish({ error: 'ble-off', detail: (e && e.message) || 'scan threw' })
          return
        }
        ok = false
      }
      log('scan p' + idx + ' ' + (phase.filter ? JSON.stringify(phase.filter) : 'open') + ' ok=' + ok)
      if (ok === false && idx === 0) {
        finish({ error: 'ble-off', detail: 'scan not started' })
        return
      }
      if (idx + 1 < SCAN_PHASES.length) after(phase.ms, () => startPhase(idx + 1))
    }
    startPhase(0)
  })
}
