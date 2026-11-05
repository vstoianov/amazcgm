import { LocalStorage } from '@zos/storage'
import { writeFileSync, readFileSync } from '@zos/fs'
import { DEFAULT_SENSOR, parseScanJson, asScanText } from './sensor-config'
import { fitCalPoints, applyCalFit, freshCalPoints } from './cal-fit'
import {
  appendRawPoints,
  loadRawRange,
  pruneExpiredSegments,
  hourIndexForMs,
  importLegacyHistory,
  readLegacyBinPoints,
  historyFileInfo,
  LEGACY_BIN_FILE,
  HISTORY_MS,
  HISTORY_INITIAL_MS,
  HISTORY_MAX
} from './history-log'
import { trace } from './trace'
import {
  HYPO_MMOL,
  HYPER_MMOL,
  getAlarms,
  setAlarms,
  getChartWindow,
  setChartWindow
} from './settings'

export { HYPO_MMOL, HYPER_MMOL, getAlarms, setAlarms, getChartWindow, setChartWindow }

const store = new LocalStorage()
const COUNT_FILE = 'libreUnlockCount.txt'
const SCAN_FILE = 'libreScan.json'
const LIVE_FILE = 'libreLive.json'
const SVC_FILE = 'libreSvc.json'
const HISTORY_FILE = 'libreHistory.json'
const CAL_FILE = 'libreCal.json'
const COUNT_KEY = 'libreUnlockCount'
const LAST_KEY = 'libreLastReading'
const HISTORY_KEY = 'libreHistory'
const SENSOR_KEY = 'libreSensor'
const SCAN_KEY = 'libreScanJson'
const WANTED_KEY = 'libreSessionWanted'
const RELAUNCH_ID_KEY = 'libreRelaunchId'
const RELAUNCH_ALARM_KEY = 'libreRelaunchAlarm'
const RELAUNCH_IDS_KEY = 'libreRelaunchIds'
const RELAUNCH_ALARMS_KEY = 'libreRelaunchAlarms'
const RELAUNCH_LIST_MAX = 12
const UI_ALIVE_KEY = 'libreUiAliveAt'
const FORCE_RESUME_KEY = 'libreForceResume'
const LIVE_MAC_KEY = 'libreLiveMac'
const CAL_KEY = 'libreCal'
const CAL_MAX = 8
const BLE_CONNECT_ID_KEY = 'libreBleConnectId'
const BLE_STUCK_RUNS_KEY = 'libreBleStuckRuns'
const BLE_PIDS_KEY = 'libreBlePids'
const NOTICE_KEY = 'libreNoticeOk'
const BLE_PIDS_MAX = 8

export function getHypoMmol() {
  return getAlarms().low.mmol
}

export function getHyperMmol() {
  return getAlarms().high.mmol
}

function bufToStr(buf) {
  if (buf == null) return ''
  if (typeof buf === 'string') return buf
  try {
    const u8 =
      buf instanceof ArrayBuffer
        ? new Uint8Array(buf)
        : ArrayBuffer.isView(buf)
          ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
          : new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
    return s
  } catch (e) {
    return ''
  }
}

function readTextFile(path) {
  try {
    const buf = readFileSync({ path: path, options: { encoding: 'utf8' } })
    const text = bufToStr(buf).replace(/^\uFEFF/, '').trim()
    return text || ''
  } catch (e) {
    try {
      const buf = readFileSync({ path: path })
      return bufToStr(buf).replace(/^\uFEFF/, '').trim()
    } catch (e2) {
      return ''
    }
  }
}

function writeTextFile(path, text) {
  try {
    writeFileSync({
      path: path,
      data: String(text),
      options: { encoding: 'utf8' }
    })
  } catch (e) {
    try {
      const s = String(text)
      const out = new Uint8Array(s.length)
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
      writeFileSync({ path: path, data: out.buffer })
    } catch (e2) {}
  }
}

function readFileCount() {
  const n = Number(readTextFile(COUNT_FILE))
  return Number.isFinite(n) && n >= 1 ? n : 0
}

function writeFileCount(count) {
  writeTextFile(COUNT_FILE, String(count))
}

function writeFileScan(raw) {
  if (raw && String(raw).trim()) writeTextFile(SCAN_FILE, String(raw).trim())
}

let filesRestored = false

