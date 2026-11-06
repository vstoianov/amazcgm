import { align, text_style } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { px } from '@zos/utils'
import { getAlarms } from '../shared/session'

export const { width: W, height: H } = getDeviceInfo()

// Every supported round watch (T-Rex 3 / 3 Pro, Balance 2, Active Max) has a
// square pixel grid; the Bip Max (432x514) does not.
export const ROUND = Math.abs((W || 0) - (H || 0)) < 4

// One scale factor for the whole UI, designed at 432 px (Bip Max). A round
// screen loses its corners, so it gets slightly smaller elements. px() is
// not used here: it already scales by designWidth and would scale twice.
const minDim = Math.min(W || 432, H || 514)
export const SCALE = Math.max(0.8, Math.min(1.3, (minDim / 432) * (ROUND ? 0.92 : 1)))

export function sp(v) {
  return Math.max(1, Math.round(v * SCALE))
}

// Text that must stay legible gets a floor in device pixels.
export function spText(v, minPx) {
  return Math.max(minPx, sp(v))
}

export const COLORS = {
  bg: 0x000000,
  text: 0xffffff,
  muted: 0x8aa4b0,
  axis: 0x5c6b73,
  axisText: 0xc5d3da,
  ok: 0x4caf7a,
  warn: 0xe6b325,
  bad: 0xe05c5c,
  accent: 0x4fc3f7,
  button: 0x1b6b7a,
  card: 0x121c20,
  cardHi: 0x1a2a32,
  chartBg: 0x0a1214,
  chartLine: 0x4fc3f7,
  band: 0x0a2a21,
  grid: 0x1c262c,
  nowLine: 0x4fc3f7
}

export function glucoseColor(mmol) {
  if (!mmol) return COLORS.muted
  const a = getAlarms()
  const low = (a && a.low && a.low.mmol) || 3.9
  const high = (a && a.high && a.high.mmol) || 10.0
  if (mmol <= low) return COLORS.bad
  if (mmol >= high) return COLORS.warn
  return COLORS.ok
}

export const CORNER_R = 106

export function cornerInset(y) {
  const r = CORNER_R
  if (y < r) {
    const dy = r - y
    return Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy)))
  }
  if (y > H - r) {
    const dy = y - (H - r)
    return Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy)))
  }
  return 0
}

/** Pixels lost to the screen edge at row y (circle or rounded corners). */
export function edgeInset(y) {
  if (!ROUND) return cornerInset(y)
  const r = W / 2
  const dy = y - H / 2
  return Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy)))
}

/** Side margin that keeps a horizontal band y1..y2 fully on screen. */
export function rowInset(y1, y2) {
  return Math.max(edgeInset(y1), edgeInset(y2))
}

export const CHART_MIN = 2
export const CHART_MAX = 12
export const CHART_TOP_MAX = 20
export const CHART_TICKS = [2, 4, 6, 8, 10, 12]
export const CHART_TICKS_TALL = [2, 5, 10, 15, 20]
export const CHART_HOURS = 72
export const CHART_WINDOWS = [180, 360, 720]
// Axis labels. Everything here is sp()-based so it follows the screen size.
export const CHART_SCALE_SIZE = spText(27, 22)
export const CHART_SCALE_LABEL_H = CHART_SCALE_SIZE + sp(8)
export const CHART_SCALE_PAD_R = sp(12)
export const CHART_GUTTER = sp(56)
export const CHART_AXIS_INSET = sp(4)
export const CHART_AXIS_SIZE = spText(24, 20)
export const CHART_AXIS_LABEL_W = sp(74)
export const CHART_PAD_L = sp(10)
export const CHART_LINE_W = Math.max(2, sp(3))
export const CHART_DOT_R = Math.max(3, sp(5))
export const CHART_DOT_HALO_R = CHART_DOT_R + Math.max(1, sp(2))

// Status row: clock left of the centre dot, battery right of it.
const DOT_R = sp(8)
const DOT_HALO_R = sp(12)
const CLOCK_SIZE_MAX = Math.round(sp(36) * 1.5)
// "88:88" is about 2.8 em wide in the system font.
const CLOCK_EM_W = 2.8
const CLOCK_GAP = sp(10)
const EDGE_PAD = sp(8)

// Glyph band of a clock of `size` centred at cy, and the width left for it
// between the screen edge and the status dot.
function clockRoom(cy, size) {
  const half = Math.round(size * 0.36)
  const inset = rowInset(cy - half, cy + half)
  return Math.round(W / 2) - DOT_HALO_R - CLOCK_GAP - (inset + EDGE_PAD)
}

function statusHeight(size) {
  return Math.max(Math.round(H * 0.11), size + sp(6))
}

