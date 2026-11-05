import { readFileSync, writeFileSync, rmSync } from '@zos/fs'
import { trace } from './trace'

export const LEGACY_BIN_FILE = 'glucose.bin'
export const RECORD_BYTES = 12
export const HISTORY_HOURS = 72
export const HISTORY_MS = HISTORY_HOURS * 60 * 60 * 1000
export const HISTORY_MAX = 4500
export const HISTORY_INITIAL_HOURS = 12
export const HISTORY_INITIAL_MS = HISTORY_INITIAL_HOURS * 60 * 60 * 1000
const PRUNE_SPAN_HOURS = 6
const DEDUPE_MS = 30000
const DEDUPE_SEC = 30

let curSegIdx = -1
let curSegRows = null

function safeTrace(msg) {
  try {
    trace(msg)
  } catch (e) {}
}

function clampU16(v) {
  const n = Math.round(Number(v) || 0)
  if (n < 0) return 0
  if (n > 65535) return 65535
  return n
}

function clampU32(v) {
  const n = Math.floor(Number(v) || 0)
  if (n < 0) return 0
  if (n > 0xffffffff) return 0xffffffff
  return n >>> 0
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
  const str = String(text)
  try {
    writeFileSync({
      path: path,
      data: str,
      options: { encoding: 'utf8' }
    })
    return true
  } catch (e) {
    try {
      const out = new Uint8Array(str.length)
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff
      writeFileSync({ path: path, data: out.buffer })
      return true
    } catch (e2) {
      return false
    }
  }
}

function segPath(idx) {
  return 'glu_' + idx + '.json'
}

export function hourIndexForMs(atMs) {
  const sec = Math.floor((Number(atMs) || 0) / 1000)
  return Math.floor(sec / 3600)
}

function parseSegRows(text) {
  if (!text) return []
  try {
    const arr = JSON.parse(text)
    if (!Array.isArray(arr)) return []
    const out = []
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i]
      if (Array.isArray(r) && r.length >= 2) {
        const atSec = clampU32(r[0])
        const rawX100 = clampU16(r[1])
        const wear = clampU16(r[2])
        const flags = Number(r[3]) ? 1 : 0
        if (atSec > 0 && rawX100 > 0) {
          out.push([atSec, rawX100, wear, flags])
        }
      }
    }
    return out
  } catch (e) {
    return []
  }
}

function loadSegRows(idx) {
  if (idx === curSegIdx && curSegRows) {
    return curSegRows
  }
  const rows = parseSegRows(readText(segPath(idx)))
  if (idx === curSegIdx) {
    curSegRows = rows
  }
  return rows
}

function saveSegRows(idx, rows, wasEmpty) {
  const path = segPath(idx)
  const json = JSON.stringify(rows)
  if (!writeText(path, json)) {
    safeTrace('hist seg write fail ' + idx)
    return false
  }
  if (wasEmpty) {
    const verify = parseSegRows(readText(path))
    if (!verify.length) {
      safeTrace('hist seg create fail ' + idx)
      return false
    }
  }
  curSegIdx = idx
  curSegRows = rows
  return true
}

function normalizePoints(points) {
  const valid = []
  const src = points || []
  for (let i = 0; i < src.length; i++) {
    const p = src[i]
    if (!p) continue
    const raw = Number(p.rawMmol > 0 ? p.rawMmol : p.mmol)
    const at = Number(p.at)
    if (Number.isFinite(raw) && raw > 0 && Number.isFinite(at) && at > 0) {
      valid.push({
        at: at,
        rawMmol: raw,
        wearMinutes: Number(p.wearMinutes) || 0,
        hasError: !!p.hasError
      })
    }
  }
  return valid
}

export function appendRawPoints(points) {
  const valid = normalizePoints(points)
  if (!valid.length) return true

  const byHour = {}
  const hourKeys = []
  for (let i = 0; i < valid.length; i++) {
    const p = valid[i]
    const idx = hourIndexForMs(p.at)
    if (idx <= 0) continue
    if (!byHour[idx]) {
      byHour[idx] = []
      hourKeys.push(idx)
    }
    byHour[idx].push(p)
  }
  if (!hourKeys.length) return true

  let allOk = true
  for (let k = 0; k < hourKeys.length; k++) {
    const idx = hourKeys[k]
    const incoming = byHour[idx]
    const rows = loadSegRows(idx).slice()
    const wasEmpty = rows.length === 0
    let changed = false

    for (let i = 0; i < incoming.length; i++) {
      const p = incoming[i]
      const atSec = clampU32(Math.round(p.at / 1000))
      const rawX100 = clampU16(p.rawMmol * 100)
      const wear = clampU16(p.wearMinutes)
      const flags = p.hasError ? 1 : 0
      if (!atSec || !rawX100) continue
      const nextRow = [atSec, rawX100, wear, flags]
      let replaced = false
      for (let j = 0; j < rows.length; j++) {
        if (Math.abs(rows[j][0] - atSec) < DEDUPE_SEC) {
          if (
            rows[j][0] !== nextRow[0] ||
            rows[j][1] !== nextRow[1] ||
            rows[j][2] !== nextRow[2] ||
            rows[j][3] !== nextRow[3]
          ) {
            rows[j] = nextRow
            changed = true
          }
          replaced = true
          break
        }
      }
      if (!replaced) {
        rows.push(nextRow)
        changed = true
      }
    }

    if (changed) {
      rows.sort((a, b) => a[0] - b[0])
      if (!saveSegRows(idx, rows, wasEmpty)) {
        allOk = false
      }
    }
  }
  return allOk
}