function restoreFromFiles() {
  if (filesRestored) return
  filesRestored = true
  if (store.getItem(SCAN_KEY)) return
  const raw = readTextFile(SCAN_FILE)
  if (!raw) return
  try {
    const incoming = parseScanJson(raw)
    store.setItem(SENSOR_KEY, JSON.stringify({ ...DEFAULT_SENSOR, ...incoming }))
    store.setItem(SCAN_KEY, raw)
  } catch (e) {}
}

export function getSensor() {
  restoreFromFiles()
  const saved = store.getItem(SENSOR_KEY)
  if (!saved) return { ...DEFAULT_SENSOR }
  try {
    return { ...DEFAULT_SENSOR, ...JSON.parse(saved) }
  } catch (e) {
    return { ...DEFAULT_SENSOR }
  }
}

export function saveSensor(sensor) {
  store.setItem(SENSOR_KEY, JSON.stringify(sensor))
}

/** True once a scan has been applied, so the phone need not be asked again. */
export function hasStoredScan() {
  restoreFromFiles()
  const raw = store.getItem(SCAN_KEY)
  return !!(raw && String(raw).trim())
}

export function getStoredScanText() {
  restoreFromFiles()
  const raw = store.getItem(SCAN_KEY)
  return raw ? String(raw).trim() : ''
}

function withAppliedAt(sensor) {
  return { ...sensor, appliedAt: Date.now() }
}

function sameSensor(prev, incoming) {
  return !!(prev && prev.uidHex && incoming && incoming.uidHex === prev.uidHex)
}

/**
 * A read-only rescan of the same uid keeps the stored lock count.
 * A scan that enabled streaming (command A1 1E, or a new streaming code)
 * starts the unlock count at 1.
 */
function keepCalibration(prev, incoming) {
  if (incoming && incoming.calibration) return incoming.calibration
  if (sameSensor(prev, incoming) && prev && prev.calibration) return prev.calibration
  return null
}

export function calibrationKey(cal) {
  if (!cal) return ''
  return [cal.i1, cal.i2, cal.i3, cal.i4, cal.i5, cal.i6].join('|')
}

/** Merge factory calibration onto the stored sensor without resetting count/MAC. */
export function updateCalibration(cal) {
  if (!cal) return false
  const prev = getSensor()
  if (calibrationKey(cal) === calibrationKey(prev.calibration)) return false
  saveSensor({ ...prev, calibration: cal })
  return true
}

function emptyUserCal() {
  return { uid: '', points: [] }
}

function parseUserCal(raw) {
  if (!raw) return emptyUserCal()
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw
    const uid = String((o && o.uid) || '')
    const src = o && Array.isArray(o.points) ? o.points : []
    const points = []
    for (let i = 0; i < src.length; i++) {
      const p = src[i]
      const s = Number(p && p.s)
      const r = Number(p && p.r)
      const at = Number(p && p.at)
      if (Number.isFinite(s) && s > 0 && Number.isFinite(r) && r > 0) {
        points.push({ s: s, r: r, at: Number.isFinite(at) && at > 0 ? at : 0 })
      }
    }
    return { uid: uid, points: points }
  } catch (e) {
    return emptyUserCal()
  }
}

function readUserCal() {
  const fromFile = readTextFile(CAL_FILE)
  if (fromFile) return parseUserCal(fromFile)
  const fromStore = store.getItem(CAL_KEY)
  if (!fromStore) return emptyUserCal()
  const migrated = parseUserCal(fromStore)
  if (migrated.uid || migrated.points.length) {
    writeTextFile(CAL_FILE, JSON.stringify(migrated))
  }
  return migrated
}

function writeUserCal(data) {
  writeTextFile(CAL_FILE, JSON.stringify(data || emptyUserCal()))
}

export function getCalPoints() {
  const data = readUserCal()
  const uid = getSensor().uidHex || ''
  if (!uid || data.uid !== uid) return []
  const src = data.points || []
  const fresh = freshCalPoints(src)
  if (fresh.length !== src.length) writeUserCal({ uid: uid, points: fresh })
  return fresh
}

export function addCalPoint(sensorMmol, refMmol) {
  const s = Number(sensorMmol)
  const r = Number(refMmol)
  if (!Number.isFinite(s) || s <= 0 || !Number.isFinite(r) || r <= 0) return getCalFit()
  const uid = getSensor().uidHex || ''
  const data = readUserCal()
  const points = freshCalPoints(data.uid === uid ? data.points || [] : [])
  points.push({ s: s, r: r, at: Date.now() })
  while (points.length > CAL_MAX) points.shift()
  writeUserCal({ uid: uid, points: points })
  refitHistory()
  return getCalFit()
}

