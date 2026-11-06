/**
 * Bluetooth LE hand-off from Libre2 Key: pure helpers, no device APIs, so
 * they run under `npm test`. Must match ble/ScanFrames.kt on the phone.
 *
 * Advert manufacturer data: "AMZCGM" + version 0x01 + CRC32 (LE) of the JSON.
 * Notification frames: [seq u8][total u8][payload...], seq 0..total-1.
 */

export const PHONE_SERVICE = 'AC10'
export const PHONE_CONTROL = 'AC11'
export const PHONE_DATA = 'AC12'
export const PHONE_MAGIC_HEX = '414d5a43474d01'
export const PHONE_SERVICE_VERSION = 1
/** Name Libre2 Key advertises while visible (ScanBlePeripheral.ADVERTISED_NAME). */
export const PHONE_NAME = 'AMZCGM'

/** Scan-result name as text; Zepp may hand it over as bytes. */
export function advertName(device) {
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

/** True when the advertised name is Libre2 Key's, like nameMatches() for ABBOTT. */
export function isPhoneName(name) {
  const n = String(name || '')
    .toUpperCase()
    .replace(/[\s_-]/g, '')
  return n.indexOf(PHONE_NAME) === 0
}

/** Last 4 hex digits of a 16-bit, 32-bit or base-128-bit UUID in any form. */
export function uuidTail(value) {
  if (typeof value === 'number') {
    return (value & 0xffff).toString(16).toUpperCase().padStart(4, '0')
  }
  const text = String(value == null ? '' : value)
    .replace(/-/g, '')
    .toUpperCase()
  if (!text) return ''
  const base = '00001000800000805F9B34FB'
  if (text.length >= 32 && text.slice(text.length - 24) === base) {
    return text.slice(text.length - 28, text.length - 24)
  }
  if (text.length === 8 && text.slice(0, 4) === '0000') return text.slice(4, 8)
  if (text.length <= 4) return text.padStart(4, '0')
  return text.slice(-4)
}

function crcFromHex(hex8) {
  if (!hex8 || hex8.length !== 8) return null
  const b = []
  for (let i = 0; i < 4; i++) b.push(parseInt(hex8.substr(i * 2, 2), 16))
  if (b.some((x) => !Number.isFinite(x))) return null
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0
}

/** Service data under AC10: [version][crc LE]. Returns { crc } or null. */
export function parsePhoneServiceData(hex) {
  const h = String(hex || '').toLowerCase().replace(/[^0-9a-f]/g, '')
  if (h.length < 10) return null
  if (parseInt(h.slice(0, 2), 16) !== PHONE_SERVICE_VERSION) return null
  return { crc: crcFromHex(h.slice(2, 10)) }
}

/**
 * Is this scan result Libre2 Key? Checks, like the sensor match does, the
 * single uuid, the service UUID list and the service data list, and finally
 * the manufacturer data. Returns { crc, via } or null; crc may be null.
 */
export function matchPhoneAdvert(device) {
  if (!device) return null
  const sd = device.service_data_array
  let sdCrc = null
  if (sd && sd.length) {
    for (let i = 0; i < sd.length; i++) {
      if (uuidTail(sd[i] && sd[i].uuid) === PHONE_SERVICE) {
        const parsed = parsePhoneServiceData(sd[i].service_data)
        sdCrc = parsed ? parsed.crc : null
        if (!isPhoneName(advertName(device))) return { crc: sdCrc, via: 'service-data' }
      }
    }
  }
  if (isPhoneName(advertName(device))) {
    const vendor = sdCrc == null ? parsePhoneAdvert(device.vendor_data) : null
    return { crc: sdCrc != null ? sdCrc : vendor ? vendor.crc : null, via: 'name' }
  }
  if (uuidTail(device.uuid) === PHONE_SERVICE) {
    const vendor = parsePhoneAdvert(device.vendor_data)
    return { crc: vendor ? vendor.crc : null, via: 'uuid' }
  }
  const list = device.service_uuid_array
  if (list && list.length) {
    for (let i = 0; i < list.length; i++) {
      if (uuidTail(list[i]) === PHONE_SERVICE) {
        const vendor = parsePhoneAdvert(device.vendor_data)
        return { crc: vendor ? vendor.crc : null, via: 'uuid-list' }
      }
    }
  }
  const vendor = parsePhoneAdvert(device.vendor_data)
  return vendor ? { crc: vendor.crc, via: 'vendor' } : null
}

/** Short description of a scan result for the trace and the sync subtitle. */
export function describeAdvert(device) {
  if (!device) return ''
  const sd = device.service_data_array
  const svc =
    uuidTail(device.uuid) ||
    (device.service_uuid_array && device.service_uuid_array.length
      ? uuidTail(device.service_uuid_array[0])
      : '') ||
    (sd && sd.length ? uuidTail(sd[0] && sd[0].uuid) : '')
  const name = advertName(device).slice(0, 12)
  const vendor = String(device.vendor_data || '').slice(0, 8)
  return (name || String(device.dev_addr || '').slice(-5)) + (svc ? ' s' + svc : '') + (vendor ? ' v' + vendor : '')
}

/**
 * Finds the Libre2 Key marker in a scan result's vendor_data hex string.
 * Returns { crc } (unsigned) or null. Works whether or not the company ID
 * precedes the payload.
 */
export function parsePhoneAdvert(vendorHex) {
  const hex = String(vendorHex || '').toLowerCase()
  const at = hex.indexOf(PHONE_MAGIC_HEX)
  if (at < 0) return null
  const crcHex = hex.slice(at + PHONE_MAGIC_HEX.length, at + PHONE_MAGIC_HEX.length + 8)
  return { crc: crcFromHex(crcHex) }
}

/** Copy notification data into a Uint8Array without any length cap. */
export function frameBytes(data, length) {
  if (data == null) return new Uint8Array(0)
  let view
  try {
    if (typeof data === 'string') {
      const hex = data.replace(/[^0-9a-fA-F]/g, '')
      view = new Uint8Array(hex.length >> 1)
      for (let i = 0; i < view.length; i++) view[i] = parseInt(hex.substr(i * 2, 2), 16)
    } else if (data instanceof ArrayBuffer) {
      view = new Uint8Array(data)
    } else if (ArrayBuffer.isView(data)) {
      view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    } else {
      view = new Uint8Array(data)
    }
  } catch (e) {
    return new Uint8Array(0)
  }
  const n = length > 0 ? Math.min(length, view.length) : view.length
  return view.slice(0, n)
}

/** Collects frames in any order; ignores duplicates and stray packets. */
export function createFrameAssembler() {
  let total = -1
  let parts = {}
  let count = 0
  return {
    /** Returns the full payload once every frame has arrived, else null. */
    add(frame) {
      if (!frame || frame.length < 2) return null
      const seq = frame[0]
      const n = frame[1]
      if (!n || seq >= n) return null
      if (total < 0) total = n
      if (n !== total) {
        // The phone restarted with a different scan: start over.
        total = n
        parts = {}
        count = 0
      }
      if (!parts[seq]) {
        parts[seq] = frame.slice(2)
        count++
      }
      if (count !== total) return null
      let size = 0
      for (let i = 0; i < total; i++) size += parts[i].length
      const out = new Uint8Array(size)
      let off = 0
      for (let i = 0; i < total; i++) {
        out.set(parts[i], off)
        off += parts[i].length
      }
      return out
    },
    received() {
      return count
    },
    expected() {
      return total
    }
  }
}
