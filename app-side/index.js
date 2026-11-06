import { BaseSideService } from '@zeppos/zml/base-side'
import { settingsLib } from '@zeppos/zml/base-side'
import { asScanText, scanFingerprintFromText } from '../shared/sensor-config'

const STORE_CHUNK = 800
/** Settings keys left over from the removed Wi-Fi fetch. */
const STALE_KEYS = ['scannerUrl', 'scannerUrlOkAt', 'scanFetchReq', 'scanFetchDone', 'scanFetchMsg']
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

function serialOf(json) {
  try {
    return String(JSON.parse(json).serial || '')
  } catch (e) {
    return ''
  }
}

AppSideService(
  BaseSideService({
    onInit() {
      STALE_KEYS.forEach((key) => {
        try {
          settingsLib.removeItem(key)
        } catch (e) {}
      })
    },
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
        // The scan pasted in Zepp settings; there is no other source.
        const stored = getScanJson()
        if (stored && looksLikeScan(stored)) {
          res(null, { ...scanMeta(stored), serial: serialOf(stored), source: 'settings', error: '' })
        } else {
          res(null, {
            json: '',
            source: '',
            fingerprint: '',
            uid: '',
            patchInfo: '',
            unlockCode: 0,
            serial: '',
            error: 'no-scan'
          })
        }
        return
      }
      res(null, {})
    },
    onSettingsChange({ key, newValue }) {
      const json = key === 'scanJson' ? asScanText(newValue) : ''
      if (json) this.pushScan(json)
    },

    pushScan(json) {
      try {
        this.call({
          method: 'APPLY_SCAN',
          params: { json, unlockCode: unlockCodeOf(json) }
        })
      } catch (e) {}
    },

    onRun() {},
    onDestroy() {}
  })
)