// Move the row down (round screens only) until the full-size clock fits,
// then shrink the clock if it still does not.
function fitStatusRow() {
  const size = CLOCK_SIZE_MAX
  const need = Math.ceil(size * CLOCK_EM_W)
  const statusH = statusHeight(size)
  let top = Math.round(H * 0.045)
  const maxTop = ROUND ? Math.round(H * 0.17) : top
  while (top < maxTop && clockRoom(top + Math.round(statusH / 2), size) < need) {
    top += sp(2)
  }
  const room = clockRoom(top + Math.round(statusH / 2), size)
  const fitted = Math.max(sp(28), Math.min(size, Math.floor(room / CLOCK_EM_W)))
  return { top: top, size: fitted, statusH: statusHeight(fitted) }
}

const STATUS_FIT = fitStatusRow()

// Vertical rhythm matching watchCGM GlanceScreen proportions
const TOP_PAD = STATUS_FIT.top
const STATUS_H = STATUS_FIT.statusH
const HERO_Y = TOP_PAD + STATUS_H
const HERO_H = Math.round(H * (ROUND ? 0.18 : 0.2))
const SUB_Y = HERO_Y + HERO_H
const SUB_H = Math.round(H * 0.068)
const CHART_Y = SUB_Y + SUB_H + sp(4)
const CHART_BOTTOM = ROUND
  ? Math.round(H * 0.11)
  : Math.max(sp(12), Math.round(H * 0.028))

const STATUS_CY = TOP_PAD + Math.round(STATUS_H / 2)
const CLOCK_SIZE = STATUS_FIT.size
const STATUS_HALF = Math.round(CLOCK_SIZE * 0.36)
const topInset = rowInset(STATUS_CY - STATUS_HALF, STATUS_CY + STATUS_HALF)
const clockLeft = topInset + EDGE_PAD
const clockRight = Math.round(W / 2) - DOT_HALO_R - CLOCK_GAP

export const CLOCK = {
  x: clockLeft,
  y: TOP_PAD,
  w: Math.max(sp(80), clockRight - clockLeft),
  h: STATUS_H,
  color: COLORS.text,
  text_size: CLOCK_SIZE,
  align_h: align.LEFT,
  align_v: align.CENTER_V,
  text: '--:--'
}

export const STATUS_DOT_HALO = {
  center_x: Math.round(W / 2),
  center_y: STATUS_CY,
  radius: DOT_HALO_R
}

export const STATUS_DOT = {
  center_x: Math.round(W / 2),
  center_y: STATUS_CY,
  radius: DOT_R
}

export const STATUS_DOT_FALLBACK = {
  x: Math.round(W / 2) - DOT_R,
  y: STATUS_CY - DOT_R,
  w: DOT_R * 2,
  h: DOT_R * 2,
  radius: DOT_R
}

const BAT_RIGHT = W - topInset - sp(12)
const BAT_NUB_W = sp(4)
const BAT_BODY_W = sp(46)
const BAT_BODY_H = sp(22)
const BAT_BODY_Y = STATUS_CY - Math.round(BAT_BODY_H / 2)
const BAT_BODY_X = BAT_RIGHT - BAT_NUB_W - sp(2) - BAT_BODY_W
const BAT_INSET = sp(3)

export const BATTERY_FILL_MAX = BAT_BODY_W - BAT_INSET * 2

export const BATTERY_BODY = {
  x: BAT_BODY_X,
  y: BAT_BODY_Y,
  w: BAT_BODY_W,
  h: BAT_BODY_H,
  radius: sp(4),
  color: COLORS.axis
}

export const BATTERY_CAVITY = {
  x: BAT_BODY_X + sp(2),
  y: BAT_BODY_Y + sp(2),
  w: BAT_BODY_W - sp(4),
  h: BAT_BODY_H - sp(4),
  radius: sp(2),
  color: COLORS.bg
}

export const BATTERY_FILL = {
  x: BAT_BODY_X + BAT_INSET,
  y: BAT_BODY_Y + BAT_INSET,
  w: 0,
  h: BAT_BODY_H - BAT_INSET * 2,
  radius: sp(2),
  color: COLORS.ok
}

export const BATTERY_NUB = {
  x: BAT_RIGHT - BAT_NUB_W,
  y: BAT_BODY_Y + Math.round(BAT_BODY_H * 0.27),
  w: BAT_NUB_W,
  h: Math.round(BAT_BODY_H * 0.46),
  radius: sp(2),
  color: COLORS.axis
}

const batPctLeft = Math.round(W / 2) + DOT_HALO_R + sp(6)
export const BATTERY_PCT = {
  x: batPctLeft,
  y: TOP_PAD,
  w: Math.max(sp(48), BAT_BODY_X - sp(6) - batPctLeft),
  h: STATUS_H,
  color: COLORS.ok,
  text_size: sp(24),
  align_h: align.RIGHT,
  align_v: align.CENTER_V,
  text: '--%'
}

// 2. Hero Row: Gear button on left, Glucose centered on watch axis, Trend on right
const SIDE_SLOT = sp(72)
// Side padding of the hero row: clear of the screen edge across its height.
const HERO_PAD_X = Math.max(sp(16), rowInset(HERO_Y, HERO_Y + HERO_H) + EDGE_PAD)
const HERO_CY = HERO_Y + Math.round(HERO_H / 2)

