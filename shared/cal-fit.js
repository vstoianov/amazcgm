/** Drop fingerstick points older than two days. Newer points already outweigh them. */
export const CAL_MAX_AGE_MS = 48 * 60 * 60 * 1000

const CAL_HALF_LIFE_MS = 8 * 60 * 60 * 1000
const CAL_MIN_WEIGHT = 0.1

function pointWeight(at, now) {
  const t = Number(at)
  if (!Number.isFinite(t) || t <= 0) return 1
  const age = now - t
  if (age <= 0) return 1
  const w = Math.pow(0.5, age / CAL_HALF_LIFE_MS)
  return w < CAL_MIN_WEIGHT ? CAL_MIN_WEIGHT : w
}

export function freshCalPoints(points, now, maxAgeMs) {
  const limit = maxAgeMs == null ? CAL_MAX_AGE_MS : maxAgeMs
  const t = Number(now)
  const clock = Number.isFinite(t) && t > 0 ? t : Date.now()
  const src = points || []
  const out = []
  for (let i = 0; i < src.length; i++) {
    const p = src[i]
    const at = Number(p && p.at)
    if (Number.isFinite(at) && at > 0 && clock - at > limit) continue
    out.push(p)
  }
  return out
}

/** Weighted least-squares user calibration: displayed = a * sensor + b. */

export function fitCalPoints(points, now) {
  const src = points || []
  const n = src.length
  if (!n) return { a: 1, b: 0, n: 0 }
  const clock = Number(now)
  const tNow = Number.isFinite(clock) && clock > 0 ? clock : Date.now()
  let minS = src[0].s
  let maxS = src[0].s
  let sumW = 0
  let sumWOff = 0
  for (let i = 0; i < n; i++) {
    const s = src[i].s
    if (s < minS) minS = s
    if (s > maxS) maxS = s
    const w = pointWeight(src[i].at, tNow)
    sumW += w
    sumWOff += w * (src[i].r - s)
  }
  // Two close points make a wild slope. Stay offset-only until the
  // fingersticks actually span a range.
  if (n < 3 || maxS - minS < 3) {
    return { a: 1, b: sumW ? sumWOff / sumW : 0, n: n }
  }
  let sumWS = 0
  let sumWR = 0
  let sumWSS = 0
  let sumWSR = 0
  for (let i = 0; i < n; i++) {
    const s = src[i].s
    const r = src[i].r
    const w = pointWeight(src[i].at, tNow)
    sumWS += w * s
    sumWR += w * r
    sumWSS += w * s * s
    sumWSR += w * s * r
  }
  const den = sumW * sumWSS - sumWS * sumWS
  let a
  let b
  if (Math.abs(den) < 1e-9 || !sumW) {
    a = 1
    b = sumW ? (sumWR - sumWS) / sumW : 0
  } else {
    a = (sumW * sumWSR - sumWS * sumWR) / den
    if (a < 0.8) a = 0.8
    else if (a > 1.25) a = 1.25
    b = (sumWR - a * sumWS) / sumW
  }
  return { a: a, b: b, n: n }
}

export function applyCalFit(mmol, fit) {
  const f = fit || { a: 1, b: 0 }
  const v = f.a * Number(mmol) + f.b
  const rounded = Math.round(v * 10) / 10
  return rounded > 0 ? rounded : 0
}
