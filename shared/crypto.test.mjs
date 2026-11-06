import { hexToBytes, bytesToHex, streamingUnlockPayload, factoryGlucose, crc32, utf8Bytes, utf8Text } from './crypto.js'
import { parsePhoneAdvert, parsePhoneServiceData, matchPhoneAdvert, uuidTail, createFrameAssembler, frameBytes, advertName, isPhoneName } from './phone-frames.js'
import { parseScanJson } from './sensor-config.js'
import { fitCalPoints, applyCalFit, freshCalPoints, CAL_MAX_AGE_MS } from './cal-fit.js'

const cases = [
  {
    patch: '7F0E31017515',
    expected: {
      1: '2B0000002367DF1BD8BF7F54',
      2: '2C00000049EF1A546B4A2C08',
      3: '2D000000582CBD66A7981587'
    }
  },
  {
    // Counts past the 3 payloads the scanner precomputes are derived here, so
    // they must equal what Libre2Key would have sent (UnlockVectorsTest.kt).
    patch: '7F0E31017C0C',
    expected: {
      1: '2B0000001725B78CB287171F',
      2: '2C000000D083FEC70DF8C0C0',
      3: '2D000000CA7AE9DFE21B919F',
      4: '2E00000091E4E7300AC9EE76',
      5: '2F000000330DD10AE02DC770',
      6: '30000000B48DC56E29646C57'
    }
  },
  {
    // Real scan of 2026-09-02, where Libre2Key enabled streaming with a code of
    // its own rather than the 42 the tests above assume. The watch must derive
    // the same payloads from uid + patchInfo + code, or the sensor rejects it.
    patch: '7F0E31015E06',
    code: 111112,
    expected: {
      1: '09B2010005A56A6CABB5D111',
      2: '0AB201001C77FCA7750B43EC',
      3: '0BB201001CABF28E2C2415FF'
    }
  }
]

const uid = hexToBytes('73382A0D78007AE0')
let failed = 0

for (const { patch, expected, code } of cases) {
  const patchInfo = hexToBytes(patch)
  for (const [count, hex] of Object.entries(expected)) {
    const got = bytesToHex(streamingUnlockPayload(uid, patchInfo, code || 42, Number(count)))
    if (got !== hex) {
      console.error(`patch ${patch} count ${count}: got ${got} expected ${hex}`)
      failed++
    } else {
      console.log(`patch ${patch} count ${count}: OK`)
    }
  }
}

const scan = parseScanJson(`{
  "scannedAt": "2026-09-01T14:51:32+03:00",
  "serial": "3MH000TEST0",
  "uid": "73382A0D78007AE0",
  "patchInfo": "7F0E31017C0C",
  "bleAddress": "F8:05:84:00:00:01",
  "unlockCode": 42,
  "nextUnlockCount": 1,
  "bleService": "FDE3",
  "bleWriteCharacteristic": "F001",
  "bleNotifyCharacteristic": "F002",
  "unlockPayloads": [
    { "unlockCount": 1, "payload": "2B0000001725B78CB287171F" }
  ],
  "sensorStatus": { "maxLifeMinutes": 22378 }
}`)

if (
  scan.patchInfoHex !== '7F0E31017C0C' ||
  scan.bleAddress !== 'f8:05:84:00:00:01' ||
  scan.unlockCode !== 42 ||
  'payloads' in scan
) {
  console.error('parseScanJson mismatch', scan)
  failed++
} else {
  console.log('parseScanJson: OK')
}

const coded = parseScanJson(JSON.stringify({
  serial: '3MH000TEST0',
  uid: '73382A0D78007AE0',
  patchInfo: '7F0E31015E06',
  bleAddress: 'F8:05:84:00:00:01',
  unlockCode: '421',
  nextUnlockCount: '1'
}))
if (coded.unlockCode !== 421) {
  console.error('unlockCode 421 parsed as', coded.unlockCode)
  failed++
} else {
  console.log('parseScanJson unlockCode 421: OK')
}

const withCal = parseScanJson(JSON.stringify({
  serial: '3MH000TEST0',
  uid: '73382A0D78007AE0',
  patchInfo: '7F0E31017C0C',
  bleAddress: 'F8:05:84:00:00:01',
  unlockCode: 42,
  nextUnlockCount: 1,
  calibration: { i1: '1', i2: '8', i3: '0', i4: '6000', i5: '320', i6: '5000' }
}))
if (
  !withCal.calibration ||
  withCal.calibration.i2 !== 8 ||
  withCal.calibration.i4 !== 6000 ||
  withCal.calibration.i6 !== 5000
) {
  console.error('parseScanJson calibration mismatch', withCal.calibration)
  failed++
} else {
  console.log('parseScanJson calibration: OK')
}