function pruneOldSegments(cutIdx) {
  if (cutIdx <= PRUNE_SPAN_HOURS) return
  for (let idx = cutIdx - PRUNE_SPAN_HOURS; idx <= cutIdx - 1; idx++) {
    try {
      rmSync({ path: segPath(idx) })
    } catch (e) {}
  }
}

let lastPrunedCutIdx = -1

/**
 * Delete hour segments that fell out of the 72h retention window.
 * Does no reads; runs at most once per hour index.
 */
export function pruneExpiredSegments(nowMs) {
  const now = Number(nowMs) || Date.now()
  const cutIdx = hourIndexForMs(now - HISTORY_MS)
  if (cutIdx === lastPrunedCutIdx) return
  lastPrunedCutIdx = cutIdx
  pruneOldSegments(cutIdx)
}

/**
 * Read hour segments startIdx..endIdx (inclusive) and return sorted,
 * deduplicated raw points. No cutoff filter, no prune, no HISTORY_MAX cap.
 */
export function loadRawRange(startIdx, endIdx) {
  const first = Math.max(1, Math.floor(Number(startIdx) || 0))
  const last = Math.floor(Number(endIdx) || 0)
  if (last < first) return []
  const nowIdx = hourIndexForMs(Date.now())

  const raw = []
  for (let idx = first; idx <= last; idx++) {
    const rows = idx === curSegIdx && curSegRows ? curSegRows : parseSegRows(readText(segPath(idx)))
    if (idx === nowIdx && rows.length && curSegIdx < 0) {
      curSegIdx = idx
      curSegRows = rows
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if (r[1] > 0) {
        raw.push({
          at: r[0] * 1000,
          rawMmol: r[1] / 100,
          wearMinutes: r[2] || 0,
          hasError: (r[3] & 1) !== 0
        })
      }
    }
  }

  raw.sort((a, b) => a.at - b.at)
  const deduped = []
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i]
    const prev = deduped.length ? deduped[deduped.length - 1] : null
    if (prev && Math.abs(p.at - prev.at) < DEDUPE_MS) {
      deduped[deduped.length - 1] = p
    } else {
      deduped.push(p)
    }
  }
  return deduped
}

export function loadRawHistory(cutoffMs) {
  const now = Date.now()
  const cut = cutoffMs != null ? Number(cutoffMs) : now - HISTORY_MS
  const startMs = cut > 0 ? cut : now - HISTORY_MS
  const startIdx = Math.max(1, hourIndexForMs(startMs))
  const endIdx = Math.max(startIdx, hourIndexForMs(now) + 1)

  const all = loadRawRange(startIdx, endIdx)
  const out = []
  for (let i = 0; i < all.length; i++) {
    if (all[i].at >= cut) out.push(all[i])
  }

  if (cut > 0) {
    pruneOldSegments(startIdx)
  }

  if (out.length > HISTORY_MAX) {
    return out.slice(out.length - HISTORY_MAX)
  }
  return out
}

export function compactHistoryIfNeeded() {
  // Segments are pruned per hour on load; no full-file compaction needed.
}

/**
 * Encode/decode helpers kept for legacy `glucose.bin` import and tests.
 */
export function encodePoints(points) {
  const src = points || []
  const count = src.length
  const buf = new ArrayBuffer(count * RECORD_BYTES)
  const u8 = new Uint8Array(buf)
  for (let i = 0; i < count; i++) {
    const p = src[i] || {}
    const base = i * RECORD_BYTES
    const atSec = clampU32(Math.round((Number(p.at) || 0) / 1000))
    const raw = Number(p.rawMmol != null ? p.rawMmol : p.mmol) || 0
    const rawX100 = clampU16(raw * 100)
    const wear = clampU16(p.wearMinutes)
    const flags = p.hasError ? 1 : 0
    u8[base] = atSec & 0xff
    u8[base + 1] = (atSec >>> 8) & 0xff
    u8[base + 2] = (atSec >>> 16) & 0xff
    u8[base + 3] = (atSec >>> 24) & 0xff
    u8[base + 4] = rawX100 & 0xff
    u8[base + 5] = (rawX100 >>> 8) & 0xff
    u8[base + 6] = wear & 0xff
    u8[base + 7] = (wear >>> 8) & 0xff
    u8[base + 8] = flags
    u8[base + 9] = 0
    u8[base + 10] = 0
    u8[base + 11] = 0
  }
  return buf
}

