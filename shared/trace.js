import { writeFileSync, readFileSync } from '@zos/fs'

const TRACE_FILE = 'libreTrace.txt'
const SVC_TRACE_FILE = 'svcTrace.txt'
const RING_MAX = 400
const FILE_MAX = 48000
const SVC_FILE_MAX = 16000
const FLUSH_MS = 60000

let lines = []
let sessionStart = Date.now()
let lastFlush = 0
let dirty = false
let localHydrated = false

function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

function pad3(n) {
  if (n < 10) return '00' + n
  if (n < 100) return '0' + n
  return String(n)
}

function clock(at) {
  const d = new Date(at)
  return (
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes()) +
    ':' +
    pad2(d.getSeconds()) +
    '.' +
    pad3(d.getMilliseconds())
  )
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

function writeText(path, text) {
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

function readText(path) {
  try {
    const buf = readFileSync({ path: path, options: { encoding: 'utf8' } })
    return bufToStr(buf)
  } catch (e) {
    try {
      const buf = readFileSync({ path: path })
      return bufToStr(buf)
    } catch (e2) {
      return ''
    }
  }
}

function getGlobal() {
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    return app && (app.globalData || (app._options && app._options.globalData))
  } catch (e) {
    return null
  }
}

function splitBody(body) {
  if (!body) return []
  const out = String(body).split('\n')
  const kept = []
  for (let i = 0; i < out.length; i++) {
    if (out[i]) kept.push(out[i])
  }
  return kept
}

function fillRing(ring, body) {
  const arr = splitBody(body)
  for (let i = 0; i < arr.length; i++) ring.push(arr[i])
  while (ring.length > RING_MAX) ring.shift()
}

function hydrate(ring) {
  const file = readText(TRACE_FILE)
  if (file) fillRing(ring, file)
}

function getRing() {
  const g = getGlobal()
  if (g) {
    if (!Array.isArray(g.traceLines)) g.traceLines = []
    if (!g.traceLines.length && !g.traceHydrated) {
      g.traceHydrated = true
      hydrate(g.traceLines)
    }
    return g.traceLines
  }
  if (!lines.length && !localHydrated) {
    localHydrated = true
    hydrate(lines)
  }
  return lines
}

export function resetTraceSession() {
  sessionStart = Date.now()
}

function appendSvcLine(line) {
  let prev = readText(SVC_TRACE_FILE)
  let body = prev ? prev + '\n' + line : line
  if (body.length > SVC_FILE_MAX) {
    body = body.slice(body.length - Math.floor(SVC_FILE_MAX / 2))
    const nl = body.indexOf('\n')
    if (nl >= 0) body = body.slice(nl + 1)
  }
  writeText(SVC_TRACE_FILE, body)
}

export function trace(ev) {
  const now = Date.now()
  const sec = Math.floor((now - sessionStart) / 1000)
  const line = clock(now) + ' +' + sec + 's ' + String(ev == null ? '' : ev).replace(/\n/g, ' | ')
  if (!getGlobal()) {
    appendSvcLine(line)
    return
  }
  const ring = getRing()
  ring.push(line)
  while (ring.length > RING_MAX) ring.shift()
  dirty = true
  if (now - lastFlush >= FLUSH_MS) flushTrace()
}

export function flushTrace() {
  if (!getGlobal()) return
  const ring = getRing()
  if (!ring.length) return
  dirty = false
  lastFlush = Date.now()
  let body = ring.join('\n')
  if (body.length > FILE_MAX) body = body.slice(body.length - Math.floor(FILE_MAX / 2))
  writeText(TRACE_FILE, body)
}

export function readTraceTail(maxChars) {
  const cap = maxChars > 0 ? maxChars : FILE_MAX
  flushTrace()
  const ring = getRing()
  let text = ring.length ? ring.join('\n') : ''
  if (!text) text = readText(TRACE_FILE)
  const svcText = readText(SVC_TRACE_FILE)
  if (svcText) {
    text = text ? text + '\n--- svc ---\n' + svcText : svcText
  }
  if (text.length > cap) text = text.slice(text.length - cap)
  return text
}

export function clearTrace() {
  const ring = getRing()
  ring.length = 0
  const g = getGlobal()
  if (g) g.traceHydrated = true
  localHydrated = true
  dirty = false
  lastFlush = 0
  writeText(TRACE_FILE, '')
  writeText(SVC_TRACE_FILE, '')
}