const noCal = parseScanJson(JSON.stringify({
  serial: '3MH000TEST0',
  uid: '73382A0D78007AE0',
  patchInfo: '7F0E31017C0C',
  bleAddress: 'F8:05:84:00:00:01',
  unlockCode: 42,
  nextUnlockCount: 1
}))
if (noCal.calibration != null) {
  console.error('parseScanJson expected no calibration', noCal.calibration)
  failed++
} else {
  console.log('parseScanJson missing calibration: OK')
}

const badCal = parseScanJson(JSON.stringify({
  serial: '3MH000TEST0',
  uid: '73382A0D78007AE0',
  patchInfo: '7F0E31017C0C',
  bleAddress: 'F8:05:84:00:00:01',
  unlockCode: 42,
  nextUnlockCount: 1,
  calibration: { i1: '1', i2: '8', i3: '10', i4: '10', i5: '320', i6: '5000' }
}))
if (badCal.calibration != null) {
  console.error('parseScanJson accepted i4===i3', badCal.calibration)
  failed++
} else {
  console.log('parseScanJson rejects i4===i3: OK')
}

const cal = { i1: 1, i2: 8, i3: 0, i4: 6000, i5: 320, i6: 5000 }
const mgdl = factoryGlucose(900, 3800, 0, cal)
if (mgdl !== 134) {
  console.error('factoryGlucose expected 134 got', mgdl)
  failed++
} else {
  console.log('factoryGlucose 134: OK')
}
if (factoryGlucose(900, 3800, 0, null) !== 0) {
  console.error('factoryGlucose null cal should be 0')
  failed++
} else {
  console.log('factoryGlucose no cal: OK')
}

const none = fitCalPoints([])
if (none.a !== 1 || none.b !== 0 || none.n !== 0) {
  console.error('fit 0 points', none)
  failed++
} else {
  console.log('fit 0 points: OK')
}

const one = fitCalPoints([{ s: 6.5, r: 7.8 }])
if (one.a !== 1 || Math.abs(one.b - 1.3) > 1e-9 || one.n !== 1) {
  console.error('fit 1 point', one)
  failed++
} else {
  console.log('fit 1 point: OK')
}

const two = fitCalPoints([
  { s: 4.0, r: 4.0 },
  { s: 6.5, r: 7.8 }
])
if (two.a !== 1 || Math.abs(two.b - 0.65) > 1e-9 || two.n !== 2) {
  console.error('fit 2 points', two)
  failed++
} else {
  console.log('fit 2 points: OK')
}

const ident = fitCalPoints([
  { s: 4, r: 4 },
  { s: 6, r: 6 },
  { s: 8, r: 8 }
])
if (Math.abs(ident.a - 1) > 1e-9 || Math.abs(ident.b) > 1e-9 || ident.n !== 3) {
  console.error('fit 3 identity', ident)
  failed++
} else {
  console.log('fit 3 identity: OK')
}

const clamped = fitCalPoints([
  { s: 4, r: 4 },
  { s: 6, r: 20 },
  { s: 8, r: 36 }
])
if (clamped.a !== 1.25 || Math.abs(clamped.b - 12.5) > 1e-9 || clamped.n !== 3) {
  console.error('fit clamp', clamped)
  failed++
} else {
  console.log('fit clamp a=1.25: OK')
}

const narrow = fitCalPoints([
  { s: 6.0, r: 7.0 },
  { s: 6.5, r: 7.6 },
  { s: 7.0, r: 8.2 }
])
if (narrow.a !== 1 || Math.abs(narrow.b - 1.1) > 1e-9 || narrow.n !== 3) {
  console.error('fit 3 narrow offset-only', narrow)
  failed++
} else {
  console.log('fit 3 narrow offset-only: OK')
}

const clustered = fitCalPoints([
  { s: 6.5, r: 7.8 },
  { s: 6.8, r: 8.2 }
])
if (clustered.a !== 1 || Math.abs(clustered.b - 1.35) > 1e-9 || clustered.n !== 2) {
  console.error('fit clustered offset-only', clustered)
  failed++
} else {
  console.log('fit clustered offset-only: OK')
}