export function clearCalPoints() {
  writeUserCal({ uid: getSensor().uidHex || '', points: [] })
  refitHistory()
  return getCalFit()
}

export function getCalFit() {
  return fitCalPoints(getCalPoints())
}

export function applyCalMmol(mmol) {
  return applyCalFit(mmol, getCalFit())
}

export function exportUserCalJson() {
  return JSON.stringify(readUserCal())
}

export function importUserCalJson(json) {
  const incoming = parseUserCal(json)
  if (!incoming.points.length) return getCalPoints().length
  if (getCalPoints().length) return getCalPoints().length
  writeUserCal(incoming)
  refitHistory()
  return incoming.points.length
}

function applyParsedScan(incoming, raw) {
  const prev = getSensor()
  const calibration = keepCalibration(prev, incoming)
  const freshEnable =
    !!incoming.streamingEnabled ||
    (sameSensor(prev, incoming) && incoming.unlockCode !== prev.unlockCode)
  if (sameSensor(prev, incoming) && !freshEnable) {
    const kept = getUnlockCount()
    saveSensor({
      ...prev,
      ...incoming,
      payloads: { ...(prev.payloads || {}), ...(incoming.payloads || {}) },
      calibration
    })
    store.setItem(SCAN_KEY, raw)
    writeFileScan(raw)
    if (kept >= 1) setUnlockCount(kept)
    return getSensor()
  }
  saveSensor({ ...incoming, calibration })
  store.setItem(SCAN_KEY, raw)
  writeFileScan(raw)
  setUnlockCount(incoming.firstUnlockCount)
  clearLiveMac()
  clearBleHandles()
  return getSensor()
}

export function applyScanJson(text) {
  const raw = asScanText(text)
  return applyParsedScan(withAppliedAt(parseScanJson(raw)), raw)
}

/**
 * Companion paste: unlock code and next count are whatever the JSON says,
 * even if this is the same sensor the watch already knows.
 */
export function applyCompanionScanJson(text) {
  const raw = asScanText(text)
  if (!raw) return getSensor()
  const incoming = withAppliedAt(parseScanJson(raw))
  const prev = getSensor()
  const sameCode = sameSensor(prev, incoming) && incoming.unlockCode === prev.unlockCode
  const freshEnable = !!incoming.streamingEnabled || !sameCode
  // Phone JSON is the source of truth. Do not keep an older code/patch
  // from the previous apply of the same uid. Keep last FRAM calibration
  // when this paste omitted it (failed FRAM read).
  saveSensor({ ...incoming, calibration: keepCalibration(prev, incoming) })
  store.setItem(SCAN_KEY, raw)
  writeFileScan(raw)
  if (freshEnable) {
    setUnlockCount(incoming.firstUnlockCount)
    clearLiveMac()
    clearBleHandles()
  } else {
    setUnlockCount(Math.max(getUnlockCount(), incoming.firstUnlockCount || 1))
  }
  return getSensor()
}

/** Apply a scan. Identical JSON of the same uid is a no-op. */
export function applyScanJsonIfNew(text) {
  const raw = asScanText(text)
  if (!raw) return getSensor()
  const incoming = withAppliedAt(parseScanJson(raw))
  const prev = getSensor()
  const storedScan = store.getItem(SCAN_KEY)
  if (storedScan && String(storedScan).trim() === raw && sameSensor(prev, incoming)) {
    return prev
  }
  return applyParsedScan(incoming, raw)
}

function appliedAge(ts) {
  if (!ts) return ''
  const sec = Math.floor((Date.now() - Number(ts)) / 1000)
  if (sec < 15) return 'just now'
  if (sec < 60) return sec + 's ago'
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago'
  return Math.floor(sec / 3600) + 'h ago'
}

/** What the watch actually stored after a paste/sync. */
export function scanReceipt(sensor) {
  const s = sensor || getSensor()
  const age = appliedAge(s.appliedAt)
  return (
    s.serial +
    '\ncode ' +
    s.unlockCode +
    '\npatch ' +
    s.patchInfoHex +
    '\n' +
    String(s.bleAddress || '').toUpperCase() +
    '\ncount ' +
    getUnlockCount() +
    (age ? '\ngot ' + age : '')
  )
}

export function getUnlockCount() {
  restoreFromFiles()
  const stored = Number(store.getItem(COUNT_KEY))
  const fromStore = Number.isFinite(stored) && stored >= 1 ? stored : 0
  const fromFile = readFileCount()
  const n = Math.max(fromStore, fromFile)
  if (n >= 1) {
    if (fromStore !== n) store.setItem(COUNT_KEY, String(n))
    if (fromFile !== n) writeFileCount(n)
    return n
  }
  return getSensor().firstUnlockCount || 1
}

