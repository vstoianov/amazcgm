import { align, text_style } from '@zos/ui'
import { W, H, ROUND, sp, rowInset } from './index.s.layout.js'

export { W, H }

const COLORS = {
  text: 0xffffff,
  muted: 0x8aa4b0,
  accent: 0x4fc3f7,
  button: 0x1b6b7a,
  card: 0x121c20,
  cardHi: 0x1a2a32
}

// Round screens: content column narrower, title and Back button moved in
// from the top and bottom edge of the circle.
const INSET_X = Math.max(sp(24), Math.round(W * (ROUND ? 0.14 : 0.065)))
const CONTENT_W = W - INSET_X * 2
const TITLE_Y = Math.round(H * (ROUND ? 0.075 : 0.028))
const TITLE_H = Math.round(H * 0.072)
const BACK_H = Math.round(H * 0.10)
const BACK_Y = H - BACK_H - Math.round(H * (ROUND ? 0.07 : 0.024))

// Left edge for a band y..y+h. Round screens keep it inside the circle; the
// Bip Max layout keeps its original margins.
function bandX(y, h, minX) {
  if (!ROUND) return minX
  return Math.max(minX, rowInset(y, y + h) + sp(8))
}

const TITLE_X = bandX(TITLE_Y, TITLE_H, sp(24))

function screenTitle(text) {
  return {
    x: TITLE_X,
    y: TITLE_Y,
    w: W - TITLE_X * 2,
    h: TITLE_H,
    color: COLORS.accent,
    text_size: sp(28),
    align_h: align.CENTER_H,
    align_v: align.CENTER_V,
    text: text
  }
}

function backButton(y) {
  const top = y != null ? y : BACK_Y
  const x = bandX(top, BACK_H, INSET_X)
  return {
    x: x,
    y: top,
    w: W - x * 2,
    h: BACK_H,
    radius: Math.round(BACK_H / 2),
    normal_color: COLORS.cardHi,
    press_color: COLORS.card,
    text: 'Back',
    text_size: sp(24),
    color: COLORS.text
  }
}

export const TITLE = screenTitle('AmazCGM')

// One-time first-start notice
export const NOTICE_TITLE = screenTitle('Before you start')
export const NOTICE_TEXT = {
  x: INSET_X,
  y: TITLE_Y + TITLE_H + sp(8),
  w: CONTENT_W,
  h: BACK_Y - (TITLE_Y + TITLE_H + sp(8)) - sp(12),
  color: COLORS.text,
  text_size: sp(22),
  align_h: align.CENTER_H,
  align_v: align.CENTER_V,
  text_style: text_style.WRAP,
  text:
    'AmazCGM is not a medical device. Readings can be late, wrong or missing.\n\n' +
    'Do not make treatment decisions from this watch. Confirm with your official ' +
    'reader or a finger-stick.\n\nUse at your own risk.'
}
export const NOTICE_OK_BTN = { ...backButton(), text: 'I understand' }

export const MENU_LIST = {
  x: INSET_X,
  y: TITLE_Y + TITLE_H + sp(6),
  w: CONTENT_W,
  h: H - (TITLE_Y + TITLE_H + sp(14)) - (ROUND ? Math.round(H * 0.06) : 0)
}

export const MENU_ITEM_H = Math.round(H * 0.175)
export const MENU_ITEM_SPACE = sp(12)

export const MENU_ITEMS = [
  { label: 'Sync from phone', sub: 'Bluetooth from AmazCGM for Android' },
  { label: 'Chart range', sub: '3 hours' },
  { label: 'Alarms', sub: '3.9 – 10.0 mmol/L' },
  { label: 'Calibrate', sub: 'Blood glucose ref' },
  { label: 'Info', sub: 'Sensor & status' },
  { label: 'Send log', sub: 'Diagnostics' },
  { label: 'Back', sub: 'Return to chart' }
]

export function buildMenuItems(meta) {
  const m = meta || {}
  return [
    { label: 'Sync from phone', sub: m.syncSub || 'Bluetooth from AmazCGM for Android' },
    { label: 'Chart range', sub: m.rangeSub || '3 hours' },
    { label: 'Alarms', sub: m.alarmsSub || '3.9 – 10.0 mmol/L' },
    { label: 'Calibrate', sub: m.calSub || 'Blood glucose ref' },
    { label: 'Info', sub: m.infoSub || 'Sensor & status' },
    { label: 'Send log', sub: 'Diagnostics' },
    { label: 'Nearby devices', sub: m.nearbySub || 'Seen by the last sync' },
    { label: 'Back', sub: 'Return to chart' }
  ]
}

