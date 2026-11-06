/**
 * Libre 2 (security generation 1) BLE unlock / decrypt.
 * Arithmetic derived from MIT-licensed DiaBLE (Guido Soranzio) and
 * LibreTools (Ivan Valkou). Copyright and permission: see NOTICE.
 */

const KEY = [0xa0c5, 0x6860, 0x0000, 0x14c6]
export const SECRET = 0x1b6a
export const SUBCMD_ACTIVATE = 0x1b
export const SUBCMD_ENABLE_STREAMING = 0x1e

export function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16)
  }
  return out
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('')
}

function u16(high, low) {
  return ((high & 0xff) << 8) | (low & 0xff)
}

function op(value) {
  let res = value >> 2
  if (value & 1) res ^= KEY[1]
  if (value & 2) res ^= KEY[0]
  return res & 0xffff
}

function prepareVariables(uid, x, y) {
  return [
    (u16(uid[5], uid[4]) + x + y) & 0xffff,
    (u16(uid[3], uid[2]) + KEY[2]) & 0xffff,
    (u16(uid[1], uid[0]) + x * 2) & 0xffff,
    0x241a ^ KEY[3]
  ]
}

function prepareVariables2(uid, i1, i2, i3, i4) {
  return [
    (u16(uid[5], uid[4]) + i1) & 0xffff,
    (u16(uid[3], uid[2]) + i2) & 0xffff,
    (u16(uid[1], uid[0]) + i3 + KEY[2]) & 0xffff,
    (i4 + KEY[3]) & 0xffff
  ]
}

export function processCrypto(input) {
  const r0 = op(input[0]) ^ input[3]
  const r1 = op(r0) ^ input[2]
  const r2 = op(r1) ^ input[1]
  const r3 = op(r2) ^ input[0]
  const r4 = op(r3)
  const r5 = op(r4 ^ r0)
  const r6 = op(r5 ^ r1)
  const r7 = op(r6 ^ r2)
  return [r3 ^ r7, r2 ^ r6, r1 ^ r5, r0 ^ r4]
}

export function usefulFunction(uid, x, y) {
  const blockKey = processCrypto(prepareVariables(uid, x, y))
  const r1 = blockKey[0] ^ 0x4163
  const r2 = blockKey[1] ^ 0x4344
  return new Uint8Array([r1 & 0xff, (r1 >> 8) & 0xff, r2 & 0xff, (r2 >> 8) & 0xff])
}

const CRC_TABLE = (() => {
  const table = new Uint16Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >> 1) ^ 0x8408 : crc >> 1
    }
    table[i] = crc
  }
  return table
})()

export function crc16(data, offset = 0, length = data.length - offset) {
  let crc = 0xffff
  for (let i = offset; i < offset + length; i++) {
    crc = (crc >> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff]
  }
  let reversed = 0
  for (let i = 0; i < 16; i++) {
    reversed = (reversed << 1) | (crc & 1)
    crc >>= 1
  }
  return reversed & 0xffff
}

export function streamingUnlockPayload(uid, patchInfo, enableTime, unlockCount) {
  const time = (enableTime + unlockCount) >>> 0
  const b = new Uint8Array([
    time & 0xff,
    (time >> 8) & 0xff,
    (time >> 16) & 0xff,
    (time >> 24) & 0xff
  ])

  const ad = usefulFunction(uid, SUBCMD_ACTIVATE, SECRET)
  const ed = usefulFunction(
    uid,
    SUBCMD_ENABLE_STREAMING,
    (enableTime & 0xffff) ^ u16(patchInfo[5], patchInfo[4])
  )

  const t11 = u16(ed[1], ed[0]) ^ u16(b[3], b[2])
  const t12 = u16(ad[1], ad[0])
  const t13 = u16(ed[3], ed[2]) ^ u16(b[1], b[0])
  const t14 = u16(ad[3], ad[2])
  const t2 = processCrypto(prepareVariables2(uid, t11, t12, t13, t14))

  const t31 = crc16(
    new Uint8Array([
      0xc1, 0xc4, 0xc3, 0xc0, 0xd4, 0xe1, 0xe7, 0xba,
      t2[0] & 0xff, (t2[0] >> 8) & 0xff
    ])
  )
  const t32 = crc16(
    new Uint8Array([
      t2[1] & 0xff, (t2[1] >> 8) & 0xff,
      t2[2] & 0xff, (t2[2] >> 8) & 0xff,
      t2[3] & 0xff, (t2[3] >> 8) & 0xff
    ])
  )
  const t33 = crc16(new Uint8Array([ad[0], ad[1], ad[2], ad[3], ed[0], ed[1]]))
  const t34 = crc16(new Uint8Array([ed[2], ed[3], b[0], b[1], b[2], b[3]]))
  const t4 = processCrypto(prepareVariables2(uid, t31, t32, t33, t34))

  return new Uint8Array([
    b[0], b[1], b[2], b[3],
    t4[0] & 0xff, (t4[0] >> 8) & 0xff,
    t4[1] & 0xff, (t4[1] >> 8) & 0xff,
    t4[2] & 0xff, (t4[2] >> 8) & 0xff,
    t4[3] & 0xff, (t4[3] >> 8) & 0xff
  ])
}