export function setUnlockCount(count) {
  const n = Number(count)
  if (!Number.isFinite(n) || n < 1) return
  store.setItem(COUNT_KEY, String(n))
  writeFileCount(n)
}

export function bumpUnlockCount() {
  const next = getUnlockCount() + 1
  setUnlockCount(next)
  return next
}

export function resetUnlockCount() {
  setUnlockCount(getSensor().firstUnlockCount)
}

function emptyLive() {
  return {
    wanted: false,
    at: 0,
    mmol: 0,
    rawMmol: 0,
    hasError: false,
    uiAliveAt: 0,
    appClosedAt: 0,
    pageClosedAt: 0,
    unlockRejectedAt: 0,
    bleStuckAt: 0,
    advertPhase: -1
  }
}

function parseLive(raw) {
  if (!raw) return emptyLive()
  try {
    const o = JSON.parse(raw)
    const at = Number(o && o.at)
    const mmol = Number(o && o.mmol)
    const rawMmol = Number(o && o.rawMmol)
    const ui = Number(o && o.uiAliveAt)
    const closed = Number(o && o.appClosedAt)
    const pageClosed = Number(o && o.pageClosedAt)
    const rejected = Number(o && o.unlockRejectedAt)
    const stuck = Number(o && o.bleStuckAt)
    const phase = Number(o && o.advertPhase)
    return {
      parsed: !!(o && typeof o === 'object'),
      wanted: !!(o && o.wanted),
      at: Number.isFinite(at) && at > 0 ? at : 0,
      mmol: Number.isFinite(mmol) && mmol > 0 ? mmol : 0,
      rawMmol: Number.isFinite(rawMmol) && rawMmol > 0 ? rawMmol : 0,
      hasError: !!(o && o.hasError),
      uiAliveAt: Number.isFinite(ui) && ui > 0 ? ui : 0,
      appClosedAt: Number.isFinite(closed) && closed > 0 ? closed : 0,
      pageClosedAt: Number.isFinite(pageClosed) && pageClosed > 0 ? pageClosed : 0,
      unlockRejectedAt: Number.isFinite(rejected) && rejected > 0 ? rejected : 0,
      bleStuckAt: Number.isFinite(stuck) && stuck > 0 ? stuck : 0,
      advertPhase: Number.isFinite(phase) && phase >= 0 && phase < 60000 ? Math.round(phase) : -1
    }
  } catch (e) {
    return emptyLive()
  }
}

function readLiveFile() {
  return parseLive(readTextFile(LIVE_FILE))
}

let liveState = null

function ensureLiveState() {
  // Every page load gets its own copy of this module, and the sensor client
  // held in globalData keeps the copy from the launch that created it. A
  // long-lived cache here would let one copy overwrite the file with the
  // other copy's stale timestamps, so re-read before every write and keep
  // the cache only as a fallback for a blank or unparseable read.
  const fromFile = readLiveFile()
  if (fromFile.parsed) {
    liveState = fromFile
    return liveState
  }
  if (liveState) return liveState
  liveState = fromFile
  if (!liveState.wanted && !liveState.at && !liveState.uiAliveAt) {
    liveState.wanted = store.getItem(WANTED_KEY) === '1'
    const raw = store.getItem(LAST_KEY)
    if (raw) {
      try {
        const last = JSON.parse(raw)
        if (last) {
          const at = Number(last.at)
          const mmol = Number(last.mmol)
          const rawMmol = Number(last.rawMmol)
          liveState.at = Number.isFinite(at) && at > 0 ? at : 0
          liveState.mmol = Number.isFinite(mmol) && mmol > 0 ? mmol : 0
          liveState.rawMmol = Number.isFinite(rawMmol) && rawMmol > 0 ? rawMmol : 0
          liveState.hasError = !!last.hasError
        }
      } catch (e) {}
    }
    const ui = Number(store.getItem(UI_ALIVE_KEY))
    liveState.uiAliveAt = Number.isFinite(ui) && ui > 0 ? ui : 0
  }
  return liveState
}

function writeLiveFile() {
  // Write the object the caller just mutated. ensureLiveState() would
  // re-read the file and drop that change.
  writeTextFile(LIVE_FILE, JSON.stringify(liveState || ensureLiveState()))
}

export function loadLiveState() {
  return readLiveFile()
}

