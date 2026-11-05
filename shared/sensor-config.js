/**
 * Fallback used only until a scan JSON is saved on the watch. The identity
 * fields are well-formed placeholders that match no real sensor.
 */
export const DEFAULT_SENSOR = {
  serial: '0000000000',
  bleAddress: '00:00:00:00:00:00',
  uidHex: '0000000000000000',
  patchInfoHex: '7F0E31017C0C',
  unlockCode: 42,
  firstUnlockCount: 1,
  service: 'FDE3',
  writeChar: 'F001',
  notifyChar: 'F002'
}

function parsePositiveInt(value, fallback) {
  const n = Number(String(value == null ? '' : value).trim())
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function parseCalibration(data) {
  const c = data && data.calibration
  if (!c || typeof c !== 'object') return null
  const i1 = Number(c.i1)
  const i2 = Number(c.i2)
  const i3 = Number(c.i3)
  const i4 = Number(c.i4)
  const i5 = Number(c.i5)
  const i6 = Number(c.i6)
  if (![i1, i2, i3, i4, i5, i6].every((n) => Number.isFinite(n))) return null
  if (i2 < 1 || i2 > 1023) return null
  if (i4 === i3) return null
  return { i1: i1, i2: i2, i3: i3, i4: i4, i5: i5, i6: i6 }
}

/** Accept a JSON string or the object Zepp settingsStorage sometimes hands over. */
export function asScanText(value) {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch (e) {
      return ''
    }
  }
  return String(value).trim()
}

export function parseScanJson(text) {
  const raw = asScanText(text)
  if (!raw) throw new Error('Empty scan JSON')
  const data = JSON.parse(raw)
  const uidHex = String(data.uid || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  const patchInfoHex = String(data.patchInfo || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  const bleAddress = String(data.bleAddress || '').toLowerCase()
  if (uidHex.length !== 16) throw new Error('uid must be 8 bytes hex')
  if (patchInfoHex.length !== 12) throw new Error('patchInfo must be 6 bytes hex')
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(bleAddress)) {
    throw new Error('bleAddress must look like AA:BB:CC:DD:EE:FF')
  }
  const payloads = {}
  if (Array.isArray(data.unlockPayloads)) {
    data.unlockPayloads.forEach((item) => {
      const count = Number(item && item.unlockCount)
      const hex = String((item && item.payload) || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toUpperCase()
      if (count >= 1 && hex.length === 24) payloads[count] = hex
    })
  }
  return {
    serial: String(data.serial || ''),
    bleAddress,
    uidHex,
    patchInfoHex,
    unlockCode: parsePositiveInt(data.unlockCode != null ? data.unlockCode : data.enableTime, 42),
    firstUnlockCount: parsePositiveInt(data.nextUnlockCount, 1),
    streamingEnabled: data.streamingEnabled === true || data.streamingEnabled === 1 ||
      data.streamingEnabled === '1' || data.streamingEnabled === 'true',
    service: String(data.bleService || 'FDE3'),
    writeChar: String(data.bleWriteCharacteristic || 'F001'),
    notifyChar: String(data.bleNotifyCharacteristic || 'F002'),
    payloads,
    calibration: parseCalibration(data)
  }
}

/** uid + patch + code. Count is omitted so a later Sync does not rewind the unlock count. */
export function scanFingerprint(sensor) {
  if (!sensor) return ''
  const uid = String(sensor.uidHex || sensor.uid || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase()
  const patch = String(sensor.patchInfoHex || sensor.patchInfo || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase()
  const code = parsePositiveInt(
    sensor.unlockCode != null ? sensor.unlockCode : sensor.enableTime,
    0
  )
  if (!uid || !patch || !code) return ''
  return uid + '|' + patch + '|' + code
}

export function scanFingerprintFromText(text) {
  try {
    return scanFingerprint(parseScanJson(text))
  } catch (e) {
    return ''
  }
}
