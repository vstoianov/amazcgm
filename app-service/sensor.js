import { exit } from '@zos/app-service'
import { notify } from '@zos/notification'
import { Time } from '@zos/sensor'
import { set as alarmSet } from '@zos/alarm'
import { loadLiveState, saveSvcAliveAt, getAlarms } from '../shared/session'
import { trace } from '../shared/trace'

let alarmsMod = null

function alarmApi() {
  if (alarmsMod) return alarmsMod
  try {
    if (typeof require === 'function') {
      alarmsMod = require('../shared/alarms')
      try {
        trace('svc alarms lazy=require')
      } catch (e) {}
      return alarmsMod
    }
  } catch (e) {
    try {
      trace('svc alarms lazy err ' + (e && e.message ? e.message : e))
    } catch (e2) {}
  }
  try {
    trace('svc alarms lazy=notify-only')
  } catch (e) {}
  alarmsMod = { notifyOnly: true }
  return alarmsMod
}

function zoneForMmol(mmol) {
  const n = Number(mmol)
  if (!Number.isFinite(n) || n <= 0) return 'ok'
  try {
    const a = getAlarms()
    if (n <= a.low.mmol) return 'hypo'
    if (n >= a.high.mmol) return 'hyper'
  } catch (e) {}
  return 'ok'
}

function postGlucose(zone, mmol) {
  const m = alarmApi()
  if (m && m.postGlucoseAlarm) {
    m.postGlucoseAlarm(zone, mmol)
    return
  }
  const text = Number(mmol).toFixed(1) + ' mmol/L'
  post('AmazCGM', zone === 'hypo' ? 'Low glucose ' + text : 'High glucose ' + text, 5)
}

function postSignal(content) {
  const m = alarmApi()
  if (m && m.postSignalAlarm) {
    m.postSignalAlarm(content)
    return
  }
  post('AmazCGM', content, 5)
}

const STALE_MS = 3 * 60 * 1000
const RELAUNCH_EVERY_MS = 10 * 60 * 1000
const CLOSED_RELAUNCH_MS = 120000
const STALE_NAG_MS = 10 * 60 * 1000
const TICK_TRACE_MS = 5 * 60 * 1000
const SVC_GRACE_MS = 30000
const SIGNAL_LOST_MS = 20 * 60 * 1000

function post(title, content, vibrate) {
  try {
    notify({
      title: title,
      content: content,
      vibrate: vibrate || 0,
      actions: [{ text: 'Open', file: 'page/index' }]
    })
  } catch (e) {}
}

