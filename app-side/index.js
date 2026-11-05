import { BaseSideService } from '@zeppos/zml/base-side'
import { settingsLib } from '@zeppos/zml/base-side'
import {
  asScanText,
  scanFingerprintFromText
} from '../shared/sensor-config'

const FETCH_MS = 4000
const STORE_CHUNK = 800
let logParts = []

function storeBleTrace(full) {
  const text = String(full || '')
  const prev = Number(settingsLib.getItem('bleTraceParts')) || 0
  const parts = Math.ceil(text.length / STORE_CHUNK) || (text ? 1 : 0)
  for (let i = 0; i < parts; i++) {
    settingsLib.setItem('bleTrace.' + i, text.slice(i * STORE_CHUNK, (i + 1) * STORE_CHUNK))
  }
  for (let i = parts; i < prev; i++) {
    try {
      settingsLib.removeItem('bleTrace.' + i)
    } catch (e) {}
  }
  try {
    settingsLib.removeItem('bleTrace')
  } catch (e) {}
  settingsLib.setItem('bleTraceLen', String(text.length))
  settingsLib.setItem('bleTraceParts', String(parts))
  const COPY_MAX = 8000
  settingsLib.setItem(
    'bleTraceCopy',
    text.length > COPY_MAX ? text.slice(text.length - COPY_MAX) : text
  )
  try {
    settingsLib.removeItem('bleTraceCopyMsg')
  } catch (e) {}
}

function getScanJson() {
  const latest = asScanText(settingsLib.getItem('scanJsonLatest'))
  if (latest && looksLikeScan(latest)) return latest
  return asScanText(settingsLib.getItem('scanJson'))
}

function scannerUrl() {
  return String(settingsLib.getItem('scannerUrl') || '').trim()
}

function looksLikeScan(text) {
  try {
    const data = JSON.parse(text)
    return !!(data && data.uid && data.patchInfo && data.bleAddress)
  } catch (e) {
    return false
  }
}

function unlockCodeOf(text) {
  try {
    const data = JSON.parse(asScanText(text))
    const n = Number(String(data.unlockCode != null ? data.unlockCode : data.enableTime || '').trim())
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch (e) {
    return 0
  }
}

function scanMeta(json) {
  const fingerprint = scanFingerprintFromText(json)
  const parts = fingerprint ? fingerprint.split('|') : []
  return {
    json,
    fingerprint,
    uid: parts[0] || '',
    patchInfo: parts[1] || '',
    unlockCode: unlockCodeOf(json)
  }
}

function fetchScan(url) {
  if (!url || typeof fetch !== 'function') return Promise.resolve('')
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_MS) : null
  const opts = controller ? { signal: controller.signal } : {}
  return fetch(url, opts)
    .then((res) => (res && res.ok ? res.text() : ''))
    .then((text) => (looksLikeScan(text) ? String(text).trim() : ''))
    .catch(() => '')
    .then((json) => {
      if (timer) clearTimeout(timer)
      return json
    })
}

AppSideService(
  BaseSideService({
    onInit() {},
    onRequest(req, res) {
      if (req.method === 'PUT_LOG') {
        const p = (req && req.params) || {}
        const part = Number(p.part) || 0
        const total = Number(p.total) || 1
        if (part === 0) logParts = []
        logParts[part] = String(p.text || '')
        let ready = total > 0 && logParts.length >= total
        for (let i = 0; i < total; i++) {
          if (typeof logParts[i] !== 'string') ready = false
        }
        if (ready) {
          const full = logParts.join('')
          logParts = []
          storeBleTrace(full)
        }
        res(null, { ok: true })
        return
      }
      if (req.method === 'PUT_CAL') {
        const json = String((req.params && req.params.json) || '')
        if (json) settingsLib.setItem('userCal', json)
        else {
          try {
            settingsLib.removeItem('userCal')
          } catch (e) {}
        }
        res(null, { ok: true })
        return
      }
      if (req.method === 'GET_CAL') {
        res(null, { json: settingsLib.getItem('userCal') || '' })
        return
      }
      if (req.method === 'GET_SCAN_JSON') {
        const emptyScan = {
          json: '',
          source: '',
          fingerprint: '',
          uid: '',
          patchInfo: '',
          unlockCode: 0
        }
        const replyStored = () => {
          const stored = getScanJson()
          if (stored && looksLikeScan(stored)) {
            res(null, { ...scanMeta(stored), source: 'settings' })
            return
          }
          if (req.params && req.params.settingsOnly) {
            res(null, emptyScan)
            return
          }
          fetchScan(scannerUrl()).then((json) => {
            if (json) {
              settingsLib.setItem('scanJson', json)
              res(null, { ...scanMeta(json), source: 'scanner' })
              return
            }
            res(null, emptyScan)
          })
        }
        if (req.params && req.params.refresh) {
          fetchScan(scannerUrl()).then((json) => {
            if (json) {
              settingsLib.setItem('scanJson', json)
              settingsLib.setItem('scanJsonLatest', json)
              res(null, { ...scanMeta(json), source: 'scanner' })
              return
            }
            replyStored()
          })
          return
        }
        replyStored()
        return
      }
      res(null, {})
    },
    onSettingsChange({ key, newValue }) {
      const json = key === 'scanJson' ? asScanText(newValue) : ''
      if (json) {
        this.call({
          method: 'APPLY_SCAN',
          params: { json, unlockCode: unlockCodeOf(json) }
        })
      }
    },
    onRun() {},
    onDestroy() {}
  })
)