const flat = fitCalPoints([
  { s: 5, r: 6 },
  { s: 5, r: 8 }
])
if (flat.a !== 1 || Math.abs(flat.b - 2) > 1e-9) {
  console.error('fit zero variance', flat)
  failed++
} else {
  console.log('fit zero variance: OK')
}

const weightedAt = 1_700_000_000_000
const weighted = fitCalPoints(
  [
    { s: 6, r: 6, at: weightedAt - 16 * 60 * 60 * 1000 },
    { s: 6, r: 8, at: weightedAt }
  ],
  weightedAt
)
if (weighted.a !== 1 || Math.abs(weighted.b - 1.6) > 1e-9 || weighted.n !== 2) {
  console.error('fit recency weight', weighted)
  failed++
} else {
  console.log('fit recency weight: OK')
}

const slopeNow = 1_700_000_000_000
const weightedSlope = fitCalPoints(
  [
    { s: 4, r: 4, at: slopeNow },
    { s: 6, r: 20, at: slopeNow },
    { s: 8, r: 36, at: slopeNow }
  ],
  slopeNow
)
if (weightedSlope.a !== 1.25 || Math.abs(weightedSlope.b - 12.5) > 1e-9) {
  console.error('fit weighted slope clamp', weightedSlope)
  failed++
} else {
  console.log('fit weighted slope clamp: OK')
}

if (applyCalFit(6.5, { a: 1, b: 1.3 }) !== 7.8) {
  console.error('applyCalFit 6.5+1.3')
  failed++
} else {
  console.log('applyCalFit: OK')
}

const now = 1_700_000_000_000
const aged = freshCalPoints(
  [
    { s: 2.3, r: 5.1, at: now - CAL_MAX_AGE_MS - 1 },
    { s: 5.0, r: 5.2, at: now - 60 * 60 * 1000 },
    { s: 4.0, r: 4.1, at: 0 }
  ],
  now
)
if (
  aged.length !== 2 ||
  aged[0].s !== 5 ||
  aged[1].at !== 0
) {
  console.error('freshCalPoints age-out', aged)
  failed++
} else {
  console.log('freshCalPoints age-out: OK')
}

const deepCal = { i1: 1, i2: 560, i3: 0, i4: 6768, i5: 320, i6: 6800 }
const deepMgdl = factoryGlucose(1200, 6000, 0, deepCal)
if (deepMgdl !== 122) {
  console.error('factoryGlucose i2=560 expected 122 got', deepMgdl)
  failed++
} else {
  console.log('factoryGlucose i2=560: OK')
}

function parseUserCalJson(raw) {
  if (!raw) return { uid: '', points: [] }
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
}

const calJson = JSON.stringify({
  uid: '73382A0D78007AE0',
  points: [{ s: 6.5, r: 7.8, at: 1700000000000 }]
})
const roundTrip = parseUserCalJson(calJson)
if (
  roundTrip.uid !== '73382A0D78007AE0' ||
  roundTrip.points.length !== 1 ||
  roundTrip.points[0].s !== 6.5 ||
  roundTrip.points[0].r !== 7.8 ||
  roundTrip.points[0].at !== 1700000000000
) {
  console.error('user cal json round-trip', roundTrip)
  failed++
} else {
  console.log('user cal json round-trip: OK')
}

const emptyImport = parseUserCalJson('{"uid":"73382A0D78007AE0","points":[]}')
if (emptyImport.points.length !== 0) {
  console.error('user cal empty import', emptyImport)
  failed++
} else {
  console.log('user cal empty import: OK')
}


function check(name, ok, info) {
  if (ok) console.log(name + ': OK')
  else {
    console.error(name + ' FAILED', info === undefined ? '' : info)
    failed++
  }
}

// Same vector as BleFramingTest.kt on the phone.
check('crc32 check value', crc32(utf8Bytes('123456789')) === 0xcbf43926, crc32(utf8Bytes('123456789')).toString(16))
check('utf8 round trip', utf8Text(utf8Bytes('3MH · µ €')) === '3MH · µ €')

const bleJson = JSON.stringify({
  serial: '3MH000TEST0',
  uid: '73382A0D78007AE0',
  patchInfo: '7F0E31017C0C',
  bleAddress: 'F8:05:84:00:00:01',
  unlockCode: '42',
  nextUnlockCount: '1',
  calibration: { i1: '1', i2: '8', i3: '0', i4: '6000', i5: '320', i6: '5000' }
})
const bleBytes = utf8Bytes(bleJson)
// Frames exactly as ScanFrames.frames() builds them: [seq][total][18 bytes].
const frames = []
const totalFrames = Math.ceil(bleBytes.length / 18)
for (let i = 0; i < totalFrames; i++) {
  const part = bleBytes.slice(i * 18, i * 18 + 18)
  const f = new Uint8Array(part.length + 2)
  f[0] = i
  f[1] = totalFrames
  f.set(part, 2)
  frames.push(f)
}
check('frames fit 20 bytes', frames.every((f) => f.length <= 20))