/** Rows for the "Nearby devices" screen; the last row returns to the menu. */
export function nearbyItems(sample) {
  const rows = (sample || []).map((d) => ({
    label: (d.name || ('…' + String(d.mac || '').slice(-8))).slice(0, 16),
    sub:
      (d.svc ? 'svc ' + d.svc : d.sdUuid ? 'sd ' + d.sdUuid : 'no uuid') +
      ' · ' + (d.rssi != null ? d.rssi + ' dB' : '') +
      (d.phase ? ' · p' + d.phase : '')
  }))
  if (!rows.length) rows.push({ label: 'Nothing seen', sub: 'Run Sync from phone first' })
  rows.push({ label: 'Back', sub: 'Return to menu' })
  return rows
}

export function menuListProps(onClick, items) {
  const data = items && items.length ? items : MENU_ITEMS
  const labelH = Math.round(MENU_ITEM_H * 0.52)
  const subH = MENU_ITEM_H - labelH - sp(8)
  return {
    x: MENU_LIST.x,
    y: MENU_LIST.y,
    w: MENU_LIST.w,
    h: MENU_LIST.h,
    item_space: MENU_ITEM_SPACE,
    item_config: [
      {
        type_id: 1,
        item_height: MENU_ITEM_H,
        item_bg_color: COLORS.card,
        item_bg_radius: sp(26),
        text_view: [
          {
            x: sp(18),
            y: sp(6),
            w: MENU_LIST.w - sp(36),
            h: labelH,
            key: 'label',
            color: COLORS.text,
            text_size: sp(26),
            align_h: align.CENTER_H,
            align_v: align.BOTTOM
          },
          {
            x: sp(18),
            y: labelH + sp(2),
            w: MENU_LIST.w - sp(36),
            h: subH,
            key: 'sub',
            color: COLORS.muted,
            text_size: sp(18),
            align_h: align.CENTER_H,
            align_v: align.TOP
          }
        ],
        text_view_count: 2
      }
    ],
    item_config_count: 1,
    data_array: data,
    data_count: data.length,
    data_type_config: [
      {
        start: 0,
        end: data.length - 1,
        type_id: 1
      }
    ],
    data_type_config_count: 1,
    item_click_func: onClick
  }
}

export const CHIP_ON = {
  normal_color: COLORS.accent,
  press_color: 0x3aa8d4,
  color: 0x081418
}

export const CHIP_OFF = {
  normal_color: COLORS.card,
  press_color: COLORS.cardHi,
  color: COLORS.text
}

// Chart Range Screen
export const TF_TITLE = screenTitle('Chart range')

const TF_AREA_TOP = TITLE_Y + TITLE_H + sp(12)
const TF_AREA_H = BACK_Y - TF_AREA_TOP - sp(12)
const TF_CHIP_GAP = sp(14)
const TF_CHIP_H = Math.max(sp(60), Math.floor((TF_AREA_H - TF_CHIP_GAP * 2) / 3))

function tfChip(i, text) {
  return {
    x: INSET_X,
    y: TF_AREA_TOP + (TF_CHIP_H + TF_CHIP_GAP) * i,
    w: CONTENT_W,
    h: TF_CHIP_H,
    radius: Math.round(TF_CHIP_H / 2),
    text: text,
    text_size: sp(30),
    color: COLORS.text
  }
}

export const TF_CHIPS = [tfChip(0, '3 hours'), tfChip(1, '6 hours'), tfChip(2, '12 hours')]
export const TF_BACK_BTN = backButton()

// Sensor Info Screen
export const INFO_TITLE = screenTitle('Sensor info')

const INFO_AREA_TOP = TITLE_Y + TITLE_H + sp(2)
const INFO_AREA_H = BACK_Y - INFO_AREA_TOP - sp(6)
const INFO_ROW_STEP = Math.floor(INFO_AREA_H / 5)
const INFO_LBL_H = Math.round(INFO_ROW_STEP * 0.36)
const INFO_VAL_H = INFO_ROW_STEP - INFO_LBL_H

function infoRow(idx, labelText) {
  const y0 = INFO_AREA_TOP + idx * INFO_ROW_STEP
  return {
    label: {
      x: INSET_X,
      y: y0,
      w: CONTENT_W,
      h: INFO_LBL_H,
      color: COLORS.muted,
      text_size: sp(17),
      align_h: align.CENTER_H,
      align_v: align.BOTTOM,
      text: labelText
    },
    value: {
      x: INSET_X,
      y: y0 + INFO_LBL_H,
      w: CONTENT_W,
      h: INFO_VAL_H,
      color: COLORS.text,
      text_size: sp(24),
      align_h: align.CENTER_H,
      align_v: align.TOP,
      text: ''
    }
  }
}