export function decodeBuffer(buf, cutoffMs) {
  if (!buf) return []
  let u8 = null
  if (buf instanceof ArrayBuffer) {
    u8 = new Uint8Array(buf)
  } else if (ArrayBuffer.isView(buf)) {
    u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } else {
    return []
  }
  const count = Math.floor(u8.length / RECORD_BYTES)
  if (count <= 0) return []
  const cut = Number(cutoffMs) || 0
  const raw = []
  for (let i = 0; i < count; i++) {
    const base = i * RECORD_BYTES
    const atSec =
      (u8[base] |
        (u8[base + 1] << 8) |
        (u8[base + 2] << 16) |
        (u8[base + 3] << 24)) >>>
      0
    const rawX100 = u8[base + 4] | (u8[base + 5] << 8)
    const wear = u8[base + 6] | (u8[base + 7] << 8)
    const flags = u8[base + 8]
    const at = atSec * 1000
    if (at >= cut && rawX100 > 0) {
      raw.push({
        at: at,
        rawMmol: rawX100 / 100,
        wearMinutes: wear,
        hasError: (flags & 1) !== 0
      })
    }
  }
  raw.sort((a, b) => a.at - b.at)
  const deduped = []
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i]
    const prev = deduped.length ? deduped[deduped.length - 1] : null
    if (prev && Math.abs(p.at - prev.at) < DEDUPE_MS) {
      deduped[deduped.length - 1] = p
    } else {
      deduped.push(p)
    }
  }
  if (deduped.length > HISTORY_MAX) {
    return deduped.slice(deduped.length - HISTORY_MAX)
  }
  return deduped
}

export function readLegacyBinPoints(cutoffMs) {
  try {
    const raw = readFileSync({ path: LEGACY_BIN_FILE })
    if (raw && (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw))) {
      return decodeBuffer(raw, cutoffMs != null ? cutoffMs : Date.now() - HISTORY_MS)
    }
  } catch (e) {}
  return []
}

export function importLegacyHistory(readings, legacyPaths) {
  const cutoff = Date.now() - HISTORY_MS
  const pts = []
  const rawPts = normalizePoints(readings)
  for (let i = 0; i < rawPts.length; i++) {
    if (rawPts[i].at >= cutoff) pts.push(rawPts[i])
  }
  if (!pts.length) {
    return { imported: 0, verified: 0, ok: false }
  }
  const existing = loadRawHistory(cutoff)
  const distinctTargets = []
  const sortedPts = pts.slice().sort((a, b) => a.at - b.at)
  for (let i = 0; i < sortedPts.length; i++) {
    const p = sortedPts[i]
    const prevTarget = distinctTargets.length
      ? distinctTargets[distinctTargets.length - 1]
      : null
    if (prevTarget && Math.abs(p.at - prevTarget.at) < DEDUPE_MS) {
      distinctTargets[distinctTargets.length - 1] = p
    } else {
      distinctTargets.push(p)
    }
  }
  const missing = []
  for (let i = 0; i < distinctTargets.length; i++) {
    const p = distinctTargets[i]
    let already = false
    for (let j = 0; j < existing.length; j++) {
      if (Math.abs(existing[j].at - p.at) < DEDUPE_MS) {
        already = true
        break
      }
    }
    if (!already) missing.push(p)
  }
  const appendedOk = missing.length ? appendRawPoints(missing) : true
  curSegIdx = -1
  curSegRows = null
  const after = loadRawHistory(cutoff)
  let verified = 0
  for (let i = 0; i < distinctTargets.length; i++) {
    const target = distinctTargets[i]
    for (let j = 0; j < after.length; j++) {
      if (Math.abs(after[j].at - target.at) < DEDUPE_MS) {
        verified++
        break
      }
    }
  }
  const expectedMin = Math.min(distinctTargets.length, HISTORY_MAX)
  const ok = appendedOk && expectedMin > 0 && verified >= expectedMin
  if (ok && legacyPaths) {
    const list = Array.isArray(legacyPaths) ? legacyPaths : [legacyPaths]
    for (let i = 0; i < list.length; i++) {
      if (!list[i]) continue
      try {
        rmSync({ path: list[i] })
      } catch (e) {}
    }
  }
  return { imported: distinctTargets.length, verified: verified, ok: ok }
}

export function historyFileInfo() {
  const now = Date.now()
  const startIdx = Math.max(1, hourIndexForMs(now - HISTORY_MS))
  const endIdx = Math.max(startIdx, hourIndexForMs(now) + 1)
  let bytes = 0
  let records = 0
  let segments = 0
  for (let idx = startIdx; idx <= endIdx; idx++) {
    const text = readText(segPath(idx))
    if (!text) continue
    const rows = parseSegRows(text)
    if (rows.length) {
      segments++
      bytes += text.length
      records += rows.length
    }
  }
  return {
    bytes: bytes,
    records: records,
    segments: segments
  }
}