export function decryptBLE(uid, data) {
  const d = usefulFunction(uid, SUBCMD_ACTIVATE, SECRET)
  const x = (u16(d[1], d[0]) ^ u16(d[3], d[2])) | 0x63
  const y = u16(data[1], data[0]) ^ 0x63

  const key = new Uint8Array(64)
  let initialKey = processCrypto(prepareVariables(uid, x, y))
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 4; j++) {
      key[i * 8 + j * 2] = initialKey[j] & 0xff
      key[i * 8 + j * 2 + 1] = (initialKey[j] >> 8) & 0xff
    }
    initialKey = processCrypto(initialKey)
  }

  const result = new Uint8Array(data.length - 2)
  for (let i = 0; i < result.length; i++) {
    result[i] = data[i + 2] ^ key[i]
  }
  return result
}

export function bleCrcOk(plain) {
  if (plain.length < 44) return false
  const expected = plain[42] | (plain[43] << 8)
  return crc16(plain, 0, 42) === expected
}

export function readBits(buffer, byteOffset, bitOffset, bitCount) {
  let res = 0
  for (let i = 0; i < bitCount; i++) {
    const total = bitOffset + i
    const byte = Math.floor(total / 8)
    const bit = ((total % 8) + 8) % 8
    if (total >= 0 && ((buffer[byteOffset + byte] >> bit) & 1) === 1) {
      res |= 1 << i
    }
  }
  return res
}

function buildT1() {
  const a = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5]
  const b = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75]
  const c = [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75]
  const d = [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0]
  const out = []
  for (let i = 0; i < 64; i++) for (let j = 0; j < a.length; j++) out.push(a[j])
  for (let i = 0; i < 23; i++) for (let j = 0; j < b.length; j++) out.push(b[j])
  for (let i = 0; i < 29; i++) for (let j = 0; j < c.length; j++) out.push(c[j])
  for (let i = 0; i < 8; i++) for (let j = 0; j < d.length; j++) out.push(d[j])
  return out
}

function buildT2() {
  const rows = [
    [8, 0.0377442], [8, 0.0381217], [8, 0.0385029], [8, 0.0388879],
    [8, 0.0392768], [8, 0.0396696], [8, 0.0400663], [8, 0.0404669],
    [8, 0.0408716], [8, 0.0412803], [8, 0.0416931], [8, 0.04211],
    [8, 0.0425311], [8, 0.0429565], [8, 0.043386], [8, 0.0438199],
    [8, 0.0442581], [8, 0.0447007], [8, 0.0451477], [8, 0.0455991],
    [8, 0.0460551], [8, 0.0465157], [8, 0.0469808], [8, 0.0474506],
    [8, 0.0479252], [8, 0.0484044], [8, 0.0488884], [8, 0.0493773],
    [8, 0.0498711], [8, 0.0503698], [8, 0.0508735], [8, 0.0513823],
    [8, 0.0518961], [8, 0.052415], [8, 0.0529392], [8, 0.0534686],
    [8, 0.0540033], [8, 0.0545433], [8, 0.0550887], [8, 0.0556396],
    [8, 0.056196], [8, 0.056758], [8, 0.0573256], [8, 0.0578988],
    [8, 0.0584778], [8, 0.0590626], [8, 0.0596532], [8, 0.0602497],
    [8, 0.0608522], [8, 0.0614607], [8, 0.0620754], [8, 0.0626961],
    [8, 0.0633231], [8, 0.0639563], [8, 0.0645959], [8, 0.0652418],
    [8, 0.0658942], [8, 0.0665532], [8, 0.0672187], [8, 0.0678909],
    [8, 0.0685698], [8, 0.0692555], [8, 0.0699481], [8, 0.0706475],
    [9, 0.071354], [9, 0.0720676], [9, 0.0727882], [9, 0.0735161],
    [9, 0.0742513], [9, 0.0749938], [9, 0.0757437], [9, 0.0765012],
    [9, 0.0772662], [9, 0.0780388], [9, 0.0788192], [9, 0.0796074],
    [9, 0.0804035], [9, 0.0812075], [9, 0.0820196], [9, 0.0828398],
    [9, 0.0836682], [9, 0.0845049], [9, 0.0853499], [9, 0.0862034],
    [9, 0.0870655], [9, 0.0879361], [9, 0.0888155], [8, 0.0897036],
    [8, 0.0906007], [8, 0.0915067], [8, 0.0924217], [8, 0.093346],
    [8, 0.0942794], [8, 0.0952222], [8, 0.0961744], [8, 0.0971362],
    [8, 0.0981075], [8, 0.0990886], [8, 0.1000795], [8, 0.1010803],
    [8, 0.1020911], [8, 0.103112], [8, 0.1041431], [8, 0.1051846],
    [8, 0.1062364], [8, 0.1072988], [8, 0.1083718], [8, 0.1094555],
    [8, 0.11055], [8, 0.1116555], [8, 0.1127721], [8, 0.1138998],
    [8, 0.1150388], [8, 0.1161892], [8, 0.1173511], [8, 0.1185246],
    [9, 0.1197099], [9, 0.120907], [9, 0.122116], [9, 0.1233372],
    [9, 0.1245706], [9, 0.1258163], [9, 0.1270744], [9, 0.1283452]
  ]
  const out = []
  for (let i = 0; i < rows.length; i++) {
    const w = rows[i][0]
    const v = rows[i][1]
    for (let j = 0; j < w; j++) out.push(v)
  }
  return out
}

