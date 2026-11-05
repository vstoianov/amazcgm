import { align, text_style } from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { px } from '@zos/utils'
import { getAlarms } from '../shared/session'

export const { width: W, height: H } = getDeviceInfo()

const minDim = Math.min(W || 432, H || 514)
export const SCALE = Math.max(0.8, Math.min(1.3, minDim / 432))

function sp(v) {
  return Math.max(1, Math.round(px(v) * SCALE))
}

// Text that must stay legible: px() and SCALE both shrink on narrow
// screens, so axis fonts get a floor in device pixels.
function spText(v, minPx) {
  return Math.max(Math.round(px(minPx)), sp(v))
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

export const CORNER_R = px(106)

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

// Vertical rhythm matching watchCGM GlanceScreen proportions
const TOP_PAD = Math.round(H * 0.045)
const STATUS_H = Math.round(H * 0.11)
const HERO_Y = TOP_PAD + STATUS_H
const HERO_H = Math.round(H * 0.20)
const SUB_Y = HERO_Y + HERO_H
const SUB_H = Math.round(H * 0.068)
const CHART_Y = SUB_Y + SUB_H + sp(4)
const CHART_BOTTOM = Math.max(sp(12), Math.round(H * 0.028))

const STATUS_CY = TOP_PAD + Math.round(STATUS_H / 2)
const DOT_R = sp(8)
const DOT_HALO_R = sp(12)

const topInset = cornerInset(TOP_PAD + sp(10))
const clockLeft = topInset + sp(8)
const clockRight = Math.round(W / 2) - DOT_HALO_R - sp(8)

export const CLOCK = {
  x: clockLeft,
  y: TOP_PAD,
  w: Math.max(sp(80), clockRight - clockLeft),
  h: STATUS_H,
  color: COLORS.text,
  text_size: sp(36),
  align_h: align.RIGHT,
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
const HERO_PAD_X = sp(16)
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
const CHART_MARGIN_X = sp(12)
export const CHART = {
  x: CHART_MARGIN_X,
  y: CHART_Y,
  w: W - CHART_MARGIN_X * 2,
  h: Math.max(sp(120), H - CHART_Y - CHART_BOTTOM),
  radius: sp(20)
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
