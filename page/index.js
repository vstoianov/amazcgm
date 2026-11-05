import { createWidget, deleteWidget, widget, prop, event, align, setStatusBarVisible } from '@zos/ui'
import { clearLaunchAppTimeout } from '@zos/router'
import { showToast, onGesture, GESTURE_RIGHT } from '@zos/interaction'
import { cancel as alarmCancel, getAllAlarms, set as alarmSet } from '@zos/alarm'
import {
  setWakeUpRelaunch,
  pauseDropWristScreenOff,
  pausePalmScreenOff,
  resetDropWristScreenOff,
  resetPalmScreenOff
} from '@zos/display'
import { Battery } from '@zos/sensor'
import { BasePage } from '@zeppos/zml/base-page'
import {
  GEAR_IMG,
  GEAR_TAP,
  CLOCK,
  STATUS_DOT_HALO,
  STATUS_DOT,
  STATUS_DOT_FALLBACK,
  BATTERY_BODY,
  BATTERY_CAVITY,
  BATTERY_FILL,
  BATTERY_FILL_MAX,
  BATTERY_NUB,
  BATTERY_PCT,
  GLUCOSE,
  TREND_IMG,
  UNIT_FALLBACK,
  trendColorKey,
  trendSrc,
  DELTA,
  STATUS,
  CHART,
  CHART_PAD_T,
  CHART_PAD_B,
  CHART_MIN,
  CHART_MAX,
  CHART_TOP_MAX,
  CHART_TICKS,
  CHART_TICKS_TALL,
  CHART_HOURS,
  CHART_WINDOWS,
  CHART_SCALE_SIZE,
  CHART_SCALE_LABEL_H,
  CHART_SCALE_PAD_R,
  CHART_GUTTER,
  CHART_AXIS,
  CHART_AXIS_INSET,
  CHART_AXIS_LABEL_W,
  CHART_PAD_L,
  CHART_LINE_W,
  CHART_DOT_R,
  CHART_DOT_HALO_R,
  GLANCE_TAP,
  CHART_TAP,
  COLORS,
  glucoseColor,
  W,
  H
} from './index.s.layout.js'
import {
  TITLE as SETTINGS_TITLE,
  buildMenuItems,
  menuListProps,
  TF_TITLE,
  TF_CHIPS,
  TF_BACK_BTN,
  CHIP_ON,
  CHIP_OFF,
  INFO_TITLE,
  INFO_ROWS,
  INFO_BACK_BTN,
  CAL_TITLE,
  CAL_HINT,
  CAL_SENSOR,
  CAL_REF,
  CAL_STEPS,
  CAL_SAVE_BTN,
  CAL_CLEAR_BTN,
  CAL_BACK_BTN,
  ALARM_TITLE,
  ALARM_LOW,
  ALARM_HIGH,
  ALARM_TEST_BTN,
  ALARM_BACK_BTN,
  ALARM_CONTENT_H,
  NOTICE_TITLE,
  NOTICE_TEXT,
  NOTICE_OK_BTN
} from './settings.s.layout.js'
import { createSensorClient, getHeldClient, holdClient, clearHeldClient } from '../shared/sensor-client'
import {
  applyCompanionScanJson,
  applyScanJsonIfNew,
  updateCalibration,
  getSensor,
  getUnlockCount,
  loadLastReading,
  saveLastReading,
  loadHistory,
  pushHistory,
  backfillHistory,
  refitHistory,
  getHistoryDiag,
  getSessionWanted,
  hasStoredScan,
  getRelaunchAlarmIds,
  getRelaunchIds,
  setRelaunchAlarmId,
  setRelaunchAlarmIds,
  setSessionWanted,
  setNeedsForceResume,
  getNeedsForceResume,
  saveUiAliveAt,
  loadSvcAliveAt,
  loadLiveState,
  markAppOpen,
  markPageClosed,
  getChartWindow,
  setChartWindow,
  addCalPoint,
  clearCalPoints,
  getCalFit,
  applyCalMmol,
  getCalPoints,
  exportUserCalJson,
  importUserCalJson,
  getStoredScanText,
  saveUnlockRejectedAt,
  saveBleStuckAt,
  getAlarms,
  setAlarms,
  getNoticeAccepted,
  setNoticeAccepted
} from '../shared/session'
import {
  zoneForMmol,
  postGlucoseAlarm,
  postSignalAlarm,
  playTestAlert,
  stopAlertAudio
} from '../shared/alarms'
import { applyCalFit } from '../shared/cal-fit'
import {
  startSensorService,
  stopSensorService,
  isSensorServiceRunning
} from '../shared/bg-service'
import { every, cancelEvery } from '../shared/defer'
import { parseScanJson, scanFingerprint, scanFingerprintFromText } from '../shared/sensor-config'
import { flushTrace, readTraceTail, resetTraceSession, trace } from '../shared/trace'

function fmtMmol(mmol) {
  if (!mmol) return '—'
  return mmol.toFixed(1)
}

function fmtAge(minutes) {
  if (!minutes) return ''
  const h = Math.floor(minutes / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return d + 'd ' + (h % 24) + 'h on body'
  return h + 'h ' + (minutes % 60) + 'm on body'
}

const HANDSHAKE_AWAKE_MS = 10000
const UI_ALIVE_MS = 60 * 1000
const SVC_ALIVE_TRACE_MS = 5 * 60 * 1000
const SVC_ALIVE_MS = 5 * 60 * 1000
const SVC_DEAD_RESTART_MS = 10 * 60 * 1000
const SVC_RESTART_EVERY_MS = 15 * 60 * 1000
const SELF_RELAUNCH_DELAY_S = 180
const BLE_STUCK_NAG_MS = 10 * 60 * 1000
const READING_STALE_MS = 3 * 60 * 1000

function keepPageAwake() {
  try {
    setWakeUpRelaunch({ relaunch: true })
  } catch (e) {}
}

function keepHandshakeAwake() {
  keepPageAwake()
  try {
    pauseDropWristScreenOff({ duration: HANDSHAKE_AWAKE_MS })
  } catch (e) {}
  try {
    pausePalmScreenOff({ duration: HANDSHAKE_AWAKE_MS })
  } catch (e) {}
}

function relaxPageAwake() {
  try {
    resetDropWristScreenOff()
  } catch (e) {}
  try {
    resetPalmScreenOff()
  } catch (e) {}
}

const DELTA_MIN_MS = 4.5 * 60 * 1000
const DELTA_MAX_MS = 20 * 60 * 1000
const MGDL_PER_MMOL = 18.0182

function roundTenth(n) {
  return Math.round(Number(n) * 10) / 10
}

function findDeltaRef(current, at) {
  if (!current) return null
  const hist = loadHistory()
  if (!hist.length) return null
  const now = at || Date.now()
  let ref = null
  for (let i = hist.length - 1; i >= 0; i--) {
    const p = hist[i]
    if (p && p.mmol && p.at && now - p.at >= DELTA_MIN_MS) {
      ref = p
      break
    }
  }
  if (!ref) return null
  if (now - ref.at > DELTA_MAX_MS) return null
  return ref
}

function slopeArrow(cur, prev, minutes) {
  if (!minutes) return ''
  const slope = ((cur - prev) * MGDL_PER_MMOL) / minutes
  if (slope <= -3.5) return 'down2'
  if (slope <= -2) return 'down'
  if (slope <= -1) return 'down_r'
  if (slope <= 1) return 'flat'
  if (slope <= 2) return 'up_r'
  if (slope <= 3.5) return 'up'
  return 'up2'
}

function trendFromHistory(current, at) {
  const ref = findDeltaRef(current, at)
  if (!ref) return { arrow: '', delta: '' }
  const now = at || Date.now()
  const cur = roundTenth(current)
  const prev = roundTenth(ref.mmol)
  const minutes = Math.max(0.1, (now - ref.at) / 60000)
  const d = cur - prev
  const delta =
    (d === 0 ? '+0.0' : (d > 0 ? '+' : '') + d.toFixed(1)) + ' mmol/L / 5m'
  return { arrow: slopeArrow(cur, prev, minutes), delta: delta }
}

function setText(w, text, color) {
  if (!w) return
  try {
    w.setProperty(prop.MORE, color != null ? { text: text, color: color } : { text: text })
  } catch (e) {}
  try {
    w.setProperty(prop.TEXT, text)
    if (color != null) w.setProperty(prop.COLOR, color)
  } catch (e) {}
}

function replaceTextWidget(oldW, layout, text, color) {
  try {
    if (oldW) deleteWidget(oldW)
  } catch (e) {}
  return createWidget(widget.TEXT, {
    ...layout,
    text: text,
    color: color != null ? color : layout.color
  })
}

function replaceTrendImg(oldW, src) {
  try {
    if (oldW) deleteWidget(oldW)
  } catch (e) {}
  if (!src) return null
  return createWidget(widget.IMG, {
    ...TREND_IMG,
    src: src
  })
}

const STALE_GRAY_MS = 3 * 60 * 1000

function liveAgeText(at) {
  if (!at) return 'Live'
  const sec = Math.floor((Date.now() - at) / 1000)
  if (sec < 20) return 'Live'
  if (sec < 60) return 'Live · ' + sec + 's ago'
  return 'Live · ' + Math.floor(sec / 60) + 'm ago'
}

function seedHistory(last) {
  if (!last || !last.mmol || last.hasError) return loadHistory()
  const hist = loadHistory()
  if (hist.length) return hist
  return pushHistory(last)
}

const CHART_DRAW_MAX = 240

function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

function fmtClock(at) {
  const d = new Date(at)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function consumeFreshLaunch() {
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    const g = app && (app.globalData || (app._options && app._options.globalData))
    if (!g) return true
    const fresh = g.freshLaunch !== false
    g.freshLaunch = false
    return fresh
  } catch (e) {
    return true
  }
}

function visibleWindow(points, backMs, windowMs) {
  const tEnd = Date.now() - (backMs || 0)
  const tStart = tEnd - (windowMs || CHART_WINDOWS[0] * 60 * 1000)
  const list = points || []
  const out = []
  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    if (!p || !p.mmol || !p.at) continue
    if (p.at >= tStart && p.at <= tEnd) out.push(p)
  }
  return { list: out, tStart, tEnd }
}

function downsample(list, maxN) {
  if (!list || list.length <= maxN) return list || []
  const out = []
  const last = list.length - 1
  let prev = -1
  for (let i = 0; i < maxN; i++) {
    const idx = Math.round((i * last) / (maxN - 1))
    if (idx === prev) continue
    out.push(list[idx])
    prev = idx
  }
  return out
}