const GEAR_ICON_SIZE = sp(54)
export const GEAR_IMG = {
  x: HERO_PAD_X + Math.round((SIDE_SLOT - GEAR_ICON_SIZE) / 2),
  y: HERO_CY - Math.round(GEAR_ICON_SIZE / 2),
  w: GEAR_ICON_SIZE,
  h: GEAR_ICON_SIZE,
  auto_scale: true,
  src: 'settings.png'
}

export const GEAR_TAP = {
  x: 0,
  y: HERO_Y,
  w: HERO_PAD_X + SIDE_SLOT + sp(10),
  h: HERO_H,
  color: COLORS.bg,
  text_size: px(1),
  text: ''
}

const GLUCOSE_X = HERO_PAD_X + SIDE_SLOT + sp(4)
const GLUCOSE_W = W - GLUCOSE_X * 2

export const GLUCOSE = {
  x: GLUCOSE_X,
  y: HERO_Y,
  w: GLUCOSE_W,
  h: HERO_H,
  color: COLORS.text,
  text_size: sp(88),
  align_h: align.CENTER_H,
  align_v: align.CENTER_V,
  text: '—'
}

const TREND_SLOT_X = W - HERO_PAD_X - SIDE_SLOT
const TREND_SIZE = sp(72)

export const TREND_IMG = {
  x: TREND_SLOT_X + Math.round((SIDE_SLOT - TREND_SIZE) / 2),
  y: HERO_CY - Math.round(TREND_SIZE / 2),
  w: TREND_SIZE,
  h: TREND_SIZE,
  auto_scale: true
}

export const UNIT_FALLBACK = {
  x: TREND_SLOT_X,
  y: HERO_Y,
  w: SIDE_SLOT,
  h: HERO_H,
  color: COLORS.muted,
  text_size: sp(20),
  align_h: align.CENTER_H,
  align_v: align.CENTER_V,
  text: 'mmol'
}

export function trendColorKey(color) {
  if (color === COLORS.bad) return 'bad'
  if (color === COLORS.warn) return 'warn'
  return 'ok'
}

export function trendSrc(level, colorKey) {
  if (!level) return ''
  return 'trend/' + level + '_' + colorKey + '.png'
}

// 3. Delta / Status Subtitle Row near the widest part of the screen
export const DELTA = {
  x: sp(20),
  y: SUB_Y,
  w: W - sp(40),
  h: SUB_H,
  color: COLORS.muted,
  text_size: sp(23),
  align_h: align.CENTER_H,
  align_v: align.CENTER_V,
  text: ''
}

// 4. Glucose Chart Card in lower half
const CHART_RADIUS = sp(20)
const CHART_H = Math.max(sp(120), H - CHART_Y - CHART_BOTTOM)
// Round screens: keep the card inside the circle. The card's own rounded
// corners sit inside the edge, so test half a radius in. The Bip Max card
// already follows its screen corners with its radius.
const CHART_MARGIN_X = ROUND
  ? Math.max(
      sp(12),
      rowInset(CHART_Y + CHART_RADIUS / 2, CHART_Y + CHART_H - CHART_RADIUS / 2) + sp(4)
    )
  : sp(12)
export const CHART = {
  x: CHART_MARGIN_X,
  y: CHART_Y,
  w: W - CHART_MARGIN_X * 2,
  h: CHART_H,
  radius: CHART_RADIUS
}

export const CHART_PAD_T = sp(8)
export const CHART_HOUR_H = sp(30)
export const CHART_PAD_B = CHART_HOUR_H + sp(6)

export const STATUS = {
  x: CHART.x + sp(14),
  y: CHART.y + sp(12),
  w: CHART.w - sp(28) - CHART_GUTTER,
  h: sp(52),
  color: COLORS.axis,
  text_size: sp(19),
  align_h: align.LEFT,
  align_v: align.TOP,
  text_style: text_style.WRAP,
  text: 'Hold near the sensor'
}

const axisY = CHART.y + CHART.h - CHART_PAD_B + sp(2)
export const CHART_AXIS = {
  y: axisY,
  h: CHART_HOUR_H,
  color: COLORS.axisText,
  text_size: CHART_AXIS_SIZE,
  align_v: align.CENTER_V,
  text: ''
}

export const GLANCE_TAP = {
  x: HERO_PAD_X + SIDE_SLOT + sp(10),
  y: HERO_Y,
  w: W - (HERO_PAD_X + SIDE_SLOT + sp(10)),
  h: HERO_H + SUB_H,
  color: COLORS.bg,
  text_size: px(1),
  text: ''
}

export const CHART_TAP = {
  x: CHART.x,
  y: CHART.y,
  w: CHART.w,
  h: CHART.h,
  color: COLORS.bg,
  text_size: px(1),
  text: ''
}