export const INFO_ROWS = [
  infoRow(0, 'Serial'),
  infoRow(1, 'Code · Count'),
  infoRow(2, 'Patch'),
  infoRow(3, 'Calibration'),
  infoRow(4, 'History')
]

export const INFO_BACK_BTN = backButton()

// Calibration Screen
export const CAL_TITLE = screenTitle('Calibrate')

const CAL_TOP = TITLE_Y + TITLE_H
const CAL_HINT_H = Math.round(H * 0.044)
const CAL_SENSOR_H = Math.round(H * 0.052)
const CAL_REF_H = Math.round(H * 0.135)

// Full-width text row; on round screens it is kept inside the circle.
function calRow(y, h) {
  const x = ROUND ? bandX(y, h, INSET_X) : sp(16)
  return { x: x, y: y, w: W - x * 2, h: h }
}

export const CAL_HINT = {
  ...calRow(CAL_TOP, CAL_HINT_H),
  color: COLORS.muted,
  text_size: sp(17),
  align_h: align.CENTER_H,
  align_v: align.CENTER_V,
  text: 'Calibrate when trend is flat'
}

export const CAL_SENSOR = {
  ...calRow(CAL_TOP + CAL_HINT_H, CAL_SENSOR_H),
  color: COLORS.muted,
  text_size: sp(21),
  align_h: align.CENTER_H,
  align_v: align.CENTER_V,
  text: ''
}

export const CAL_REF = {
  ...calRow(CAL_TOP + CAL_HINT_H + CAL_SENSOR_H, CAL_REF_H),
  color: COLORS.text,
  text_size: sp(60),
  align_h: align.CENTER_H,
  align_v: align.CENTER_V,
  text: '--.-'
}

const STEP_Y = CAL_TOP + CAL_HINT_H + CAL_SENSOR_H + CAL_REF_H + sp(6)
const STEP_H = Math.round(H * 0.105)
const STEP_GAP = sp(10)
const STEP_W = Math.floor((CONTENT_W - STEP_GAP * 3) / 4)

function calStep(i, text, delta) {
  return {
    x: INSET_X + (STEP_W + STEP_GAP) * i,
    y: STEP_Y,
    w: STEP_W,
    h: STEP_H,
    radius: sp(18),
    normal_color: COLORS.card,
    press_color: COLORS.cardHi,
    text: text,
    text_size: sp(23),
    color: COLORS.text,
    delta: delta
  }
}

export const CAL_STEPS = [
  calStep(0, '-1', -1),
  calStep(1, '-0.1', -0.1),
  calStep(2, '+0.1', 0.1),
  calStep(3, '+1', 1)
]

const CAL_ACT_Y = STEP_Y + STEP_H + sp(12)
const CAL_ACT_H = Math.round(H * 0.115)
const CAL_HALF_W = Math.floor((CONTENT_W - STEP_GAP) / 2)

export const CAL_SAVE_BTN = {
  x: INSET_X,
  y: CAL_ACT_Y,
  w: CAL_HALF_W,
  h: CAL_ACT_H,
  radius: Math.round(CAL_ACT_H / 2),
  normal_color: COLORS.button,
  press_color: 0x145560,
  text: 'Save',
  text_size: sp(23),
  color: COLORS.text
}

export const CAL_CLEAR_BTN = {
  x: INSET_X + CAL_HALF_W + STEP_GAP,
  y: CAL_ACT_Y,
  w: CAL_HALF_W,
  h: CAL_ACT_H,
  radius: Math.round(CAL_ACT_H / 2),
  normal_color: COLORS.card,
  press_color: COLORS.cardHi,
  text: 'Clear cal',
  text_size: sp(23),
  color: COLORS.text
}

export const CAL_BACK_BTN = backButton(CAL_ACT_Y + CAL_ACT_H + sp(12))

// Alarms Screen (scrollable container)
export const ALARM_TITLE = screenTitle('Alarms')

const ALARM_ROW_H = Math.round(H * 0.13)
const ALARM_ROW_GAP = sp(12)
const ALARM_SEC_GAP = sp(22)
const ALARM_STEP_GAP = sp(10)
const ALARM_STEP_W = Math.floor((CONTENT_W - ALARM_STEP_GAP * 3) / 4)
const ALARM_LABEL_H = sp(26)
const ALARM_VALUE_H = sp(46)
const ALARM_SEC_H =
  ALARM_LABEL_H +
  ALARM_VALUE_H +
  sp(8) +
  ALARM_ROW_H * 3 +
  ALARM_ROW_GAP * 2