function yAt(mmol, min, max, top, height) {
  const v = Math.max(min, Math.min(max, mmol))
  return top + ((max - v) / (max - min)) * height
}

Page(
  BasePage({
    onInit(params) {
      this.launchParams = params == null ? '' : String(params)
      this.pageClient = null
      this.poll = null
      this.lastAt = 0
      this.lastMmol = 0
      this.lastRawMmol = 0
      this.lastGlucoseText = ''
      this.lastTrendSrc = ''
      this.lastDeltaText = ''
      this.lastClockText = ''
      this.lastHasError = false
      this.lastPaintAt = 0
      this.lastPaintMmol = 0
      this.lastPaintErr = false
      this.lastPaintStale = false
      this.connected = false
      this.prevMmol = 0
      this.lastLog = ''
      this.windowIdx = getChartWindow()
      this.clockW = null
      this.dotW = null
      this.dotHaloW = null
      this.dotColor = 0
      this.unitW = null
      this.deltaW = null
      this.lastDeltaColor = 0
      this.chartBg = null
      this.lastStatusAt = 0
      this.lastClientStatusAt = 0
      this.lastStallRebuildAt = 0
      this.relaunchTimeoutId = 0
      this.relaunchAlarmId = 0
      this.relaunchArmedAt = 0
      this.lastUiAliveWriteAt = 0
      this.uiPaused = false
      this.lastSvcAliveTraceAt = 0
      this.lastSvcRestartAt = 0
      this.lastSvcSeenAt = 0
      this.settingsOpen = false
      this.infoOpen = false
      this.calOpen = false
      this.tfOpen = false
      this.alarmOpen = false
      this.alertZone = 'ok'
      this.overlayW = []
      this.infoW = []
      this.calW = []
      this.tfW = []
      this.tfChipW = []
      this.alarmW = []
      this.alarmContainer = null
      this.alarmValW = {}
      this.alarmDurW = {}
      this.alarmSoundW = {}
      this.menuListW = null
      this.settingsPollN = 0
      this.sendingLog = false
      this.chartDirty = false
      this.bleStuckNotedAt = 0
      this.bootUiAt = 0
      this.bootClosedAt = 0
      try {
        const bootLive = loadLiveState()
        this.bootUiAt = (bootLive && bootLive.uiAliveAt) || 0
        this.bootClosedAt = Math.max(
          (bootLive && bootLive.pageClosedAt) || 0,
          (bootLive && bootLive.appClosedAt) || 0
        )
      } catch (e) {}
      this.clearRelaunchTimer()
      this.touchUiAlive()
      try {
        markAppOpen()
      } catch (e) {}
      this.pullScanFromPhone()
      this.restoreCalFromPhone()
      try {
        onGesture({
          callback: (event) => {
            if (event === GESTURE_RIGHT) {
              // The first-start notice must be accepted with its button.
              if (this.noticeOpen) return true
              if (this.tfOpen) {
                this.closeTimeframe()
                return true
              }
              if (this.alarmOpen) {
                this.closeAlarms()
                return true
              }
              if (this.calOpen) {
                this.closeCalibrate()
                return true
              }
              if (this.infoOpen) {
                this.closeInfo()
                return true
              }
              if (this.settingsOpen) {
                this.closeSettings()
                return true
              }
              return false
            }
            return false
          }
        })
      } catch (e) {}
    },

    build() {
      try {
        setStatusBarVisible(false)
      } catch (e) {}
      this.clockW = createWidget(widget.TEXT, {
        ...CLOCK,
        text: fmtClock(Date.now())
      })
      this.lastClockText = fmtClock(Date.now())
      this.batteryBodyW = createWidget(widget.FILL_RECT, BATTERY_BODY)
      this.batteryCavityW = createWidget(widget.FILL_RECT, BATTERY_CAVITY)
      this.batteryLevelW = createWidget(widget.FILL_RECT, BATTERY_FILL)
      this.batteryNubW = createWidget(widget.FILL_RECT, BATTERY_NUB)
      this.batteryPctW = createWidget(widget.TEXT, BATTERY_PCT)
      try {
        this.battery = new Battery()
        this.onBatteryChange = () => this.paintBattery()
        this.battery.onChange(this.onBatteryChange)
      } catch (e) {
        this.battery = null
      }
      this.paintBattery()
      this.glucoseW = createWidget(widget.TEXT, GLUCOSE)
      this.trendW = null
      this.unitW = createWidget(widget.TEXT, UNIT_FALLBACK)
      this.deltaW = createWidget(widget.TEXT, DELTA)
      this.initChart()
      this.statusW = createWidget(widget.TEXT, STATUS)
      this.glanceTap = createWidget(widget.TEXT, {
        ...GLANCE_TAP,
        click_func: () => {
          if (this.settingsOpen) return
          this.refreshGlance()
        }
      })
      try {
        if (this.glanceTap && event && this.glanceTap.addEventListener) {
          this.glanceTap.addEventListener(event.CLICK_UP, () => {
            if (this.settingsOpen) return
            this.refreshGlance()
          })
        }
      } catch (e) {}
      const tapGear = () => {
        if (this.settingsOpen) return
        this.openSettings()
      }
      this.gearTap = createWidget(widget.TEXT, {
        ...GEAR_TAP,
        click_func: tapGear
      })
      try {
        if (this.gearTap && event && this.gearTap.addEventListener) {
          this.gearTap.addEventListener(event.CLICK_UP, tapGear)
        }
      } catch (e) {}
      this.gearBtn = createWidget(widget.IMG, {
        ...GEAR_IMG,
        click_func: tapGear
      })
      try {
        if (this.gearBtn && event && this.gearBtn.addEventListener) {
          this.gearBtn.addEventListener(event.CLICK_UP, tapGear)
        }
      } catch (e) {}
      this.updateStatusDot()

      const last = loadLastReading()
      const hist = seedHistory(last)
      if (hist.length >= 2) this.prevMmol = hist[hist.length - 2].mmol
      if (last && last.mmol) {
        this.showGlucose(last, false)
        this.setStatus(
          getSessionWanted()
            ? 'Reconnecting…'
            : 'Last reading stored.'
        )
      } else {
        this.drawChart([])
      }
      this.chartDirty = true
      this.ensurePoll()
      const fresh = consumeFreshLaunch()
      const lp = String(this.launchParams || '')
      const fromSvc = lp.indexOf('svc') >= 0
      const fromSelf = lp.indexOf('self') >= 0
      try {
        resetTraceSession()
        trace(
          (fresh ? 'launch fresh' : 'launch relaunch') +
            (fromSvc ? ' svc' : fromSelf ? ' self' : '')
        )
        if (fresh) {
          const now = Date.now()
          const uiAt = this.bootUiAt || 0
          const closedAt = this.bootClosedAt || 0
          const svcAt = loadSvcAliveAt()
          const uiAge = uiAt ? Math.round((now - uiAt) / 1000) : -1
          const closedAge = closedAt ? Math.round((now - closedAt) / 1000) : -1
          const svcAge = svcAt ? Math.round((now - svcAt) / 1000) : -1
          trace(
            'boot gap ui=' +
              uiAge +
              's closed=' +
              closedAge +
              's svc=' +
              svcAge +
              's'
          )
        }
      } catch (e) {}
      if (fresh) this.sweepRelaunchAlarms()
      if (getSessionWanted()) {
        this.resumeSession()
      } else if (fresh && hasStoredScan()) {
        setSessionWanted(true)
        this.resumeSession()
      }
      let accepted = true
      try {
        accepted = getNoticeAccepted()
      } catch (e) {}
      if (!accepted) this.showNotice()
    },

    showNotice() {
      if (this.noticeOpen) return
      this.noticeOpen = true
      // Every tap handler on the main screen ignores taps while this is set.
      this.settingsOpen = true
      this.noticeW = []
      const add = (type, opts) => {
        try {
          const w = createWidget(type, opts)
          if (w) this.noticeW.push(w)
        } catch (e) {}
      }
      add(widget.FILL_RECT, { x: 0, y: 0, w: W, h: H, color: COLORS.bg })
      add(widget.TEXT, NOTICE_TITLE)
      add(widget.TEXT, NOTICE_TEXT)
      add(widget.BUTTON, {
        ...NOTICE_OK_BTN,
        click_func: () => this.closeNotice()
      })
    },

    closeNotice() {
      try {
        setNoticeAccepted(true)
      } catch (e) {}
      const list = this.noticeW || []
      this.noticeW = []
      for (let i = 0; i < list.length; i++) {
        try {
          deleteWidget(list[i])
        } catch (e) {}
      }
      this.noticeOpen = false
      this.settingsOpen = false
    },

    ensurePoll() {
      if (this.poll) return
      this.poll = every(10000, () => this.syncFromStore())
    },

    onResume() {
      this.uiPaused = false
      this.touchUiAlive()
      this.ensurePoll()
      this.updateClock()
      this.updateStatusDot()
      this.refreshGlance()
      if (getSessionWanted() && !this.pageClient) this.resumeSession()
    },

    onPause() {
      this.uiPaused = true
      this.touchUiAlive()
      cancelEvery(this.poll)
      this.poll = null
      try {
        flushTrace()
      } catch (e) {}
    },

    onDestroy() {
      try {
        if (this.battery && this.onBatteryChange) this.battery.offChange(this.onBatteryChange)
      } catch (e) {}
      try {
        flushTrace()
      } catch (e) {}
      if (getSessionWanted()) {
        try {
          markPageClosed()
        } catch (e) {}
      }
      cancelEvery(this.poll)
      this.poll = null
      let live = false
      if (this.pageClient) {
        try {
          live =
            (this.pageClient.isLinked && this.pageClient.isLinked()) ||
            (this.pageClient.hadLive && this.pageClient.hadLive())
        } catch (e) {}
      }
      if (!this.pageClient) return
      if (getSessionWanted()) {
        this.pageClient.setHooks({})
        this.pageClient.detach()
        if (live) {
          holdClient(this.pageClient)
        } else {
          try {
            if (this.pageClient.park) this.pageClient.park()
          } catch (e) {}
          clearHeldClient()
          setNeedsForceResume(true)
        }
      } else {
        this.pageClient.release()
        clearHeldClient()
      }
      this.pageClient = null
    },

    onCall(req) {
      if (req && req.method === 'APPLY_SCAN' && req.params && req.params.json) {
        if (this.settingsOpen) {
          this.applySettingsIncoming(req.params.json, 'Zepp paste', false)
        } else {
          this.applyIncomingJson(req.params.json, true)
        }
      }
    },

    /**
     * Phone messaging shares the one BLE radio with the sensor link, and the
     * side service may block on its localhost fetch. Never do this around a
     * connect: a scan already on the watch is pulled by the settings button.
     */
    pullScanFromPhone() {
      if (!this.request) return
      if (getSessionWanted()) return
      this.request({ method: 'GET_SCAN_JSON' })
        .then(({ json }) => {
          if (json) this.applyIncomingJson(json, true)
        })
        .catch(() => {})
    },

    pushCalToPhone() {
      if (!this.request) return
      try {
        this.request({
          method: 'PUT_CAL',
          params: { json: exportUserCalJson() }
        }).catch(() => {})
      } catch (e) {}
    },

    restoreCalFromPhone() {
      if (!this.request) return
      if (getCalPoints().length) return
      this.request({ method: 'GET_CAL' })
        .then((reply) => {
          const json = reply && reply.json
          if (!json) return
          const n = importUserCalJson(json)
          if (n <= 0) return
          showToast({ text: 'Calibration restored' })
          const last = loadLastReading()
          const raw = this.lastRawMmol || (last && last.rawMmol)
          if (raw) this.repaintCalibrated(raw)
          else this.drawChart()
        })
        .catch(() => {})
    },

    applyIncomingJson(text, fromCompanion) {
      try {
        if (fromCompanion) {
          const phoneFp = scanFingerprintFromText(text)
          if (phoneFp && phoneFp === scanFingerprint(getSensor())) {
            try {
              if (updateCalibration(parseScanJson(text).calibration)) {
                this.setStatus('Calibration applied')
              }
            } catch (e) {}
            return
          }
        }
        const sensor = fromCompanion
          ? applyCompanionScanJson(text)
          : applyScanJsonIfNew(text)
        this.setStatus(
          'Applied code ' +
            sensor.unlockCode +
            ' · count ' +
            getUnlockCount() +
            '\n' +
            sensor.patchInfoHex
        )
      } catch (e) {
        this.setStatus((e && e.message) || 'Invalid scan JSON')
      }
    },

    openSettings() {
      if (this.settingsOpen) return
      this.settingsOpen = true
      this.overlayW = []
      const add = (w) => {
        if (w) this.overlayW.push(w)
        return w
      }
      try {
        add(
          createWidget(widget.FILL_RECT, {
            x: 0,
            y: 0,
            w: W,
            h: H,
            color: COLORS.bg
          })
        )
      } catch (e) {}
      add(createWidget(widget.TEXT, SETTINGS_TITLE))
      this.menuListW = null
      this.showSettingsMenu()
    },

    hideSettingsMenu() {
      const w = this.menuListW
      if (!w) return
      this.menuListW = null
      const list = this.overlayW || []
      const idx = list.indexOf(w)
      if (idx >= 0) list.splice(idx, 1)
      try {
        deleteWidget(w)
      } catch (e) {}
    },

    menuItemsData() {
      const sensor = getSensor()
      const serial = String((sensor && sensor.serial) || '').trim()
      const winH = Math.round(this.chartWindowMin() / 60)
      const alarms = getAlarms()
      const fit = getCalFit()
      return buildMenuItems({
        syncSub: serial ? serial : 'Bluetooth / Zepp',
        rangeSub: winH + ' hours',
        alarmsSub: fmtMmol(alarms.low.mmol) + ' – ' + fmtMmol(alarms.high.mmol) + ' mmol/L',
        calSub: fit && fit.n > 0 ? 'Active · n=' + fit.n : 'Blood glucose ref',
        infoSub: serial ? serial + ' · #' + getUnlockCount() : 'Sensor & status'
      })
    },

    showSettingsMenu() {
      if (!this.settingsOpen || this.menuListW) return
      if (this.tfOpen || this.alarmOpen || this.infoOpen || this.calOpen) return
      try {
        const w = createWidget(
          widget.SCROLL_LIST,
          menuListProps((list, index) => this.onMenuClick(index), this.menuItemsData())
        )
        this.menuListW = w
        if (w && this.overlayW) this.overlayW.push(w)
      } catch (e) {}
    },

    onMenuClick(index) {
      if (index === 0) this.syncFromScanner()
      else if (index === 1) this.openTimeframe()
      else if (index === 2) this.openAlarms()
      else if (index === 3) this.openCalibrate()
      else if (index === 4) this.openInfo()
      else if (index === 5) this.sendLog()
      else if (index === 6) this.closeSettings()
    },

    openAlarms() {
      if (this.alarmOpen) return
      this.hideSettingsMenu()
      this.alarmOpen = true
      this.alarmW = []
      this.alarmValW = {}
      this.alarmDurW = {}
      this.alarmSoundW = {}
      this.alarmContainer = null
      const add = (w) => {
        if (w) this.alarmW.push(w)
        return w
      }
      try {
        add(
          createWidget(widget.FILL_RECT, {
            x: 0,
            y: 0,
            w: W,
            h: H,
            color: COLORS.bg
          })
        )
      } catch (e) {}
      try {
        this.alarmContainer = add(
          createWidget(widget.VIEW_CONTAINER, {
            x: 0,
            y: 0,
            w: W,
            h: H,
            scroll_enable: true
          })
        )
      } catch (e) {}
      const make = (type, props) => {
        if (this.alarmContainer && this.alarmContainer.createWidget) {
          return this.alarmContainer.createWidget(type, props)
        }
        return createWidget(type, props)
      }
      make(widget.TEXT, ALARM_TITLE)
      this.buildAlarmSection(make, 'low', ALARM_LOW)
      this.buildAlarmSection(make, 'high', ALARM_HIGH)
      make(widget.BUTTON, {
        ...ALARM_TEST_BTN,
        click_func: () => {
          showToast({ text: 'Playing test sound' })
          playTestAlert(2)
        }
      })
      make(widget.BUTTON, {
        ...ALARM_BACK_BTN,
        click_func: () => {
          stopAlertAudio()
          this.closeAlarms()
        }
      })
      try {
        make(widget.FILL_RECT, {
          x: 0,
          y: ALARM_CONTENT_H - 1,
          w: 1,
          h: 1,
          color: COLORS.bg
        })
      } catch (e) {}
    },

    buildAlarmSection(make, key, layout) {
      const a = getAlarms()[key]
      make(widget.TEXT, layout.label)
      this.alarmValW[key] = make(widget.TEXT, {
        ...layout.value,
        text: fmtMmol(a.mmol)
      })
      for (let i = 0; i < layout.steps.length; i++) {
        const step = layout.steps[i]
        make(widget.BUTTON, {
          ...step,
          click_func: () => this.stepAlarmMmol(key, step.delta)
        })
      }
      this.alarmSoundW[key] = this.createAlarmSoundBtn(make, key, layout.sound, !!a.sound)
      make(widget.BUTTON, {
        ...layout.durMinus,
        click_func: () => this.stepAlarmDuration(key, -1)
      })
      this.alarmDurW[key] = make(widget.TEXT, {
        ...layout.durText,
        text: String(a.duration) + 's'
      })
      make(widget.BUTTON, {
        ...layout.durPlus,
        click_func: () => this.stepAlarmDuration(key, 1)
      })
    },

    createAlarmSoundBtn(make, key, layout, soundOn) {
      return make(widget.BUTTON, {
        ...layout,
        ...(soundOn ? CHIP_ON : CHIP_OFF),
        text: soundOn ? 'Sound On' : 'Sound Off',
        click_func: () => this.toggleAlarmSound(key)
      })
    },

    alarmMake() {
      if (this.alarmContainer && this.alarmContainer.createWidget) {
        return (type, props) => this.alarmContainer.createWidget(type, props)
      }
      return createWidget
    },

    stepAlarmMmol(key, delta) {
      const cur = getAlarms()[key]
      const next = {}
      next[key] = { mmol: Math.round((Number(cur.mmol) + Number(delta)) * 10) / 10 }
      const alarms = setAlarms(next)
      const keys = ['low', 'high']
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]
        try {
          if (this.alarmValW && this.alarmValW[k]) {
            this.alarmValW[k].setProperty(prop.TEXT, fmtMmol(alarms[k].mmol))
          }
        } catch (e) {}
      }
    },

    toggleAlarmSound(key) {
      const cur = getAlarms()[key]
      const next = {}
      next[key] = { sound: !cur.sound }
      const a = setAlarms(next)[key]
      const layout = key === 'high' ? ALARM_HIGH.sound : ALARM_LOW.sound
      try {
        if (this.alarmSoundW && this.alarmSoundW[key]) deleteWidget(this.alarmSoundW[key])
      } catch (e) {}
      this.alarmSoundW[key] = this.createAlarmSoundBtn(this.alarmMake(), key, layout, !!a.sound)
    },

    stepAlarmDuration(key, delta) {
      const cur = getAlarms()[key]
      const next = {}
      next[key] = { duration: Number(cur.duration) + Number(delta) }
      const a = setAlarms(next)[key]
      try {
        if (this.alarmDurW && this.alarmDurW[key]) {
          this.alarmDurW[key].setProperty(prop.TEXT, String(a.duration) + 's')
        }
      } catch (e) {}
    },

    closeAlarms(restoreMenu) {
      if (!this.alarmOpen) return
      this.alarmOpen = false
      this.alarmContainer = null
      this.alarmValW = {}
      this.alarmDurW = {}
      this.alarmSoundW = {}
      const list = this.alarmW || []
      this.alarmW = []
      for (let i = 0; i < list.length; i++) {
        try {
          deleteWidget(list[i])
        } catch (e) {}
      }
      if (restoreMenu !== false) this.showSettingsMenu()
    },

    openTimeframe() {
      if (this.tfOpen) return
      this.hideSettingsMenu()
      this.tfOpen = true
      this.tfW = []
      this.tfChipW = []
      const add = (w) => {
        if (w) this.tfW.push(w)
        return w
      }
      try {
        add(
          createWidget(widget.FILL_RECT, {
            x: 0,
            y: 0,
            w: W,
            h: H,
            color: COLORS.bg
          })
        )
      } catch (e) {}
      add(createWidget(widget.TEXT, TF_TITLE))
      this.tfChipW = this.createTfChips()
      add(
        createWidget(widget.BUTTON, {
          ...TF_BACK_BTN,
          click_func: () => this.closeTimeframe()
        })
      )
    },

    createTfChips() {
      const list = []
      for (let i = 0; i < TF_CHIPS.length; i++) {
        const idx = i
        const style = i === this.windowIdx ? CHIP_ON : CHIP_OFF
        try {
          const w = createWidget(widget.BUTTON, {
            ...TF_CHIPS[i],
            ...style,
            click_func: () => this.selectWindow(idx)
          })
          list.push(w)
          if (this.tfW) this.tfW.push(w)
        } catch (e) {}
      }
      return list
    },

    styleTfChips() {
      if (!this.tfOpen) return
      const old = this.tfChipW || []
      for (let i = 0; i < old.length; i++) {
        try {
          deleteWidget(old[i])
        } catch (e) {}
        const idx = this.tfW.indexOf(old[i])
        if (idx >= 0) this.tfW.splice(idx, 1)
      }
      this.tfChipW = this.createTfChips()
    },

    closeTimeframe() {
      if (!this.tfOpen) return
      this.tfOpen = false
      this.tfChipW = []
      const list = this.tfW || []
      this.tfW = []
      for (let i = 0; i < list.length; i++) {
        try {
          deleteWidget(list[i])
        } catch (e) {}
      }
      this.showSettingsMenu()
    },

    openInfo() {
      if (this.infoOpen) return
      this.hideSettingsMenu()
      this.infoOpen = true
      this.infoW = []
      const add = (w) => {
        if (w) this.infoW.push(w)
        return w
      }
      try {
        add(
          createWidget(widget.FILL_RECT, {
            x: 0,
            y: 0,
            w: W,
            h: H,
            color: COLORS.bg
          })
        )
      } catch (e) {}
      add(createWidget(widget.TEXT, INFO_TITLE))
      const sensor = getSensor()
      const cal = sensor.calibration
      const fit = getCalFit()
      const hDiag = getHistoryDiag()
      const sizeText =
        hDiag.fileBytes >= 1024
          ? (hDiag.fileBytes / 1024).toFixed(1) + ' KB'
          : hDiag.fileBytes + ' B'
      const histText =
        hDiag.records +
        ' pts / ' +
        sizeText +
        ' / ' +
        (hDiag.segments || 0) +
        ' segs' +
        (hDiag.legacyPresent ? ' · legacy' : '')
      const values = [
        String(sensor.serial || 'Not set'),
        String(sensor.unlockCode != null ? sensor.unlockCode : '') + ' · #' + getUnlockCount(),
        String(sensor.patchInfoHex || '—'),
        (cal ? cal.i2 + '/' + cal.i3 + '/' + cal.i4 + '/' + cal.i6 : 'none') +
          ' · n=' +
          fit.n,
        histText
      ]
      for (let i = 0; i < INFO_ROWS.length; i++) {
        const row = INFO_ROWS[i]
        add(createWidget(widget.TEXT, row.label))
        add(
          createWidget(widget.TEXT, {
            ...row.value,
            text: values[i]
          })
        )
      }
      add(
        createWidget(widget.BUTTON, {
          ...INFO_BACK_BTN,
          click_func: () => this.closeInfo()
        })
      )
    },

    closeInfo() {
      if (!this.infoOpen) return
      this.infoOpen = false
      const list = this.infoW || []
      this.infoW = []
      for (let i = 0; i < list.length; i++) {
        try {
          deleteWidget(list[i])
        } catch (e) {}
      }
      this.showSettingsMenu()
    },

    openCalibrate() {
      if (this.calOpen) return
      const last = loadLastReading()
      const shown = this.lastMmol || (last && last.mmol) || 0
      const rawMmol = this.lastRawMmol || (last && last.rawMmol) || shown
      const at = this.lastAt || (last && last.at) || 0
      if (!rawMmol || !shown || !at || Date.now() - at > 10 * 60 * 1000) {
        showToast({ text: 'No recent reading' })
        return
      }
      this.hideSettingsMenu()
      this.calOpen = true
      this.calRef = shown
      this.calRaw = rawMmol
      this.calW = []
      const add = (w) => {
        if (w) this.calW.push(w)
        return w
      }
      try {
        add(
          createWidget(widget.FILL_RECT, {
            x: 0,
            y: 0,
            w: W,
            h: H,
            color: COLORS.bg
          })
        )
      } catch (e) {}
      add(createWidget(widget.TEXT, CAL_TITLE))
      add(createWidget(widget.TEXT, CAL_HINT))
      add(
        createWidget(widget.TEXT, {
          ...CAL_SENSOR,
          text: 'Sensor ' + fmtMmol(rawMmol)
        })
      )
      this.calRefW = add(
        createWidget(widget.TEXT, {
          ...CAL_REF,
          text: fmtMmol(this.calRef)
        })
      )
      for (let i = 0; i < CAL_STEPS.length; i++) {
        const step = CAL_STEPS[i]
        add(
          createWidget(widget.BUTTON, {
            ...step,
            click_func: () => this.stepCalRef(step.delta)
          })
        )
      }
      add(
        createWidget(widget.BUTTON, {
          ...CAL_SAVE_BTN,
          click_func: () => this.saveCalPoint()
        })
      )
      add(
        createWidget(widget.BUTTON, {
          ...CAL_CLEAR_BTN,
          click_func: () => this.clearUserCal()
        })
      )
      add(
        createWidget(widget.BUTTON, {
          ...CAL_BACK_BTN,
          click_func: () => this.closeCalibrate()
        })
      )
    },

    stepCalRef(delta) {
      if (!this.calOpen) return
      let next = Math.round((Number(this.calRef) + Number(delta)) * 10) / 10
      if (next < 1) next = 1
      if (next > 30) next = 30
      this.calRef = next
      try {
        if (this.calRefW) deleteWidget(this.calRefW)
      } catch (e) {}
      this.calRefW = createWidget(widget.TEXT, {
        ...CAL_REF,
        text: fmtMmol(this.calRef)
      })
      if (this.calW) this.calW.push(this.calRefW)
    },

    repaintCalibrated(raw) {
      refitHistory()
      if (!raw) {
        this.drawChart()
        return
      }
      const mmol = applyCalMmol(raw)
      const last = loadLastReading()
      if (last) {
        saveLastReading({
          ...last,
          mmol: mmol,
          rawMmol: raw,
          mgdl: Math.round(mmol * MGDL_PER_MMOL)
        })
      }
      this.paintReading({
        mmol: mmol,
        rawMmol: raw,
        at: (last && last.at) || this.lastAt
      })
      this.drawChart()
    },

    saveCalPoint() {
      const raw = this.calRaw
      const ref = this.calRef
      const fit = addCalPoint(raw, ref)
      this.pushCalToPhone()
      const bText = (fit.b >= 0 ? '+' : '') + fit.b.toFixed(1)
      try {
        trace(
          'cal add s=' +
            raw +
            ' r=' +
            ref +
            ' -> a=' +
            fit.a.toFixed(2) +
            ' b=' +
            bText +
            ' n=' +
            fit.n
        )
      } catch (e) {}
      showToast({
        text: 'Cal n=' + fit.n + ' a=' + fit.a.toFixed(2) + ' b=' + bText
      })
      this.closeCalibrate()
      this.repaintCalibrated(raw)
    },

    clearUserCal() {
      const raw = this.calRaw || this.lastRawMmol
      clearCalPoints()
      this.pushCalToPhone()
      try {
        trace('cal clear')
      } catch (e) {}
      showToast({ text: 'Calibration cleared' })
      this.closeCalibrate()
      this.repaintCalibrated(raw)
    },

    closeCalibrate() {
      if (!this.calOpen) return
      this.calOpen = false
      this.calRefW = null
      const list = this.calW || []
      this.calW = []
      for (let i = 0; i < list.length; i++) {
        try {
          deleteWidget(list[i])
        } catch (e) {}
      }
      this.showSettingsMenu()
    },

    closeSettings() {
      if (!this.settingsOpen) return
      this.settingsOpen = false
      this.closeTimeframe()
      this.closeAlarms(false)
      this.closeCalibrate()
      this.closeInfo()
      const list = this.overlayW || []
      this.overlayW = []
      this.menuListW = null
      for (let i = 0; i < list.length; i++) {
        try {
          deleteWidget(list[i])
        } catch (e) {}
      }
      this.lastPaintAt = 0
      this.refreshGlance()
      this.drawChart()
    },

    sendLog() {
      if (this.sendingLog) return
      if (!this.request) {
        showToast({ text: 'Phone not connected' })
        return
      }
      try {
        flushTrace()
      } catch (e) {}
      const text = readTraceTail(24000)
      if (!text) {
        showToast({ text: 'No log yet' })
        return
      }
      const CHUNK = 3500
      const total = Math.ceil(text.length / CHUNK) || 1
      this.sendingLog = true
      const send = (part) => {
        const start = part * CHUNK
        this.request({
          method: 'PUT_LOG',
          params: { part: part, total: total, text: text.slice(start, start + CHUNK) }
        })
          .then(() => {
            if (part + 1 < total) {
              send(part + 1)
              return
            }
            this.sendingLog = false
            showToast({ text: 'Log sent · ' + text.length + 'b' })
          })
          .catch(() => {
            this.sendingLog = false
            showToast({ text: 'Send failed' })
          })
      }
      send(0)
    },

    applySettingsIncoming(text, source, force) {
      try {
        const phoneFp = scanFingerprintFromText(text)
        const watch = getSensor()
        if (phoneFp && phoneFp === scanFingerprint(watch)) {
          let changed = false
          try {
            changed = updateCalibration(parseScanJson(text).calibration)
          } catch (e) {}
          if (force) {
            showToast({
              text: changed
                ? 'Calibration updated'
                : 'Phone still code ' +
                  watch.unlockCode +
                  ' · patch ' +
                  watch.patchInfoHex
            })
          }
          return
        }
        const sensor = applyCompanionScanJson(text)
        showToast({
          text:
            'Got code ' +
            sensor.unlockCode +
            ' · patch ' +
            sensor.patchInfoHex +
            (source ? ' · ' + source : '')
        })
      } catch (e) {
        if (force) showToast({ text: (e && e.message) || 'Invalid JSON' })
      }
    },

    pullQuiet() {
      if (!this.request || getSessionWanted()) return
      this.request({
        method: 'GET_SCAN_JSON',
        params: { settingsOnly: true }
      })
        .then((reply) => {
          const json = reply && reply.json
          if (json) {
            this.applySettingsIncoming(
              json,
              reply.source === 'scanner' ? 'Pixel' : 'Zepp',
              false
            )
          }
        })
        .catch(() => {})
    },

    recoverFromRejectedUnlock() {
      const now = Date.now()
      if (now - (this.lastRejectRecoverAt || 0) < 180000) return
      this.lastRejectRecoverAt = now
      this.setStatus('Sensor ignores unlock\nRe-scan, then Sync')
      const giveUp = () => {
        this.setStatus('Sensor ignores unlock\nRe-scan with phone, then Sync')
        try {
          saveUnlockRejectedAt()
        } catch (e) {}
      }
      if (!this.request) {
        giveUp()
        return
      }
      this.request({ method: 'GET_SCAN_JSON', params: { refresh: true } })
        .then((reply) => {
          const json = reply && reply.json ? String(reply.json).trim() : ''
          if (!json || json === getStoredScanText()) {
            giveUp()
            return
          }
          const sensor = applyCompanionScanJson(json)
          showToast({
            text:
              'New scan · code ' +
              sensor.unlockCode +
              ' · count ' +
              getUnlockCount()
          })
          if (this.pageClient && this.pageClient.rescanApplied) this.pageClient.rescanApplied()
        })
        .catch(() => giveUp())
    },

    syncFromScanner() {
      if (!this.request) {
        showToast({ text: 'Phone not connected' })
        return
      }
      const rejected = !!(
        this.pageClient &&
        this.pageClient.isUnlockRejected &&
        this.pageClient.isUnlockRejected()
      )
      this.request({
        method: 'GET_SCAN_JSON',
        params: { settingsOnly: getSessionWanted(), refresh: rejected }
      })
        .then((reply) => {
          const json = reply && reply.json
          if (!json) {
            showToast({ text: 'Save paste in Zepp Settings first' })
            return
          }
          this.applySettingsIncoming(
            json,
            reply.source === 'scanner' ? 'Pixel' : 'Zepp',
            true
          )
        })
        .catch(() => {
          showToast({ text: 'Sync failed' })
        })
    },

    hideStatus() {
      if (!this.statusW) return
      try {
        this.statusW.setProperty(prop.VISIBLE, false)
      } catch (e) {}
    },

    setStatus(text) {
      this.lastStatusAt = Date.now()
      this.lastLog = text || ''
      if (this.uiPaused || !this.statusW) return
      this.updateStatusDot()
      if (this.lastMmol) {
        this.hideStatus()
        if (this.isStale()) {
          this.lastPaintAt = 0
          this.paintReading({
            mmol: this.lastMmol,
            rawMmol: this.lastRawMmol || this.lastMmol,
            hasError: this.lastHasError,
            at: this.lastAt,
            wearMinutes: this.lastWearMinutes
          })
        }
        return
      }
      try {
        this.statusW.setProperty(prop.VISIBLE, true)
      } catch (e) {}
      this.statusW.setProperty(prop.TEXT, this.lastLog)
    },

    setConnected(on) {
      this.connected = on
      if (on && this.clearRelaunchTimer) this.clearRelaunchTimer()
      if (!this.uiPaused) this.updateStatusDot()
    },

    updateClock() {
      const text = fmtClock(Date.now())
      if (text !== this.lastClockText) {
        this.lastClockText = text
        setText(this.clockW, text)
      }
      this.paintBattery()
    },

    paintBattery() {
      let n = 0
      try {
        n = this.battery ? Number(this.battery.getCurrent()) : 0
      } catch (e) {}
      if (!Number.isFinite(n)) n = 0
      n = Math.max(0, Math.min(100, Math.round(n)))
      if (n === this.lastBattery) return
      this.lastBattery = n
      const w = n > 0 ? Math.max(1, Math.round((n / 100) * BATTERY_FILL_MAX)) : 0
      const color = n < 10 ? COLORS.bad : n <= 20 ? COLORS.warn : COLORS.ok
      try {
        if (this.batteryLevelW) {
          this.batteryLevelW.setProperty(prop.MORE, {
            x: BATTERY_FILL.x,
            y: BATTERY_FILL.y,
            w: w,
            h: BATTERY_FILL.h,
            color: color
          })
        }
      } catch (e) {}
      setText(this.batteryPctW, n + '%', color)
    },

    dotHaloFor(color) {
      if (color === COLORS.ok) return 0x153626
      if (color === COLORS.accent) return 0x163848
      if (color === COLORS.bad) return 0x421c1c
      return 0x1e282d
    },

    dotColorFor() {
      if (this.lastHasError) return COLORS.bad
      const log = String(this.lastLog || '')
      if (
        log.indexOf('Bluetooth stuck') >= 0 ||
        log.indexOf('Sensor ignores') >= 0
      ) {
        return COLORS.bad
      }
      if (!getSessionWanted()) return COLORS.muted
      if (this.connected && this.lastMmol && !this.lastHasError && !this.isStale()) {
        return COLORS.ok
      }
      if (
        this.connected ||
        log.indexOf('Scan') === 0 ||
        log.indexOf('Connect') === 0 ||
        log.indexOf('Next') === 0 ||
        log.indexOf('Discover') === 0 ||
        log.indexOf('Stream') === 0 ||
        log.indexOf('Reconnect') === 0 ||
        log.indexOf('Looking') === 0
      ) {
        return COLORS.accent
      }
      return COLORS.muted
    },

    createStatusDot(color) {
      this.dotHaloW = null
      this.dotW = null
      const haloColor = this.dotHaloFor(color)
      try {
        if (widget.CIRCLE) {
          this.dotHaloW = createWidget(widget.CIRCLE, {
            ...STATUS_DOT_HALO,
            color: haloColor
          })
          this.dotW = createWidget(widget.CIRCLE, {
            ...STATUS_DOT,
            color: color
          })
        }
      } catch (e) {
        this.dotW = null
      }
      if (!this.dotW) {
        try {
          this.dotW = createWidget(widget.FILL_RECT, {
            ...STATUS_DOT_FALLBACK,
            color: color
          })
        } catch (e) {}
      }
    },

    updateStatusDot() {
      const color = this.dotColorFor()
      if (this.dotW && color === this.dotColor) return
      this.dotColor = color
      if (this.dotHaloW) {
        try {
          deleteWidget(this.dotHaloW)
        } catch (e) {}
        this.dotHaloW = null
      }
      if (this.dotW) {
        try {
          deleteWidget(this.dotW)
        } catch (e) {}
        this.dotW = null
      }
      this.createStatusDot(color)
    },

    sweepRelaunchAlarms() {
      try {
        const ids = getAllAlarms()
        if (!ids || !ids.length) return
        for (let i = 0; i < ids.length; i++) {
          try {
            alarmCancel(ids[i])
          } catch (e) {}
        }
      } catch (e) {}
      setRelaunchAlarmId(0)
      setRelaunchAlarmIds([])
    },

    setRelaunch(on) {
      try {
        setWakeUpRelaunch({ relaunch: !!on })
      } catch (e) {}
    },

    touchUiAlive() {
      this.lastUiAliveWriteAt = Date.now()
      try {
        saveUiAliveAt()
      } catch (e) {}
    },

    clearRelaunchTimer() {
      const timeoutIds = []
      const alarmIds = []
      const memTimeout = this.relaunchTimeoutId || 0
      const memAlarm = this.relaunchAlarmId || 0
      const storedTimeouts = getRelaunchIds()
      const storedAlarms = getRelaunchAlarmIds()
      if (memTimeout) timeoutIds.push(memTimeout)
      for (let i = 0; i < storedTimeouts.length; i++) {
        if (storedTimeouts[i] && storedTimeouts[i] !== memTimeout) timeoutIds.push(storedTimeouts[i])
      }
      if (memAlarm) alarmIds.push(memAlarm)
      for (let i = 0; i < storedAlarms.length; i++) {
        if (storedAlarms[i] && storedAlarms[i] !== memAlarm) alarmIds.push(storedAlarms[i])
      }
      this.relaunchTimeoutId = 0
      this.relaunchAlarmId = 0
      this.relaunchArmedAt = 0
      for (let i = 0; i < timeoutIds.length; i++) {
        try {
          clearLaunchAppTimeout({ timeoutId: timeoutIds[i] })
        } catch (e) {
          try {
            clearLaunchAppTimeout(timeoutIds[i])
          } catch (e2) {}
        }
      }
      for (let i = 0; i < alarmIds.length; i++) {
        try {
          alarmCancel(alarmIds[i])
        } catch (e) {}
      }
      setRelaunchAlarmId(0)
      setRelaunchAlarmIds([])
    },

    armSelfRelaunchAlarm() {
      if (!getSessionWanted()) return
      this.clearRelaunchTimer()
      try {
        const id = alarmSet({
          url: 'page/index',
          delay: SELF_RELAUNCH_DELAY_S,
          param: 'self'
        })
        if (id && Number(id) > 0) {
          const n = Number(id)
          this.relaunchAlarmId = n
          this.relaunchArmedAt = Date.now()
          setRelaunchAlarmId(n)
          const list = getRelaunchAlarmIds()
          if (list.indexOf(n) < 0) list.push(n)
          setRelaunchAlarmIds(list)
        }
      } catch (e) {}
    },

    refreshGlance() {
      const last = loadLastReading()
      if (last && last.mmol) this.showGlucose(last, false)
      else this.drawChart()
    },

    syncFromStore() {
      if (this.chartDirty) {
        this.chartDirty = false
        this.drawChart()
      }
      this.settingsPollN = (this.settingsPollN || 0) + 1
      if (this.settingsOpen && !getSessionWanted() && this.settingsPollN % 4 === 0) {
        this.pullQuiet()
      }
      const last = loadLastReading()
      if (last && last.mmol) {
        const changed = last.at !== this.lastAt || last.mmol !== this.lastMmol
        if (changed) this.refreshGlance()
        else this.paintReading(last)
      }
      const client = this.pageClient
      const packetAt = client && client.lastPacketAt ? client.lastPacketAt() : 0
      if (this.connected && packetAt && Date.now() - (this.lastClientStatusAt || 0) >= 35000) {
        this.setStatus(liveAgeText(packetAt))
      }
      this.rebuildIfStalled()
      this.maybeAlertStoredStuck()
      if (Date.now() - (this.lastUiAliveWriteAt || 0) >= UI_ALIVE_MS) {
        this.touchUiAlive()
      }
      this.updateClock()
      this.updateStatusDot()
    },

    checkServiceAlive() {
      try {
        const now = Date.now()
        const svcAt = loadSvcAliveAt()
        let g = null
        try {
          const app = typeof getApp === 'function' ? getApp() : null
          g = app && (app.globalData || (app._options && app._options.globalData))
        } catch (e2) {}
        if (svcAt) {
          this.lastSvcSeenAt = svcAt
          if (g) g.svcSeenAt = svcAt
        }
        const seenAt = svcAt || this.lastSvcSeenAt || (g && g.svcSeenAt) || 0
        const dead = !svcAt || !(seenAt && now - seenAt < SVC_ALIVE_MS)
        if (dead) {
          this.armSelfRelaunchAlarm()
        } else if (this.relaunchAlarmId) {
          this.clearRelaunchTimer()
        }
        if (now - (this.lastSvcAliveTraceAt || 0) < SVC_ALIVE_TRACE_MS) return
        this.lastSvcAliveTraceAt = now
        const age = seenAt ? Math.round((now - seenAt) / 1000) : -1
        let running = false
        try {
          running = isSensorServiceRunning()
        } catch (e3) {}
        const flag = running ? '1' : '0'
        if (!svcAt) {
          trace('svc alive? (blank file)')
          const blankAgain = !!this.lastSvcBlank
          this.lastSvcBlank = true
          if (running && !blankAgain) {
            try {
              trace('svc blank (run=1) ignored')
            } catch (e4) {}
          } else if (
            getSessionWanted() &&
            now - (this.lastSvcRestartAt || 0) >= SVC_RESTART_EVERY_MS
          ) {
            this.lastSvcRestartAt = now
            try {
              trace('svc restart blank')
            } catch (e4) {}
            stopSensorService()
              .then(() => startSensorService())
              .then(
                (r) => {
                  try {
                    trace('svc start ' + r)
                  } catch (e5) {}
                },
                (e) => {
                  try {
                    trace('svc start fail ' + (e && e.message))
                  } catch (e5) {}
                }
              )
          }
        } else {
          this.lastSvcBlank = false
          let scanText = ''
          try {
            const stats =
              this.pageClient && this.pageClient.scanStats ? this.pageClient.scanStats() : null
            if (stats) scanText = ' scans=' + stats.n + ' scanS=' + stats.sec
          } catch (e4) {}
          if (!dead) {
            trace(
              'svc alive ' + age + 's run=' + flag + ' bat=' + this.lastBattery + '%' + scanText
            )
          } else {
            trace(
              'svc dead ' + age + 's run=' + flag + ' bat=' + this.lastBattery + '%' + scanText
            )
            if (
              getSessionWanted() &&
              seenAt &&
              now - seenAt > SVC_DEAD_RESTART_MS &&
              now - (this.lastSvcRestartAt || 0) >= SVC_RESTART_EVERY_MS
            ) {
              this.lastSvcRestartAt = now
              try {
                trace('svc restart')
              } catch (e4) {}
              stopSensorService()
                .then(() => startSensorService())
                .then(
                  (r) => {
                    try {
                      trace('svc start ' + r)
                    } catch (e5) {}
                  },
                  (e) => {
                    try {
                      trace('svc start fail ' + (e && e.message))
                    } catch (e5) {}
                  }
                )
            }
          }
        }
      } catch (e) {}
    },

    noteBleStuck() {
      try {
        saveBleStuckAt()
      } catch (e) {}
      this.setStatus('Watch Bluetooth stuck\nReboot the watch')
      const now = Date.now()
      if (now - (this.bleStuckNotedAt || 0) < BLE_STUCK_NAG_MS) return
      let sent = false
      try {
        sent = postSignalAlarm('No glucose: watch Bluetooth stuck. Reboot the watch') !== false
      } catch (e) {}
      if (sent) this.bleStuckNotedAt = now
    },

    maybeAlertStoredStuck() {
      let live = null
      try {
        live = loadLiveState()
      } catch (e) {}
      if (!live || !live.bleStuckAt) return
      const now = Date.now()
      const readingAge = live.at ? now - live.at : Infinity
      const client = this.pageClient
      const packetAt = client && client.lastPacketAt ? client.lastPacketAt() : 0
      const quiet = packetAt ? now - packetAt : Infinity
      if (readingAge > READING_STALE_MS && quiet > BLE_STUCK_NAG_MS) {
        this.noteBleStuck()
      }
    },

    rebuildIfStalled() {
      this.maybeAlertStoredStuck()
      const client = this.pageClient
      const due = client && client.retryDueAt ? client.retryDueAt() : 0
      if (due && due > Date.now()) return
      const packetAt = client && client.lastPacketAt ? client.lastPacketAt() : 0
      if (
        getSessionWanted() &&
        packetAt &&
        !(client.isBusy && client.isBusy()) &&
        Date.now() - packetAt > 3 * 60 * 1000 &&
        Date.now() - (this.lastClientStatusAt || 0) > 90000 &&
        Date.now() - (this.lastStallRebuildAt || 0) >= 5 * 60 * 1000
      ) {
        this.lastStallRebuildAt = Date.now()
        try {
          if (client && client.park) client.park()
        } catch (e) {}
        this.pageClient = null
        clearHeldClient()
        this.startPageClient()
      }
    },

    resumeSession() {
      this.setRelaunch(true)
      this.startPageClient()
      startSensorService().catch(() => {})
    },

    startPageClient() {
      this.lastClientStatusAt = Date.now()
      const hooks = {
        onStatus: (text) => {
          this.lastClientStatusAt = Date.now()
          this.setStatus(text)
        },
        onGlucose: (sample) => this.showGlucose(sample),
        onMinute: () => {
          this.touchUiAlive()
          this.rebuildIfStalled()
          this.checkServiceAlive()
        },
        onConnected: () => {
          this.setRelaunch(true)
          this.setConnected(true)
        },
        onDisconnected: () => {
          relaxPageAwake()
          this.setConnected(false)
        },
        onKeepAwake: (on) => {
          if (on) keepHandshakeAwake()
          else {
            keepPageAwake()
            relaxPageAwake()
          }
        },
        onUnlockRejected: (n) => this.recoverFromRejectedUnlock(n),
        onBleStuck: () => {
          this.noteBleStuck()
        }
      }
      const force = getNeedsForceResume()
      setNeedsForceResume(false)
      const held = getHeldClient()
      if (held) {
        try {
          const linked = held.isLinked && held.isLinked()
          const at = held.lastPacketAt ? held.lastPacketAt() : 0
          const age = at ? Date.now() - at : Infinity
          if (linked) {
            this.pageClient = held
            held.setHooks(hooks)
            if (held.rearmWatchdog) held.rearmWatchdog()
            if (age < 150000) {
              this.setConnected(true)
              const sec = Math.floor(age / 1000)
              this.setStatus(
                sec < 20
                  ? 'Live'
                  : sec < 60
                    ? 'Live · ' + sec + 's ago'
                    : 'Live · ' + Math.floor(sec / 60) + 'm ago'
              )
              return
            }
            this.setConnected(true)
            this.setStatus('Reconnecting…')
            try {
              trace('held stale-reuse ' + Math.round(age / 1000) + 's')
            } catch (e) {}
            if (held.resumeStale) held.resumeStale()
            return
          }
        } catch (e) {}
        const wanted = held.isWanted && held.isWanted()
        if (wanted && !force) {
          this.pageClient = held
          if (held.setHooks) held.setHooks(hooks)
          if (held.rearmWatchdog) held.rearmWatchdog()
          const busy = held.isBusy && held.isBusy()
          if (!busy && held.kick) held.kick()
          else if (busy) {
            try {
              trace('held busy-reuse')
            } catch (e) {}
          }
          this.setStatus(busy ? 'Scanning…' : 'Reconnecting…')
          return
        }
        try {
          if (held.park) held.park()
          else if (held.disconnect) held.disconnect()
        } catch (e) {}
        clearHeldClient()
      }
      this.setStatus(force || held ? 'Reconnecting…' : 'Connecting…')
      this.pageClient = createSensorClient(hooks)
      holdClient(this.pageClient)
      this.pageClient.connect()
    },

    chartWindowMin() {
      return CHART_WINDOWS[this.windowIdx] || CHART_WINDOWS[0]
    },

    chartWindowMs() {
      return this.chartWindowMin() * 60 * 1000
    },

    chartStepMs() {
      return (this.chartWindowMin() / 2) * 60 * 1000
    },

    chartMaxBackMs() {
      return (CHART_HOURS * 60 - this.chartWindowMin()) * 60 * 1000
    },

    /** Earliest timestamp the current chart window needs loaded. */
    chartNeedFromMs() {
      return Date.now() - (this.chartBackMs || 0) - this.chartWindowMs()
    },

    chartRange(list) {
      const alarms = getAlarms()
      const highAlarm = (alarms && alarms.high && alarms.high.mmol) || 10
      let tall = highAlarm > 12.0
      const pts = list || []
      if (!tall) {
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i]
          if (p && p.mmol > 12.05) {
            tall = true
            break
          }
        }
      }
      return {
        min: CHART_MIN,
        max: tall ? CHART_TOP_MAX : CHART_MAX,
        ticks: tall ? CHART_TICKS_TALL : CHART_TICKS
      }
    },

    axisHourStep() {
      const win = this.chartWindowMin()
      if (win >= 720) return 3
      if (win >= 360) return 2
      return 1
    },

    axisTicks(tStart, tEnd) {
      const stepH = this.axisHourStep()
      const start = new Date(tStart)
      start.setMinutes(0, 0, 0)
      let t = start.getTime()
      if (t < tStart) t += 60 * 60 * 1000
      const out = []
      while (t <= tEnd) {
        const h = new Date(t).getHours()
        if (h % stepH === 0) out.push(t)
        t += 60 * 60 * 1000
      }
      return out
    },

    bindChartTap(w) {
      if (!w || !event || !w.addEventListener) return false
      try {
        w.addEventListener(event.CLICK_UP, (info) => {
          if (this.settingsOpen) return
          this.onChartTap(info)
        })
        return true
      } catch (e) {
        return false
      }
    },

    onChartTap(info) {
      let x = info && info.x != null ? Number(info.x) : NaN
      if (!Number.isFinite(x)) return
      if (x >= CHART.x) x = x - CHART.x
      const third = CHART.w / 3
      if (x < third) this.stepChart(1)
      else if (x > third * 2) this.stepChart(-1)
      else {
        this.chartBackMs = 0
        this.drawChart()
      }
    },

    selectWindow(i) {
      const idx = Math.max(0, Math.min(CHART_WINDOWS.length - 1, i))
      if (idx === this.windowIdx) return
      this.windowIdx = idx
      try {
        setChartWindow(idx)
      } catch (e) {}
      this.chartBackMs = this.clampChartBack(this.chartBackMs || 0)
      this.chartDirty = true
      this.drawChart()
      if (this.tfOpen) this.styleTfChips()
    },

    initChart() {
      this.chartC = null
      this.chartBars = []
      this.scaleLabels = []
      this.chartBackMs = 0
      this.axisLabels = []
      this.chartBg = null
      try {
        this.chartBorderW = createWidget(widget.FILL_RECT, {
          x: CHART.x,
          y: CHART.y,
          w: CHART.w,
          h: CHART.h,
          radius: CHART.radius || 18,
          color: COLORS.grid
        })
      } catch (e) {}
      try {
        this.chartBg = createWidget(widget.FILL_RECT, {
          x: CHART.x + 1,
          y: CHART.y + 1,
          w: CHART.w - 2,
          h: CHART.h - 2,
          radius: Math.max(4, (CHART.radius || 18) - 1),
          color: COLORS.chartBg
        })
      } catch (e) {
        this.chartBg = null
      }
      try {
        if (widget.CANVAS) {
          this.chartC = createWidget(widget.CANVAS, {
            x: CHART.x,
            y: CHART.y,
            w: CHART.w,
            h: CHART.h
          })
          if (this.chartC && typeof this.chartC.drawLine !== 'function') {
            this.chartC = null
          }
        }
      } catch (e) {
        this.chartC = null
      }
      let tapped = this.bindChartTap(this.chartC)
      if (!tapped) tapped = this.bindChartTap(this.chartBg)
      if (!tapped) {
        try {
          createWidget(widget.TEXT, {
            ...CHART_TAP,
            click_func: (info) => {
              if (this.settingsOpen) return
              this.onChartTap(info)
            }
          })
        } catch (e) {}
      }
      const padT = CHART_PAD_T
      const innerH = CHART.h - CHART_PAD_T - CHART_PAD_B
      const labelH = CHART_SCALE_LABEL_H
      const scaleN = Math.max(CHART_TICKS.length, CHART_TICKS_TALL.length)
      for (let i = 0; i < scaleN; i++) {
        try {
          this.scaleLabels.push(
            createWidget(widget.TEXT, {
              x: CHART.x + CHART.w - CHART_GUTTER,
              y: CHART.y,
              w: CHART_GUTTER - CHART_SCALE_PAD_R,
              h: labelH,
              color: COLORS.axisText,
              text_size: CHART_SCALE_SIZE,
              align_h: align.RIGHT,
              align_v: align.CENTER_V,
              text: ''
            })
          )
        } catch (e) {}
      }
      this.updateScaleLabels(CHART_MIN, CHART_MAX, padT, innerH, CHART_TICKS)
      const axisW = CHART_AXIS_LABEL_W
      for (let i = 0; i < 6; i++) {
        try {
          this.axisLabels.push(
            createWidget(widget.TEXT, {
              ...CHART_AXIS,
              x: CHART.x + CHART_PAD_L,
              w: axisW,
              align_h: align.CENTER_H,
              text: ''
            })
          )
        } catch (e) {}
      }
    },

    clampChartBack(ms) {
      return Math.max(0, Math.min(this.chartMaxBackMs(), ms))
    },

    stepChart(dir) {
      this.chartBackMs = this.clampChartBack((this.chartBackMs || 0) + dir * this.chartStepMs())
      this.drawChart()
    },

    updateScaleLabels(min, max, padT, innerH, ticks) {
      if (!this.scaleLabels || !this.scaleLabels.length) return
      const labelH = CHART_SCALE_LABEL_H
      const visible = ticks || CHART_TICKS
      for (let i = 0; i < this.scaleLabels.length; i++) {
        const w = this.scaleLabels[i]
        if (!w) continue
        const mmol = visible[i]
        if (mmol == null) {
          try {
            w.setProperty(prop.MORE, {
              x: CHART.x + CHART.w - CHART_GUTTER,
              y: CHART.y,
              w: CHART_GUTTER - CHART_SCALE_PAD_R,
              h: labelH,
              text: ''
            })
          } catch (e) {
            setText(w, '', COLORS.axis)
          }
          continue
        }
        const cy = CHART.y + yAt(mmol, min, max, padT, innerH)
        const text = String(mmol)
        let y = Math.round(cy - labelH / 2)
        let alignV = align.CENTER_V
        if (y < CHART.y) {
          y = CHART.y
          alignV = align.TOP
        } else if (y + labelH > CHART_AXIS.y) {
          y = CHART_AXIS.y - labelH
          alignV = align.BOTTOM
        }
        try {
          w.setProperty(prop.MORE, {
            x: CHART.x + CHART.w - CHART_GUTTER,
            y: y,
            w: CHART_GUTTER - CHART_SCALE_PAD_R,
            h: labelH,
            text: text,
            align_v: alignV
          })
        } catch (e) {
          setText(w, text, COLORS.axis)
        }
      }
    },

    updateChartAxis(tStart, tEnd, xAtTime) {
      if (!this.axisLabels || !this.axisLabels.length) return
      const padL = CHART_PAD_L
      const innerW = CHART.w - CHART_PAD_L - CHART_GUTTER
      const span = Math.max(1, tEnd - tStart)
      const atX = (at) =>
        xAtTime ? xAtTime(at) : padL + ((at - tStart) / span) * innerW
      const labelW = CHART_AXIS_LABEL_W
      const ticks = this.axisTicks(tStart, tEnd)
      const left = CHART.x + CHART_AXIS_INSET
      const right = CHART.x + CHART.w - CHART_GUTTER
      const slots = []
      for (let i = 0; i < ticks.length; i++) {
        let x = Math.round(CHART.x + atX(ticks[i]) - labelW / 2)
        let alignH = align.CENTER_H
        if (x < left) {
          x = left
          alignH = align.LEFT
        } else if (x + labelW > right) {
          x = right - labelW
          alignH = align.RIGHT
        }
        slots.push({ x: x, alignH: alignH, text: fmtClock(ticks[i]), skip: false })
      }
      let lastShown = -1
      for (let i = 0; i < slots.length; i++) {
        if (lastShown >= 0 && slots[i].x < slots[lastShown].x + labelW) {
          slots[lastShown].skip = true
        }
        lastShown = i
      }
      for (let i = 0; i < this.axisLabels.length; i++) {
        const w = this.axisLabels[i]
        if (!w) continue
        const slot = slots[i] && !slots[i].skip ? slots[i] : null
        if (!slot) {
          try {
            w.setProperty(prop.MORE, {
              x: left,
              y: CHART_AXIS.y,
              w: labelW,
              h: CHART_AXIS.h,
              text: ''
            })
          } catch (e) {
            setText(w, '', COLORS.axis)
          }
          continue
        }
        try {
          w.setProperty(prop.MORE, {
            x: slot.x,
            y: CHART_AXIS.y,
            w: labelW,
            h: CHART_AXIS.h,
            text: slot.text,
            align_h: slot.alignH
          })
        } catch (e) {
          setText(w, slot.text, COLORS.axis)
        }
      }
    },

    drawChart(points) {
      const list = points || loadHistory(this.chartNeedFromMs())
      if (this.chartC) {
        this.drawCanvasChart(list)
        return
      }
      this.drawBarChart(list)
    },

    drawCanvasChart(points) {
      const c = this.chartC
      const win = visibleWindow(points, this.chartBackMs, this.chartWindowMs())
      const list = downsample(win.list, CHART_DRAW_MAX)
      const tStart = win.tStart
      const tEnd = win.tEnd
      const windowMs = this.chartWindowMs()
      const gapMs = Math.max(8 * 60000, (2 * windowMs) / CHART_DRAW_MAX)
      const w = CHART.w
      const h = CHART.h
      const range = this.chartRange(win.list)
      const min = range.min
      const max = range.max
      const padL = CHART_PAD_L
      const padR = CHART_GUTTER
      const padT = CHART_PAD_T
      const innerW = w - padL - padR
      const innerH = h - CHART_PAD_T - CHART_PAD_B
      const span = Math.max(1, tEnd - tStart)
      this.updateScaleLabels(min, max, padT, innerH, range.ticks)
      try {
        if (typeof c.clear === 'function') {
          c.clear({ x: 0, y: 0, w: w, h: h })
        }
      } catch (e) {}
      try {
        c.drawRect({
          x1: 0,
          y1: 0,
          x2: w - 1,
          y2: h - 1,
          color: COLORS.chartBg
        })
      } catch (e) {}

      const paintLine = (x1, y1, x2, y2, color, width) => {
        try {
          if (typeof c.setPaint === 'function') {
            c.setPaint({ color, line_width: width || 2 })
          }
          c.drawLine({ x1, y1, x2, y2, color })
        } catch (e) {}
      }

      const alarms = getAlarms()
      const lowAlarm = (alarms && alarms.low && alarms.low.mmol) || 3.9
      const highAlarm = (alarms && alarms.high && alarms.high.mmol) || 10.0

      if (highAlarm >= min && lowAlarm <= max) {
        const yHi = yAt(highAlarm, min, max, padT, innerH)
        const yLo = yAt(lowAlarm, min, max, padT, innerH)
        const y1 = Math.max(padT, Math.min(yHi, yLo))
        const y2 = Math.min(padT + innerH, Math.max(yHi, yLo))
        try {
          c.drawRect({
            x1: padL,
            y1: y1,
            x2: padL + innerW,
            y2: y2,
            color: COLORS.band
          })
        } catch (e) {}
      }
      for (let i = 0; i < range.ticks.length; i++) {
        const y = yAt(range.ticks[i], min, max, padT, innerH)
        paintLine(padL, y, padL + innerW, y, COLORS.grid, 1)
      }
      const paintThreshold = (mmol, color) => {
        if (mmol < min || mmol > max) return
        const y = yAt(mmol, min, max, padT, innerH)
        paintLine(padL, y, padL + innerW, y, color, 2)
      }
      paintThreshold(lowAlarm, COLORS.bad)
      paintThreshold(highAlarm, COLORS.warn)

      const xAtTime = (at) => padL + ((at - tStart) / span) * innerW
      const ticks = this.axisTicks(tStart, tEnd)
      for (let i = 0; i < ticks.length; i++) {
        const x = xAtTime(ticks[i])
        if (x < padL || x > padL + innerW) continue
        paintLine(x, padT, x, padT + innerH, COLORS.grid, 1)
      }
      if (!this.chartBackMs) {
        paintLine(padL + innerW, padT, padL + innerW, padT + innerH, COLORS.nowLine, 2)
      }

      this.updateChartAxis(tStart, tEnd, xAtTime)
      if (!list.length) return

      const n = list.length
      for (let i = 1; i < n; i++) {
        const dt = (list[i].at || 0) - (list[i - 1].at || 0)
        if (dt > gapMs) continue
        paintLine(
          xAtTime(list[i - 1].at),
          yAt(list[i - 1].mmol, min, max, padT, innerH),
          xAtTime(list[i].at),
          yAt(list[i].mmol, min, max, padT, innerH),
          glucoseColor(list[i].mmol),
          CHART_LINE_W
        )
      }

      const last = list[n - 1]
      const lx = xAtTime(last.at)
      const ly = yAt(last.mmol, min, max, padT, innerH)
      const dot = glucoseColor(last.mmol)
      try {
        if (typeof c.drawCircle === 'function') {
          c.drawCircle({
            center_x: lx,
            center_y: ly,
            radius: CHART_DOT_HALO_R,
            color: COLORS.chartBg
          })
          c.drawCircle({
            center_x: lx,
            center_y: ly,
            radius: CHART_DOT_R,
            color: dot
          })
        } else {
          c.drawRect({
            x1: lx - CHART_DOT_R,
            y1: ly - CHART_DOT_R,
            x2: lx + CHART_DOT_R,
            y2: ly + CHART_DOT_R,
            color: dot
          })
        }
      } catch (e) {}
    },

    drawBarChart(points) {
      const win = visibleWindow(points, this.chartBackMs, this.chartWindowMs())
      const bars = downsample(win.list, 36)
      if (!this.chartBars) this.chartBars = []
      const maxBars = 36
      while (this.chartBars.length < maxBars) {
        try {
          this.chartBars.push(
            createWidget(widget.FILL_RECT, {
              x: CHART.x,
              y: CHART.y + CHART.h,
              w: 1,
              h: 1,
              color: COLORS.chartLine
            })
          )
        } catch (e) {
          break
        }
      }
      const range = this.chartRange(win.list)
      const min = range.min
      const max = range.max
      const plotW = CHART.w - CHART_GUTTER - CHART_PAD_L - 8
      const barW = Math.max(3, Math.floor((plotW - (maxBars - 1) * 2) / maxBars))
      const startX = CHART.x + CHART_PAD_L
      const innerH = CHART.h - CHART_PAD_T - CHART_PAD_B
      const baseY = CHART.y + CHART_PAD_T + innerH
      const span = Math.max(1, win.tEnd - win.tStart)
      const padL = CHART_PAD_L
      const innerW = CHART.w - CHART_PAD_L - CHART_GUTTER
      const xAtTime = (at) => padL + ((at - win.tStart) / span) * innerW
      this.updateScaleLabels(min, max, CHART_PAD_T, innerH, range.ticks)
      this.updateChartAxis(win.tStart, win.tEnd, xAtTime)
      for (let i = 0; i < this.chartBars.length; i++) {
        const bar = this.chartBars[i]
        const point = bars[i]
        if (!point) {
          try {
            bar.setProperty(prop.MORE, {
              x: startX,
              y: baseY,
              w: 1,
              h: 1
            })
          } catch (e) {}
          continue
        }
        const v = Math.max(min, Math.min(max, point.mmol))
        const bh = Math.max(3, Math.round(((v - min) / (max - min)) * innerH))
        const x = startX + ((point.at - win.tStart) / span) * (plotW - barW)
        try {
          bar.setProperty(prop.MORE, {
            x: Math.round(x),
            y: baseY - bh,
            w: barW,
            h: bh
          })
          bar.setProperty(prop.COLOR, glucoseColor(point.mmol))
        } catch (e) {}
      }
    },

    isStale() {
      return !!(this.lastAt && Date.now() - this.lastAt > STALE_GRAY_MS)
    },

    paintReading(sample) {
      const mmol = sample.mmol || 0
      const at = sample.at || 0
      const err = !!sample.hasError
      this.lastHasError = err
      this.lastMmol = mmol
      if (sample.rawMmol) this.lastRawMmol = sample.rawMmol
      if (sample.at) this.lastAt = sample.at
      if (sample.wearMinutes != null && sample.wearMinutes !== '') {
        this.lastWearMinutes = sample.wearMinutes
      }
      if (this.uiPaused) {
        this.chartDirty = true
        return
      }
      const stale = this.isStale()
      const ageMin = stale && this.lastAt ? Math.max(1, Math.floor((Date.now() - this.lastAt) / 60000)) : 0
      if (
        at === this.lastPaintAt &&
        mmol === this.lastPaintMmol &&
        err === this.lastPaintErr &&
        stale === this.lastPaintStale &&
        (!stale || ageMin === this.lastPaintAgeMin)
      ) {
        if (this.lastMmol) this.hideStatus()
        return
      }
      const zoneColor = sample.hasError ? COLORS.bad : glucoseColor(mmol)
      const color = stale ? COLORS.muted : zoneColor
      const glucoseText = sample.hasError ? 'err' : fmtMmol(mmol)
      const trend = sample.hasError
        ? { arrow: '', delta: '' }
        : trendFromHistory(mmol, sample.at || this.lastAt)
      const trendSrcPath = trend.arrow ? trendSrc(trend.arrow, trendColorKey(zoneColor)) : ''
      let deltaText = trend.delta
      let deltaColor = COLORS.muted
      if (sample.hasError) {
        deltaText = this.lastLog || 'Sensor reading error'
        deltaColor = COLORS.warn
      } else if (stale) {
        deltaColor = COLORS.warn
        if (trend.delta) {
          deltaText = trend.delta + '  •  ' + ageMin + 'm ago'
        } else if (this.lastLog && this.lastLog.indexOf('Live') !== 0) {
          deltaText = ageMin + 'm ago  •  ' + this.lastLog.split('\n')[0]
        } else {
          deltaText = ageMin + 'm ago'
        }
      } else if (!deltaText) {
        deltaText = 'mmol/L'
      }
      if (glucoseText !== this.lastGlucoseText) {
        this.glucoseW = replaceTextWidget(this.glucoseW, GLUCOSE, glucoseText, color)
        this.lastGlucoseText = glucoseText
      } else {
        setText(this.glucoseW, glucoseText, color)
      }
      if (trendSrcPath !== this.lastTrendSrc) {
        this.trendW = replaceTrendImg(this.trendW, trendSrcPath)
        this.lastTrendSrc = trendSrcPath
      }
      if (this.unitW) {
        try {
          this.unitW.setProperty(prop.VISIBLE, !trendSrcPath)
        } catch (e) {}
      }
      if (deltaText !== this.lastDeltaText || deltaColor !== this.lastDeltaColor) {
        this.deltaW = replaceTextWidget(this.deltaW, DELTA, deltaText, deltaColor)
        this.lastDeltaText = deltaText
        this.lastDeltaColor = deltaColor
      } else {
        setText(this.deltaW, deltaText, deltaColor)
      }
      this.lastPaintAt = at
      this.lastPaintMmol = mmol
      this.lastPaintErr = err
      this.lastPaintStale = stale
      this.lastPaintAgeMin = ageMin
      this.updateStatusDot()
      if (this.lastMmol) this.hideStatus()
    },

    noteCalFit(fit) {
      const bText = (fit.b >= 0 ? '+' : '') + fit.b.toFixed(1)
      const key = fit.a.toFixed(2) + '|' + bText + '|' + fit.n
      if (key === this.lastCalFitKey) return
      this.lastCalFitKey = key
      try {
        trace('cal fit a=' + fit.a.toFixed(2) + ' b=' + bText + ' n=' + fit.n)
      } catch (e) {}
    },

    calibrateTrend(trend, fit) {
      const out = []
      for (let i = 0; i < trend.length; i++) {
        const p = trend[i]
        if (!p || !p.mmol) continue
        const mmol = applyCalFit(p.mmol, fit)
        out.push({
          mmol: mmol,
          minutesAgo: p.minutesAgo,
          rawMmol: p.mmol,
          mgdl: Math.round(mmol * MGDL_PER_MMOL)
        })
      }
      return out
    },

    showGlucose(sample, persist = true) {
      let mmol = sample.mmol || 0
      let rawMmol = sample.rawMmol || 0
      let mgdl = sample.mgdl
      if (persist && !sample.hasError) {
        const raw = rawMmol || mmol
        if (raw) {
          rawMmol = raw
          const fit = getCalFit()
          mmol = applyCalFit(raw, fit)
          mgdl = Math.round(mmol * MGDL_PER_MMOL)
          this.noteCalFit(fit)
          if (sample.trend && sample.trend.length) {
            try {
              backfillHistory(this.calibrateTrend(sample.trend, fit))
            } catch (e) {}
          }
        }
      }
      if (sample.at) this.lastAt = sample.at
      if (persist) {
        const at = Date.now()
        this.lastAt = at
        if (sample.hasError) {
          this.setStatus('Sensor sent an error frame')
        }
        keepPageAwake()
        saveLastReading({
          mmol,
          rawMmol: rawMmol || this.lastRawMmol || mmol,
          mgdl,
          wearMinutes: sample.wearMinutes,
          hasError: sample.hasError,
          at
        })
        if (!sample.hasError && mmol) {
          this.bleStuckNotedAt = 0
          const zone = zoneForMmol(mmol)
          if (zone !== 'ok' && zone !== this.alertZone) {
            postGlucoseAlarm(zone, mmol)
          }
          this.alertZone = zone
        }
        this.clearRelaunchTimer()
        this.checkServiceAlive()
      }
      if (mmol && !sample.hasError) {
        pushHistory({
          mmol,
          rawMmol: rawMmol || sample.rawMmol || this.lastRawMmol || mmol,
          wearMinutes: sample.wearMinutes,
          at: this.lastAt || sample.at || Date.now(),
          hasError: false
        })
      }
      this.paintReading({
        mmol,
        rawMmol: rawMmol || sample.rawMmol || this.lastRawMmol || mmol,
        hasError: sample.hasError,
        at: this.lastAt || sample.at,
        wearMinutes:
          sample.wearMinutes != null ? sample.wearMinutes : this.lastWearMinutes
      })
      if (this.uiPaused) this.chartDirty = true
      else this.drawChart()
    }
  })
)