export function markAppClosed() {
  ensureLiveState().appClosedAt = Date.now()
  writeLiveFile()
}

export function markPageClosed() {
  ensureLiveState().pageClosedAt = Date.now()
  writeLiveFile()
}

export function markAppOpen() {
  const s = ensureLiveState()
  s.appClosedAt = 0
  s.pageClosedAt = 0
  writeLiveFile()
}

export function saveLastReading(reading) {
  store.setItem(LAST_KEY, JSON.stringify(reading))
  const s = ensureLiveState()
  const at = reading && reading.at ? Number(reading.at) : 0
  const mmol = reading && reading.mmol ? Number(reading.mmol) : 0
  const rawMmol = reading && reading.rawMmol ? Number(reading.rawMmol) : 0
  s.at = Number.isFinite(at) && at > 0 ? at : 0
  s.mmol = Number.isFinite(mmol) && mmol > 0 ? mmol : 0
  s.rawMmol = Number.isFinite(rawMmol) && rawMmol > 0 ? rawMmol : 0
  s.hasError = !!(reading && reading.hasError)
  s.unlockRejectedAt = 0
  s.bleStuckAt = 0
  writeLiveFile()
  clearBleStuckRuns()
}

export function bumpBleStuckRuns() {
  const n = Number(store.getItem(BLE_STUCK_RUNS_KEY)) || 0
  const next = (Number.isFinite(n) && n > 0 ? n : 0) + 1
  store.setItem(BLE_STUCK_RUNS_KEY, String(next))
  return next
}

export function clearBleStuckRuns() {
  store.setItem(BLE_STUCK_RUNS_KEY, '0')
}

export function saveBleStuckAt() {
  const s = ensureLiveState()
  s.bleStuckAt = Date.now()
  writeLiveFile()
}

export function saveUnlockRejectedAt() {
  const s = ensureLiveState()
  s.unlockRejectedAt = Date.now()
  writeLiveFile()
}

function unpackLegacyHistory(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out = []
    for (let i = 0; i < parsed.length; i++) {
      const row = parsed[i]
      if (Array.isArray(row) && row.length >= 2) {
        const at = Number(row[0]) * 1000
        const mmol = Number(row[1]) / 10
        if (at > 0 && mmol > 0) out.push({ at: at, mmol: mmol, rawMmol: mmol })
      } else if (row && row.at && (row.mmol || row.rawMmol)) {
        const at = Number(row.at)
        const mmol = Number(row.mmol || row.rawMmol)
        const rawMmol = Number(row.rawMmol > 0 ? row.rawMmol : mmol)
        if (at > 0 && mmol > 0) out.push({ at: at, mmol: mmol, rawMmol: rawMmol })
      }
    }
    return out
  } catch (e) {
    return []
  }
}

function toReading(rawPt, fit) {
  const raw = Number(rawPt.rawMmol != null ? rawPt.rawMmol : rawPt.mmol) || 0
  const hasError = !!rawPt.hasError
  const mmol = hasError ? raw : applyCalFit(raw, fit)
  return {
    at: Number(rawPt.at) || 0,
    mmol: mmol,
    rawMmol: raw,
    wearMinutes: Number(rawPt.wearMinutes) || 0,
    hasError: hasError
  }
}

let historyCache = null
/** Lowest hour index currently loaded into historyCache (contiguous up to now). */
let historyFromIdx = -1
let pendingWrites = []

function flushPendingWrites(extra) {
  const batch = pendingWrites.length
    ? pendingWrites.concat(extra || [])
    : extra || []
  if (!batch.length) return true
  if (appendRawPoints(batch)) {
    pendingWrites = []
    return true
  }
  pendingWrites = batch.slice(-120)
  return false
}

function trimHistory(list, cutoff) {
  const out = []
  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    if (p && p.mmol > 0 && p.at >= cutoff) out.push(p)
  }
  out.sort((a, b) => (a.at || 0) - (b.at || 0))
  if (out.length > HISTORY_MAX) {
    return out.slice(out.length - HISTORY_MAX)
  }
  return out
}

/**
 * Return the in-memory history. With no argument only the last
 * HISTORY_INITIAL_MS (12h) is loaded on first call. Pass `fromMs` to make sure
 * readings back to that time are loaded; only the missing hour segments are
 * read from disk, never more than the 72h retention window.
 */