const T1 = buildT1()
const T2 = buildT2()
const CAL_X = 1000.0 + 71500.0
const CAL_Y = 1000.0
const CAL_CA = 0.0009180023
const CAL_CB = 0.0001964561
const CAL_CC = 0.0000007061775
const CAL_CD = 0.00000005283566

/**
 * Factory calibration. Returns 0 when calibration cannot
 * be applied so the caller can fall back to raw/10.
 */
export function factoryGlucose(raw, rawTemp, tempAdj, cal) {
  if (!cal || raw <= 0 || !cal.i2 || cal.i4 === cal.i3) return 0
  const idx = cal.i2 - 1
  if (idx < 0 || idx >= T1.length || idx >= T2.length) return 0
  const denom = tempAdj + cal.i6
  if (!denom) return 0
  const r = (rawTemp * CAL_X) / denom - CAL_Y
  if (r <= 0) return 0
  const logR = Math.log(r)
  const d =
    logR * logR * logR * CAL_CD +
    logR * logR * CAL_CC +
    logR * CAL_CB +
    CAL_CA
  if (!d) return 0
  const temperature = 1 / d - 273.15
  const g1 = (65.0 * (raw - cal.i3)) / (cal.i4 - cal.i3)
  const g3 = g1 * Math.pow(1.045, 32.5 - temperature)
  const mgdl = Math.round((g3 - T1[idx]) / T2[idx])
  return mgdl > 0 ? mgdl : 0
}

function slotRawTempAdj(plain, byteOffset) {
  const raw = readBits(plain, byteOffset, 0, 14)
  const rawTemp = readBits(plain, byteOffset, 14, 12) << 2
  let tempAdj = readBits(plain, byteOffset, 26, 5) << 2
  if (readBits(plain, byteOffset, 31, 1) !== 0) tempAdj = -tempAdj
  return { raw: raw, rawTemp: rawTemp, tempAdj: tempAdj }
}

function slotMgdl(raw, rawTemp, tempAdj, cal) {
  const factory = factoryGlucose(raw, rawTemp, tempAdj, cal)
  if (factory > 0) return factory
  return raw > 0 ? Math.round(raw / 10) : 0
}

/**
 * First trend sample from a decrypted BLE payload.
 * Uses FRAM factory calibration when present; otherwise raw/10 mg/dL.
 */
export function parseCurrent(plain, cal) {
  const wearMinutes = plain[40] | (plain[41] << 8)
  const slot = slotRawTempAdj(plain, 0)
  const mgdl = slotMgdl(slot.raw, slot.rawTemp, slot.tempAdj, cal)
  return {
    raw: slot.raw,
    rawTemp: slot.rawTemp,
    tempAdj: slot.tempAdj,
    wearMinutes,
    mgdl,
    mmol: mgdl / 18.0182,
    hasError: slot.raw === 0
  }
}

/** Seven trend slots from a decrypted BLE payload. Minute offsets: 0, 2, 4, 6, 7, 12, 15. */
export function parseTrend(plain, cal) {
  const offsets = [0, 2, 4, 6, 7, 12, 15]
  const out = []
  for (let i = 0; i < 7; i++) {
    const slot = slotRawTempAdj(plain, i * 4)
    if (!slot.raw) continue
    const mgdl = slotMgdl(slot.raw, slot.rawTemp, slot.tempAdj, cal)
    out.push({
      minutesAgo: offsets[i],
      raw: slot.raw,
      mgdl,
      mmol: mgdl / 18.0182
    })
  }
  return out
}

let CRC32_TABLE = null

/** Standard CRC-32 (IEEE, as java.util.zip.CRC32). Returns an unsigned number. */
export function crc32(bytes) {
  if (!CRC32_TABLE) {
    CRC32_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC32_TABLE[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Bytes of a string; non-ASCII characters are encoded as UTF-8. */
export function utf8Bytes(text) {
  const s = String(text == null ? '' : text)
  const out = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f)
      )
    }
  }
  return new Uint8Array(out)
}

/** Decode UTF-8 bytes (no TextDecoder on the watch). */
export function utf8Text(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++]
    let c
    if (b < 0x80) c = b
    else if (b < 0xe0) c = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f)
    else if (b < 0xf0) c = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
    else {
      c =
        ((b & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f)
    }
    if (c > 0xffff) {
      c -= 0x10000
      s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff))
    } else {
      s += String.fromCharCode(c)
    }
  }
  return s
}
