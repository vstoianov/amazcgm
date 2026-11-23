import { align } from '@zos/ui'
import { W, H, ROUND, sp, rowInset, COLORS } from './index.s.layout.js'

// Watch-face view: date, big time, glucose + trend, delta/age, battery.
// One stack, centred vertically; the time gets the largest size that fits
// the screen (inside the circle on round watches).

const DATE_H = sp(36)
const GAP = sp(2)
export const FACE_GLU_SIZE = sp(88)
const GLU_H = sp(104)
const SUB_H = sp(36)
const BAT_GAP = sp(10)
const BAT_H = sp(30)
const EDGE = sp(12)
// "88:88" in the system font is about 2.8 em wide.
const TIME_EM_W = 2.8

function stackFor(ts) {
  const timeH = Math.round(ts * 1.04)
  const total = DATE_H + timeH + GAP + GLU_H + SUB_H + BAT_GAP + BAT_H
  const top = Math.max(ROUND ? sp(24) : sp(8), Math.round((H - total) / 2))
  const dateY = top
  const timeY = dateY + DATE_H
  const gluY = timeY + timeH + GAP
  const subY = gluY + GLU_H
  const batY = subY + SUB_H + BAT_GAP
  return { ts, timeH, dateY, timeY, gluY, subY, batY }
}

function timeFits(s) {
  const cy = s.timeY + Math.round(s.timeH / 2)
  const half = Math.round(s.ts * 0.36)
  const inset = rowInset(cy - half, cy + half)
  return W - 2 * (inset + EDGE) >= s.ts * TIME_EM_W
}

function fitStack() {
  let ts = sp(150)
  while (ts > sp(64) && !timeFits(stackFor(ts))) ts -= sp(2)
  return stackFor(ts)
}

const S = fitStack()

function centredRow(y, h) {
  const x = Math.max(EDGE, rowInset(y, y + h) + EDGE)
  return { x: x, y: y, w: W - x * 2, h: h }
}

export const FACE_DATE = {
  ...centredRow(S.dateY, DATE_H),
  color: COLORS.muted,
  text_size: sp(26),
  align_h: align.CENTER_H,
  align_v: align.BOTTOM,
  text: ''
}

// Full-width box: fitStack() already sized the glyphs to the screen edge at
// their own height; a box inset to its full height would clip them.
export const FACE_TIME = {
  x: 0,
  y: S.timeY,
  w: W,
  h: S.timeH,
  color: COLORS.text,
  text_size: S.ts,
  align_h: align.CENTER_H,
  align_v: align.CENTER_V,
  text: '--:--'
}

export const FACE_GLU_Y = S.gluY
export const FACE_GLU_H = GLU_H

export const FACE_GLUCOSE = {
  x: 0,
  y: S.gluY,
  w: W,
  h: GLU_H,
  color: COLORS.text,
  text_size: FACE_GLU_SIZE,
  align_h: align.CENTER_H,
  align_v: align.CENTER_V,
  text: '—'
}

export const FACE_TREND_SIZE = sp(64)
export const FACE_TREND_GAP = sp(12)

export const FACE_TREND = {
  x: Math.round(W / 2),
  y: S.gluY + Math.round((GLU_H - FACE_TREND_SIZE) / 2),
  w: FACE_TREND_SIZE,
  h: FACE_TREND_SIZE,
  auto_scale: true,
  src: 'trend/flat_ok.png'
}

export const FACE_SUB = {
  ...centredRow(S.subY, SUB_H),
  color: COLORS.muted,
  text_size: sp(22),
  align_h: align.CENTER_H,
  align_v: align.TOP,
  text: ''
}

// Battery: icon + percentage, centred as one group.
const BAT_BODY_W = sp(36)
const BAT_BODY_H = sp(18)
const BAT_NUB_W = sp(3)
const BAT_PCT_W = sp(64)
const BAT_GROUP_GAP = sp(8)
const BAT_GROUP_W = BAT_BODY_W + BAT_NUB_W + sp(2) + BAT_GROUP_GAP + BAT_PCT_W
const BAT_X = Math.round((W - BAT_GROUP_W) / 2)
const BAT_CY = S.batY + Math.round(BAT_H / 2)
const BAT_BODY_Y = BAT_CY - Math.round(BAT_BODY_H / 2)
const BAT_INSET = sp(3)

export const FACE_BAT_FILL_MAX = BAT_BODY_W - BAT_INSET * 2

export const FACE_BAT_BODY = {
  x: BAT_X,
  y: BAT_BODY_Y,
  w: BAT_BODY_W,
  h: BAT_BODY_H,
  radius: sp(3),
  color: COLORS.axis
}

export const FACE_BAT_CAVITY = {
  x: BAT_X + sp(2),
  y: BAT_BODY_Y + sp(2),
  w: BAT_BODY_W - sp(4),
  h: BAT_BODY_H - sp(4),
  radius: sp(2),
  color: COLORS.bg
}

export const FACE_BAT_FILL = {
  x: BAT_X + BAT_INSET,
  y: BAT_BODY_Y + BAT_INSET,
  w: 0,
  h: BAT_BODY_H - BAT_INSET * 2,
  radius: sp(1),
  color: COLORS.ok
}

export const FACE_BAT_NUB = {
  x: BAT_X + BAT_BODY_W + sp(1),
  y: BAT_BODY_Y + Math.round(BAT_BODY_H * 0.28),
  w: BAT_NUB_W,
  h: Math.round(BAT_BODY_H * 0.44),
  radius: sp(1),
  color: COLORS.axis
}

export const FACE_BAT_PCT = {
  x: BAT_X + BAT_BODY_W + BAT_NUB_W + sp(2) + BAT_GROUP_GAP,
  y: S.batY,
  w: BAT_PCT_W,
  h: BAT_H,
  color: COLORS.muted,
  text_size: sp(22),
  align_h: align.LEFT,
  align_v: align.CENTER_V,
  text: '--%'
}

// Tap target: the glucose row and the line under it.
export const FACE_TAP = {
  x: 0,
  y: S.gluY,
  w: W,
  h: GLU_H + SUB_H,
  color: COLORS.bg,
  text_size: sp(10),
  text: ''
}

/** Rough width of `text` at `size` in the system font (digits ~0.6 em). */
export function textWidth(text, size) {
  let em = 0
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '.' || c === ':' || c === ',') em += 0.3
    else if (c === '—' || c === '-') em += 0.7
    else em += 0.6
  }
  return Math.round(em * size)
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function fmtFaceDate(at) {
  const d = new Date(at)
  return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()]
}