export function loadHistory(fromMs) {
  const now = Date.now()
  const minIdx = Math.max(1, hourIndexForMs(now - HISTORY_MS))
  const initIdx = Math.max(minIdx, hourIndexForMs(now - HISTORY_INITIAL_MS))
  const wantIdx =
    fromMs != null && Number.isFinite(Number(fromMs))
      ? Math.max(minIdx, hourIndexForMs(Number(fromMs)))
      : initIdx
  if (!historyCache) {
    coldLoadHistory(now, Math.min(wantIdx, initIdx), minIdx)
  } else if (wantIdx < historyFromIdx) {
    extendHistoryBack(wantIdx, now)
  }
  return historyCache
}

function rawToReadings(rawList, fit, cutoff) {
  const list = []
  for (let i = 0; i < rawList.length; i++) {
    const r = toReading(rawList[i], fit)
    if (r.mmol > 0 && r.at >= cutoff) list.push(r)
  }
  return list
}

function extendHistoryBack(fromIdx, now) {
  const toIdx = historyFromIdx - 1
  if (fromIdx > toIdx) return
  const cutoff = now - HISTORY_MS
  const older = rawToReadings(loadRawRange(fromIdx, toIdx), getCalFit(), cutoff)
  while (
    older.length &&
    historyCache.length &&
    Math.abs(historyCache[0].at - older[older.length - 1].at) < 30000
  ) {
    older.pop()
  }
  let next = older.concat(historyCache)
  if (next.length > HISTORY_MAX) {
    next = next.slice(next.length - HISTORY_MAX)
  }
  historyCache = next
  historyFromIdx = fromIdx
  try {
    trace('hist ext idx=' + fromIdx + '..' + toIdx + ' n=' + older.length)
  } catch (e) {}
}

function coldLoadHistory(now, fromIdx, minIdx) {
  const cutoff = now - HISTORY_MS
  const endIdx = Math.max(fromIdx, hourIndexForMs(now) + 1)
  const fit = getCalFit()
  pruneExpiredSegments(now)
  let rawList = loadRawRange(fromIdx, endIdx)
  const legacyBin = readLegacyBinPoints(cutoff)
  const legacyFile = unpackLegacyHistory(readTextFile(HISTORY_FILE))
  const legacyStore = unpackLegacyHistory(store.getItem(HISTORY_KEY))
  const legacy = legacyBin.concat(legacyFile).concat(legacyStore)
  if (legacy.length) {
    // One-time migration: legacy points may be older than the initial window,
    // so fall back to loading the full retention range this once.
    fromIdx = minIdx
    const legacyPaths = [HISTORY_FILE, LEGACY_BIN_FILE]
    const res = importLegacyHistory(legacy, legacyPaths)
    if (res && res.ok) {
      try {
        store.setItem(HISTORY_KEY, '')
      } catch (e) {}
    }
    rawList = loadRawRange(fromIdx, endIdx)
    if (!rawList.length) {
      rawList = legacy
    } else if (!res || !res.ok) {
      for (let i = 0; i < legacy.length; i++) {
        const lp = legacy[i]
        if (!lp || !lp.at || lp.at < cutoff) continue
        let found = false
        for (let j = 0; j < rawList.length; j++) {
          if (Math.abs(rawList[j].at - lp.at) < 30000) {
            found = true
            break
          }
        }
        if (!found) rawList.push(lp)
      }
    }
  }
  try {
    trace(
      'hist load n=' +
        rawList.length +
        ' idx=' +
        fromIdx +
        '..' +
        endIdx +
        ' legacy=' +
        legacy.length
    )
  } catch (e) {}
  const list = []
  for (let i = 0; i < rawList.length; i++) {
    list.push(toReading(rawList[i], fit))
  }
  historyCache = trimHistory(list, cutoff)
  historyFromIdx = fromIdx
}

export function getHistoryDiag() {
  const list = loadHistory()
  const info = historyFileInfo()
  const hasFile = !!readTextFile(HISTORY_FILE)
  const hasStore = !!store.getItem(HISTORY_KEY)
  const hasBin = readLegacyBinPoints(0).length > 0
  return {
    records: list ? list.length : 0,
    fileBytes: info.bytes,
    fileRecords: info.records,
    segments: info.segments || 0,
    legacyPresent: hasFile || hasStore || hasBin
  }
}