AppService({
  state: {
    timeSensor: null,
    staleNoted: false,
    alertZone: 'ok',
    startedAt: 0,
    lastRelaunchAt: 0,
    lastTraceAt: 0,
    rejectNoted: false,
    stuckNoted: false,
    lastGoodLive: null,
    unwantedCount: 0,
    uiDeadTicks: 0,
    timer: 0
  },

  onInit(params) {
    try {
      saveSvcAliveAt()
    } catch (e) {}
    this.state.staleNoted = false
    this.state.rejectNoted = false
    this.state.stuckNoted = false
    this.state.alertZone = 'ok'
    this.state.startedAt = Date.now()
    this.state.lastRelaunchAt = 0
    this.state.lastTraceAt = 0
    this.state.lastGoodLive = null
    this.state.unwantedCount = 0
    this.state.uiDeadTicks = 0

    try {
      const live = loadLiveState()
      const parsed = !!(live && live.parsed)
      const wanted = !!(live && live.wanted)
      const ageS = live && live.at ? Math.round((Date.now() - live.at) / 1000) : -1
      trace(
        'svc onInit params=' +
          (params == null ? '' : String(params)) +
          ' parsed=' +
          (parsed ? 1 : 0) +
          ' wanted=' +
          (wanted ? 1 : 0) +
          ' age=' +
          ageS +
          's'
      )
      if (parsed && wanted) {
        this.state.lastGoodLive = live
      }
    } catch (e) {
      try {
        trace('svc onInit err ' + (e && e.message ? e.message : e))
      } catch (e2) {}
    }

    this.checkReading(true)

    try {
      this.state.timeSensor = new Time()
      this.state.timeSensor.onPerMinute(() => this.checkReading(false, 'time'))
    } catch (e) {
      try {
        trace('svc timeSensor err ' + (e && e.message ? e.message : e))
      } catch (e2) {}
    }
    try {
      if (typeof setInterval === 'function') {
        this.state.timer = setInterval(() => this.checkReading(false, 'timer'), 60000)
      } else {
        trace('svc no setInterval')
      }
    } catch (e) {
      try {
        trace('svc timer err ' + (e && e.message ? e.message : e))
      } catch (e2) {}
    }
  },

  checkReading(silent, source) {
    try {
      const now = Date.now()
      try {
        saveSvcAliveAt()
      } catch (e) {}

      let rawLive = null
      try {
        rawLive = loadLiveState()
      } catch (e) {}

      const parsed = !!(rawLive && rawLive.parsed)
      let live = rawLive
      if (!parsed) {
        if (this.state.lastGoodLive) {
          live = this.state.lastGoodLive
        }
        try {
          trace('svc blank live reuse=' + (this.state.lastGoodLive ? 1 : 0))
        } catch (e) {}
      } else if (rawLive.wanted) {
        this.state.unwantedCount = 0
        this.state.lastGoodLive = rawLive
      } else {
        this.state.unwantedCount = (this.state.unwantedCount || 0) + 1
        if (this.state.unwantedCount >= 2) {
          try {
            trace('svc exit unwanted n=' + this.state.unwantedCount)
          } catch (e) {}
          try {
            exit()
          } catch (e) {}
          return
        }
        if (this.state.lastGoodLive) {
          live = this.state.lastGoodLive
        } else {
          return
        }
      }

      if (!live || (!live.wanted && !this.state.lastGoodLive)) {
        return
      }

      const age = live.at ? now - live.at : STALE_MS + 1
      const mmol = live.mmol || 0
      const zone = zoneForMmol(mmol)
      const uiFresh = !!(live.uiAliveAt && now - live.uiAliveAt < 20000)
      if (
        !silent &&
        !uiFresh &&
        zone !== 'ok' &&
        zone !== this.state.alertZone &&
        age < STALE_MS
      ) {
        postGlucose(zone, mmol)
      }
      this.state.alertZone = zone
      // The OS destroys this service ~60s after start (svc onDestroy in traces),
      // so the first per-minute tick must be allowed to act.
      const grace = now - (this.state.startedAt || 0) < SVC_GRACE_MS
      const lastAlive = Math.max(
        live.uiAliveAt || 0,
        live.pageClosedAt || 0,
        live.appClosedAt || 0
      )
      const uiDead = lastAlive > 0 && now - lastAlive > CLOSED_RELAUNCH_MS
      // The live file is written by another process without atomic rename,
      // so one read can be blank or carry an old snapshot. Relaunch only when
      // the UI looks dead on two consecutive ticks.
      if (!silent) {
        this.state.uiDeadTicks = uiDead ? (this.state.uiDeadTicks || 0) + 1 : 0
      }
      const uiDeadConfirmed = uiDead && (this.state.uiDeadTicks || 0) >= 2

      if (!silent) {
        try {
          trace('svc tick(' + (source || '?') + ')')
        } catch (e) {}
      }
      if (!silent && now - (this.state.lastTraceAt || 0) >= TICK_TRACE_MS) {
        this.state.lastTraceAt = now
        try {
          trace(
            'svc tick age=' +
              Math.round(age / 1000) +
              's ui=' +
              (lastAlive ? Math.round((now - lastAlive) / 1000) : -1) +
              's dead=' +
              (uiDead ? 1 : 0) +
              ' src=' +
              (source || '?')
          )
        } catch (e) {}
      }

      if (!silent && !grace && live.parsed && live.at && age > SIGNAL_LOST_MS) {
        // Covers any cause (stuck BLE, sensor out of range, page frozen).
        try {
          postSignal('No glucose for ' + Math.round(age / 60000) + ' min')
        } catch (e) {}
      }
      if (live.bleStuckAt && age > STALE_MS) {
        if (!silent && !grace && !this.state.stuckNoted) {
          this.state.stuckNoted = true
          postSignal('No glucose: watch Bluetooth stuck. Reboot the watch')
        }
      } else if (live.unlockRejectedAt && age > STALE_MS) {
        this.state.stuckNoted = false
        if (!silent && !grace && !this.state.rejectNoted) {
          this.state.rejectNoted = true
          post('AmazCGM', 'Sensor ignores unlock. Re-scan it with the phone, then Sync', 0)
        }
      } else {
        this.state.stuckNoted = false
        this.state.rejectNoted = false
        if (age > STALE_MS && !silent && !grace && uiDead && now - lastAlive > STALE_NAG_MS) {
          if (!this.state.staleNoted) {
            this.state.staleNoted = true
            post('AmazCGM', 'Open the app to reconnect the sensor', 0)
          }
        } else if (age <= STALE_MS || !uiDead) {
          this.state.staleNoted = false
        }
      }
      if (!uiDead || age <= STALE_MS) {
        this.state.lastRelaunchAt = 0
      } else if (
        !silent &&
        !grace &&
        uiDeadConfirmed &&
        live.wanted &&
        now - (this.state.lastRelaunchAt || 0) >= RELAUNCH_EVERY_MS
      ) {
        this.state.lastRelaunchAt = now
        try {
          trace(
            'svc relaunch ui=' +
              Math.round((now - lastAlive) / 1000) +
              's age=' +
              Math.round(age / 1000) +
              's'
          )
        } catch (e) {}
        try {
          alarmSet({ url: 'page/index', delay: 2, param: 'svc' })
        } catch (e) {}
      }
    } catch (e) {
      try {
        trace('svc tick err ' + (e && e.message ? e.message : e))
      } catch (e2) {}
    }
  },

  onDestroy() {
    if (this.state.timer) {
      try {
        if (typeof clearInterval === 'function') clearInterval(this.state.timer)
      } catch (e) {}
      this.state.timer = 0
    }
    try {
      trace('svc onDestroy')
    } catch (e) {}
  }
})