const asm = createFrameAssembler()
let out = null
const order = frames.slice().reverse().concat([frames[0], frames[1]])
order.forEach((f) => {
  const r = asm.add(frameBytes(f.buffer, f.length))
  if (r) out = r
})
check('reassembly reorder + duplicates', out && utf8Text(out) === bleJson)
check('reassembled crc', out && crc32(out) === crc32(bleBytes))

const partial = createFrameAssembler()
let early = null
frames.slice(1).forEach((f) => {
  early = partial.add(f) || early
})
check('reassembly waits for missing frame', early === null && partial.received() === frames.length - 1)

const crcLe = crc32(bleBytes)
const crcHex = [0, 8, 16, 24].map((sh) => ((crcLe >>> sh) & 0xff).toString(16).padStart(2, '0')).join('')
const withCompany = 'ffff' + '414d5a43474d01' + crcHex
const adv = parsePhoneAdvert(withCompany)
check('advert with company id', adv && adv.crc === crcLe, adv)
check('advert without company id', parsePhoneAdvert('414D5A43474D01' + crcHex.toUpperCase()).crc === crcLe)
check('advert other vendor ignored', parsePhoneAdvert('4c000215aabbcc') === null)
check('frameBytes hex string', frameBytes('0102ff', 3).length === 3)

const svcHex = '01' + crcHex
check('service data parse', parsePhoneServiceData(svcHex).crc === crcLe)
check('service data wrong version', parsePhoneServiceData('02' + crcHex) === null)
check('uuidTail forms', uuidTail(0xac10) === 'AC10' && uuidTail('0000ac10-0000-1000-8000-00805f9b34fb') === 'AC10' && uuidTail('AC10') === 'AC10' && uuidTail('0000AC10') === 'AC10')
const viaSd = matchPhoneAdvert({ dev_addr: 'aa', service_data_array: [{ uuid: 'AC10', service_data: svcHex }] })
check('match via service data', viaSd && viaSd.via === 'service-data' && viaSd.crc === crcLe, viaSd)
const viaUuid = matchPhoneAdvert({ dev_addr: 'aa', uuid: 'ac10', vendor_data: withCompany })
check('match via uuid + vendor crc', viaUuid && viaUuid.via === 'uuid' && viaUuid.crc === crcLe, viaUuid)
const viaList = matchPhoneAdvert({ dev_addr: 'aa', service_uuid_array: ['0000ac10-0000-1000-8000-00805f9b34fb'] })
check('match via uuid list, crc unknown', viaList && viaList.via === 'uuid-list' && viaList.crc === null, viaList)
const viaVendor = matchPhoneAdvert({ dev_addr: 'aa', vendor_data: withCompany })
check('match via vendor only', viaVendor && viaVendor.via === 'vendor' && viaVendor.crc === crcLe, viaVendor)
check('no match on sensor advert', matchPhoneAdvert({ dev_addr: 'aa', uuid: 'fde3', dev_name: 'ABBOTT3MH' }) === null)
const viaName = matchPhoneAdvert({ dev_addr: 'aa', dev_name: 'AMZCGM' })
check('match via name, crc unknown', viaName && viaName.via === 'name' && viaName.crc === null, viaName)
const viaNameSd = matchPhoneAdvert({ dev_addr: 'aa', dev_name: 'amzcgm', service_data_array: [{ uuid: 'AC10', service_data: svcHex }] })
check('match via name with service-data crc', viaNameSd && viaNameSd.via === 'name' && viaNameSd.crc === crcLe, viaNameSd)
const nameBytes = new Uint8Array([65, 77, 90, 67, 71, 77, 0, 0]).buffer
check('name as bytes', advertName({ dev_name: nameBytes }) === 'AMZCGM' && matchPhoneAdvert({ dev_addr: 'aa', dev_name: nameBytes }).via === 'name')
check('isPhoneName rejects others', !isPhoneName('ABBOTT3MH') && !isPhoneName('') && isPhoneName('AMZCGM-x'))

process.exit(failed ? 1 : 0)