export function backfillHistory(points) {
  if (!points || !points.length) return loadHistory()
  const list = loadHistory()
  const now = Date.now()
  const cutoff = now - HISTORY_MS
  const fit = getCalFit()
  const toAppend = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (!p) continue
    const raw = Number(p.rawMmol > 0 ? p.rawMmol : p.mmol)
    if (!Number.isFinite(raw) || raw <= 0) continue
    const at = p.at ? Number(p.at) : now - (Number(p.minutesAgo) || 0) * 60000
    if (at < cutoff) continue
    let exists = false
    for (let j = 0; j < list.length; j++) {
      const e = list[j]
      if (e && e.at && Math.abs(e.at - at) < 30000) {
        exists = true
        break
      }
    }
    if (!exists) {
      const rawPt = {
        at: at,
        rawMmol: raw,
        wearMinutes: Number(p.wearMinutes) || 0,
        hasError: false
      }
      toAppend.push(rawPt)
      list.push(toReading(rawPt, fit))
    }
  }
  if (toAppend.length || pendingWrites.length) {
    flushPendingWrites(toAppend)
  }
  historyCache = trimHistory(list, cutoff)
  return historyCache
}

export function pushHistory(reading) {
  if (!reading || reading.hasError) return loadHistory()
  const raw = Number(reading.rawMmol > 0 ? reading.rawMmol : reading.mmol)
  const mmol = Number(reading.mmol > 0 ? reading.mmol : raw)
  if (!Number.isFinite(raw) || raw <= 0 || !Number.isFinite(mmol) || mmol <= 0) {
    return loadHistory()
  }
  const at = Number(reading.at) || Date.now()
  const cutoff = at - HISTORY_MS
  const list = loadHistory()
  const last = list.length ? list[list.length - 1] : null
  if (last && last.at && at - last.at < 20000) {
    return list
  }
  const rawPt = {
    at: at,
    rawMmol: raw,
    wearMinutes: Number(reading.wearMinutes) || 0,
    hasError: false
  }
  flushPendingWrites([rawPt])
  pruneExpiredSegments(at)
  list.push({
    at: at,
    mmol: mmol,
    rawMmol: raw,
    wearMinutes: rawPt.wearMinutes,
    hasError: false
  })
  historyCache = trimHistory(list, cutoff)
  return historyCache
}

/** Re-apply current user calibration across the in-memory history cache. */
export function refitHistory() {
  const list = loadHistory()
  const fit = getCalFit()
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    if (!r) continue
    const raw = Number(r.rawMmol > 0 ? r.rawMmol : r.mmol)
    if (raw > 0) {
      r.rawMmol = raw
      r.mmol = r.hasError ? raw : applyCalFit(raw, fit)
    }
  }
  return list
}