const ALARM_LOW_TOP = TITLE_Y + TITLE_H + sp(8)
const ALARM_HIGH_TOP = ALARM_LOW_TOP + ALARM_SEC_H + ALARM_SEC_GAP
const ALARM_TEST_Y = ALARM_HIGH_TOP + ALARM_SEC_H + ALARM_SEC_GAP
const ALARM_BACK_Y = ALARM_TEST_Y + ALARM_ROW_H + ALARM_ROW_GAP

function alarmStep(i, text, delta, y) {
  return {
    x: INSET_X + (ALARM_STEP_W + ALARM_STEP_GAP) * i,
    y: y,
    w: ALARM_STEP_W,
    h: ALARM_ROW_H,
    radius: sp(22),
    normal_color: COLORS.card,
    press_color: COLORS.cardHi,
    text: text,
    text_size: sp(26),
    color: COLORS.text,
    delta: delta
  }
}

function alarmSection(top, label) {
  const stepY = top + ALARM_LABEL_H + ALARM_VALUE_H + sp(8)
  const soundY = stepY + ALARM_ROW_H + ALARM_ROW_GAP
  const durY = soundY + ALARM_ROW_H + ALARM_ROW_GAP
  const durBtnW = sp(96)
  const durGap = sp(14)
  const durTextW = CONTENT_W - durBtnW * 2 - durGap * 2
  const durX0 = INSET_X
  return {
    label: {
      x: INSET_X,
      y: top,
      w: CONTENT_W,
      h: ALARM_LABEL_H,
      color: COLORS.muted,
      text_size: sp(20),
      align_h: align.CENTER_H,
      text: label
    },
    value: {
      x: INSET_X,
      y: top + ALARM_LABEL_H,
      w: CONTENT_W,
      h: ALARM_VALUE_H,
      color: COLORS.text,
      text_size: sp(38),
      align_h: align.CENTER_H,
      align_v: align.CENTER_V,
      text: ''
    },
    steps: [
      alarmStep(0, '-1', -1, stepY),
      alarmStep(1, '-0.1', -0.1, stepY),
      alarmStep(2, '+0.1', 0.1, stepY),
      alarmStep(3, '+1', 1, stepY)
    ],
    sound: {
      x: INSET_X,
      y: soundY,
      w: CONTENT_W,
      h: ALARM_ROW_H,
      radius: sp(24),
      text_size: sp(25),
      color: COLORS.text
    },
    durMinus: {
      x: durX0,
      y: durY,
      w: durBtnW,
      h: ALARM_ROW_H,
      radius: sp(22),
      normal_color: COLORS.card,
      press_color: COLORS.cardHi,
      text: '−',
      text_size: sp(32),
      color: COLORS.text
    },
    durText: {
      x: durX0 + durBtnW + durGap,
      y: durY,
      w: durTextW,
      h: ALARM_ROW_H,
      color: COLORS.text,
      text_size: sp(26),
      align_h: align.CENTER_H,
      align_v: align.CENTER_V,
      text: ''
    },
    durPlus: {
      x: durX0 + durBtnW + durGap + durTextW + durGap,
      y: durY,
      w: durBtnW,
      h: ALARM_ROW_H,
      radius: sp(22),
      normal_color: COLORS.card,
      press_color: COLORS.cardHi,
      text: '+',
      text_size: sp(32),
      color: COLORS.text
    }
  }
}

export const ALARM_LOW = alarmSection(ALARM_LOW_TOP, 'Low alarm')
export const ALARM_HIGH = alarmSection(ALARM_HIGH_TOP, 'High alarm')

export const ALARM_TEST_BTN = {
  x: INSET_X,
  y: ALARM_TEST_Y,
  w: CONTENT_W,
  h: ALARM_ROW_H,
  radius: sp(24),
  normal_color: COLORS.button,
  press_color: COLORS.cardHi,
  text: 'Test sound',
  text_size: sp(25),
  color: COLORS.text
}

export const ALARM_BACK_BTN = {
  x: INSET_X,
  y: ALARM_BACK_Y,
  w: CONTENT_W,
  h: ALARM_ROW_H,
  radius: sp(24),
  normal_color: COLORS.cardHi,
  press_color: COLORS.card,
  text: 'Back',
  text_size: sp(26),
  color: COLORS.text
}

export const ALARM_CONTENT_H = ALARM_BACK_Y + ALARM_ROW_H + sp(28)
