import { LocalStorage } from '@zos/storage'
import { writeFileSync, readFileSync, rmSync } from '@zos/fs'
import { trace } from './trace'

const SETTINGS_FILE = 'libreSettings.json'
const SETTINGS_TMP = 'libreSettings.tmp'
const LEGACY_ALARMS_KEY = 'libreAlarms'
const LEGACY_CHART_WIN_KEY = 'libreChartWin'

export const HYPO_MMOL = 3.9
export const HYPER_MMOL = 10.0

const CACHE_TTL_MS = 10000

let legacyStore = null
let cached = null
let cachedAt = 0
let tmpCleaned = false

function safeTrace(msg) {
  try {
    trace(msg)
  } catch (e) {}
}

function getLegacyStore() {
  if (!legacyStore) {
    try {
      legacyStore = new LocalStorage()
    } catch (e) {}
  }
  return legacyStore
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

function readText(path) {
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

function writeText(path, text) {
  const s = String(text)
  try {
    writeFileSync({
      path: path,
      data: s,
      options: { encoding: 'utf8' }
    })
    return true
  } catch (e) {
    try {
      const out = new Uint8Array(s.length)
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
      writeFileSync({ path: path, data: out.buffer })
      return true
    } catch (e2) {
      return false
    }
  }
}

function cleanLeftoverTmp() {
  if (tmpCleaned) return
  tmpCleaned = true
  try {
    rmSync({ path: SETTINGS_TMP })
  } catch (e) {}
}

function mirrorToLocalStorage(obj) {
  const s = getLegacyStore()
  if (!s || !obj) return
  try {
    if (obj.alarms) {
      s.setItem(LEGACY_ALARMS_KEY, JSON.stringify(obj.alarms))
    }
  } catch (e) {}
  try {
    if (obj.chartWindow != null) {
      s.setItem(LEGACY_CHART_WIN_KEY, String(obj.chartWindow))
    }
  } catch (e) {}
}

function writeSettingsFile(obj) {
  cleanLeftoverTmp()
  const json = JSON.stringify(obj)
  writeText(SETTINGS_FILE, json)
  const check = parseSettings(readText(SETTINGS_FILE))
  if (!check) {
    writeText(SETTINGS_FILE, json)
  }
  mirrorToLocalStorage(obj)
}

export function defaultAlarms() {
  return {
    low: { mmol: HYPO_MMOL, enabled: true, sound: true, duration: 3 },
    high: { mmol: HYPER_MMOL, enabled: true, sound: true, duration: 3 }
  }
}

function clampNum(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

function normalizeAlarmSide(side, fallback, lo, hi) {
  const src = side && typeof side === 'object' ? side : {}
  const sound = src.sound != null ? !!src.sound : !!fallback.sound
  return {
    mmol: Math.round(clampNum(src.mmol != null ? src.mmol : fallback.mmol, lo, hi) * 10) / 10,
    enabled: src.enabled != null ? !!src.enabled : sound,
    sound: sound,
    duration: Math.round(clampNum(src.duration != null ? src.duration : fallback.duration, 1, 10))
  }
}

function ensureAlarmGap(low, high, preferLow) {
  if (low.mmol < high.mmol) return
  if (preferLow) {
    high.mmol = Math.min(20, Math.round((low.mmol + 0.1) * 10) / 10)
  } else {
    low.mmol = Math.max(2.2, Math.round((high.mmol - 0.1) * 10) / 10)
  }
}

function normalizeAlarms(alarms, preferLow) {
  const d = defaultAlarms()
  const a = alarms && typeof alarms === 'object' ? alarms : {}
  const low = normalizeAlarmSide(a.low, d.low, 2.2, 8)
  const high = normalizeAlarmSide(a.high, d.high, 6, 20)
  ensureAlarmGap(low, high, !!preferLow)
  return { low: low, high: high }
}

function normalizeChartWindow(idx) {
  const n = Number(idx)
  return Number.isFinite(n) && n >= 0 && n <= 2 ? Math.round(n) : 0
}

function parseSettings(raw) {
  if (!raw) return null
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!o || typeof o !== 'object') return null
    return {
      alarms: normalizeAlarms(o.alarms, false),
      chartWindow: normalizeChartWindow(o.chartWindow)
    }
  } catch (e) {
    return null
  }
}

function readFromLocalStorage() {
  const s = getLegacyStore()
  let legacyAlarms = null
  let legacyWin = 0
  let hadLegacy = false
  if (s) {
    try {
      const rawA = s.getItem(LEGACY_ALARMS_KEY)
      if (rawA) {
        legacyAlarms = typeof rawA === 'string' ? JSON.parse(rawA) : rawA
        hadLegacy = true
      }
    } catch (e) {}
    try {
      const rawW = s.getItem(LEGACY_CHART_WIN_KEY)
      if (rawW != null && rawW !== '') {
        legacyWin = normalizeChartWindow(rawW)
        hadLegacy = true
      }
    } catch (e) {}
  }
  const out = {
    alarms: normalizeAlarms(legacyAlarms, false),
    chartWindow: legacyWin
  }
  if (hadLegacy) {
    writeSettingsFile(out)
  }
  return out
}

function loadSettings() {
  const now = Date.now()
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached
  const text = readText(SETTINGS_FILE)
  const parsed = parseSettings(text)
  if (parsed) {
    cached = parsed
    cachedAt = now
    return cached
  }
  const fromLs = readFromLocalStorage()
  cached = fromLs
  cachedAt = now
  return cached
}

function saveSettings(next) {
  cached = next
  cachedAt = Date.now()
  writeSettingsFile(next)
  safeTrace(
    'settings save low=' +
      next.alarms.low.mmol +
      '/' +
      (next.alarms.low.sound ? 1 : 0) +
      '/' +
      next.alarms.low.duration +
      's high=' +
      next.alarms.high.mmol +
      '/' +
      (next.alarms.high.sound ? 1 : 0) +
      '/' +
      next.alarms.high.duration +
      's win=' +
      next.chartWindow
  )
  return next
}

export function getAlarms() {
  const s = loadSettings()
  return {
    low: { ...s.alarms.low },
    high: { ...s.alarms.high }
  }
}

export function setAlarms(partial) {
  const s = loadSettings()
  const cur = s.alarms
  const incoming = partial && typeof partial === 'object' ? partial : {}
  const nextLow = Object.assign({}, cur.low, incoming.low || {})
  const nextHigh = Object.assign({}, cur.high, incoming.high || {})
  if (incoming.low && incoming.low.sound != null) nextLow.enabled = !!incoming.low.sound
  if (incoming.high && incoming.high.sound != null) nextHigh.enabled = !!incoming.high.sound
  const preferLow = !!(incoming.low && incoming.low.mmol != null)
  const alarms = normalizeAlarms({ low: nextLow, high: nextHigh }, preferLow)
  saveSettings({ ...s, alarms: alarms })
  return {
    low: { ...alarms.low },
    high: { ...alarms.high }
  }
}

export function getChartWindow() {
  return loadSettings().chartWindow
}

export function setChartWindow(idx) {
  const s = loadSettings()
  const w = normalizeChartWindow(idx)
  saveSettings({ ...s, chartWindow: w })
  return w
}