export function loadLastReading() {
  const raw = store.getItem(LAST_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (e) {
    return null
  }
}

export function getSessionWanted() {
  return store.getItem(WANTED_KEY) === '1'
}

export function setSessionWanted(on) {
  store.setItem(WANTED_KEY, on ? '1' : '0')
  ensureLiveState().wanted = !!on
  writeLiveFile()
}

export function getRelaunchId() {
  const n = Number(store.getItem(RELAUNCH_ID_KEY))
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function setRelaunchId(id) {
  const n = Number(id)
  if (!Number.isFinite(n) || n <= 0) {
    store.setItem(RELAUNCH_ID_KEY, '')
    return
  }
  store.setItem(RELAUNCH_ID_KEY, String(n))
}

export function getRelaunchAlarmId() {
  const n = Number(store.getItem(RELAUNCH_ALARM_KEY))
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function setRelaunchAlarmId(id) {
  const n = Number(id)
  if (!Number.isFinite(n) || n <= 0) {
    store.setItem(RELAUNCH_ALARM_KEY, '')
    return
  }
  store.setItem(RELAUNCH_ALARM_KEY, String(n))
}

function parseIdList(raw) {
  if (raw == null || raw === '') return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    const src = Array.isArray(parsed) ? parsed : [parsed]
    const out = []
    for (let i = 0; i < src.length; i++) {
      const n = Number(src[i])
      if (Number.isFinite(n) && n > 0 && out.indexOf(n) < 0) out.push(n)
    }
    return out
  } catch (e) {
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? [n] : []
  }
}

function writeIdList(key, ids) {
  const out = []
  const src = ids || []
  for (let i = 0; i < src.length; i++) {
    const n = Number(src[i])
    if (Number.isFinite(n) && n > 0 && out.indexOf(n) < 0) out.push(n)
  }
  while (out.length > RELAUNCH_LIST_MAX) out.shift()
  store.setItem(key, out.length ? JSON.stringify(out) : '')
}

export function getRelaunchIds() {
  const list = parseIdList(store.getItem(RELAUNCH_IDS_KEY))
  const legacy = getRelaunchId()
  if (legacy && list.indexOf(legacy) < 0) list.push(legacy)
  return list
}

export function setRelaunchIds(ids) {
  writeIdList(RELAUNCH_IDS_KEY, ids)
}

export function getRelaunchAlarmIds() {
  const list = parseIdList(store.getItem(RELAUNCH_ALARMS_KEY))
  const legacy = getRelaunchAlarmId()
  if (legacy && list.indexOf(legacy) < 0) list.push(legacy)
  return list
}

export function setRelaunchAlarmIds(ids) {
  writeIdList(RELAUNCH_ALARMS_KEY, ids)
}

export function clearRelaunchIdLists() {
  setRelaunchIds([])
  setRelaunchAlarmIds([])
  setRelaunchId(0)
  setRelaunchAlarmId(0)
}

export function saveUiAliveAt() {
  const now = Date.now()
  ensureLiveState().uiAliveAt = now
  writeLiveFile()
}

export function saveAdvertPhase(ms) {
  const n = Number(ms)
  ensureLiveState().advertPhase =
    Number.isFinite(n) && n >= 0 && n < 60000 ? Math.round(n) : -1
  writeLiveFile()
}

export function loadAdvertPhase() {
  const file = readLiveFile()
  const fromFile = Number(file && file.advertPhase)
  if (Number.isFinite(fromFile) && fromFile >= 0 && fromFile < 60000) return Math.round(fromFile)
  const cached = Number(ensureLiveState().advertPhase)
  return Number.isFinite(cached) && cached >= 0 && cached < 60000 ? Math.round(cached) : -1
}

export function saveSvcAliveAt() {
  writeTextFile(SVC_FILE, JSON.stringify({ aliveAt: Date.now() }))
}

export function loadSvcAliveAt() {
  const raw = readTextFile(SVC_FILE)
  if (!raw) return 0
  try {
    const o = JSON.parse(raw)
    const n = Number(o && o.aliveAt)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch (e) {
    return 0
  }
}

export function setNeedsForceResume(on) {
  store.setItem(FORCE_RESUME_KEY, on ? '1' : '0')
}

export function getNeedsForceResume() {
  return store.getItem(FORCE_RESUME_KEY) === '1'
}

/** The one-time "not a medical device" notice was accepted. */
export function getNoticeAccepted() {
  return store.getItem(NOTICE_KEY) === '1'
}

export function setNoticeAccepted(on) {
  store.setItem(NOTICE_KEY, on ? '1' : '0')
}

/** MAC of the last ACL that reached Live. Used to reconnect without a JSON guess. */
export function getLiveMac() {
  const raw = store.getItem(LIVE_MAC_KEY)
  return raw ? String(raw).toLowerCase() : ''
}

export function setLiveMac(mac) {
  const hex = String(mac || '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '')
  if (hex.length !== 12) return
  store.setItem(
    LIVE_MAC_KEY,
    hex.match(/.{2}/g).join(':')
  )
}

export function clearLiveMac() {
  store.setItem(LIVE_MAC_KEY, '')
}

export function getBleConnectId() {
  const raw = store.getItem(BLE_CONNECT_ID_KEY)
  if (raw == null || raw === '') return -1
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : -1
}

export function setBleConnectId(id) {
  const n = Number(id)
  if (!Number.isFinite(n) || n < 0) return
  store.setItem(BLE_CONNECT_ID_KEY, String(n))
}

export function clearBleConnectId() {
  store.setItem(BLE_CONNECT_ID_KEY, '')
}

export function getBlePids() {
  const raw = store.getItem(BLE_PIDS_KEY)
  if (!raw) return []
  try {
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list.filter((x) => x != null && x !== '')
  } catch (e) {
    return []
  }
}

export function rememberBlePid(pid) {
  if (pid == null || pid === '') return
  const key = String(pid)
  const next = getBlePids().filter((x) => String(x) !== key)
  next.push(typeof pid === 'number' ? pid : key)
  while (next.length > BLE_PIDS_MAX) next.shift()
  store.setItem(BLE_PIDS_KEY, JSON.stringify(next))
}

export function forgetBlePid(pid) {
  if (pid == null || pid === '') return
  const key = String(pid)
  store.setItem(BLE_PIDS_KEY, JSON.stringify(getBlePids().filter((x) => String(x) !== key)))
}

export function clearBlePids() {
  store.setItem(BLE_PIDS_KEY, '[]')
}

export function clearBleHandles() {
  clearBleConnectId()
  store.setItem(BLE_PIDS_KEY, '[]')
}
