import { notify } from '@zos/notification'
import { Vibrator, VIBRATOR_SCENE_CALL, VIBRATOR_SCENE_TIMER } from '@zos/sensor'
import { create as createMedia, id as mediaId } from '@zos/media'
import { getAlarms } from './session'
import { trace, flushTrace } from './trace'

const ALARM_COOLDOWN_MS = 60000
const MIN_ALARM_VOLUME = 85
const ALARM_FILE = 'alarm.mp3'

let vibrator = null
let vibrateTimer = 0
let player = null
let audioStopTimer = 0
let audioEndAt = 0
let savedVolume = -1
let lastAlarmAt = 0
let lastAlarmZone = 'ok'

function safeTrace(msg) {
  try {
    trace(msg)
  } catch (e) {}
}

function getVibrator() {
  if (!vibrator) {
    try {
      vibrator = new Vibrator()
    } catch (e) {}
  }
  return vibrator
}

function stopVibrate() {
  if (vibrateTimer) {
    try {
      if (typeof clearTimeout === 'function') clearTimeout(vibrateTimer)
    } catch (e) {}
    vibrateTimer = 0
  }
  if (!vibrator) return
  try {
    vibrator.stop()
  } catch (e) {}
}

function releaseCurrentPlayer(restoreVol) {
  const p = player
  player = null
  if (!p) return
  try {
    p.stop()
  } catch (e) {}
  if (restoreVol && savedVolume >= 0) {
    try {
      p.setVolume(savedVolume)
    } catch (e) {}
    savedVolume = -1
  }
}

export function stopAlertAudio() {
  audioEndAt = 0
  if (audioStopTimer) {
    try {
      if (typeof clearTimeout === 'function') clearTimeout(audioStopTimer)
    } catch (e) {}
    audioStopTimer = 0
  }
  releaseCurrentPlayer(true)
}

function startOneCycle(retried) {
  if (!audioEndAt || Date.now() >= audioEndAt) {
    stopAlertAudio()
    return
  }
  releaseCurrentPlayer(false)
  let p = null
  try {
    if (typeof createMedia === 'function' && mediaId && mediaId.PLAYER != null) {
      p = createMedia(mediaId.PLAYER)
    }
  } catch (e) {
    safeTrace('audio create err ' + ((e && e.message) || e))
    p = null
  }
  if (!p) {
    safeTrace('audio player unavailable')
    try {
      flushTrace()
    } catch (e) {}
    stopAlertAudio()
    return
  }
  player = p

  try {
    if (typeof p.getVolume === 'function' && typeof p.setVolume === 'function') {
      const cur = Number(p.getVolume())
      if (Number.isFinite(cur) && cur >= 0 && cur < MIN_ALARM_VOLUME) {
        if (savedVolume < 0) savedVolume = cur
        const ok = p.setVolume(MIN_ALARM_VOLUME)
        safeTrace('audio vol cur=' + cur + ' set=' + MIN_ALARM_VOLUME + ' ok=' + (ok ? 1 : 0))
      } else {
        safeTrace('audio vol cur=' + cur)
      }
    }
  } catch (e) {}

  try {
    p.addEventListener(p.event.PREPARE, (result) => {
      if (p !== player) return
      if (!audioEndAt || Date.now() >= audioEndAt) {
        stopAlertAudio()
        return
      }
      if (!result) {
        let st = -1
        try {
          if (typeof p.getStatus === 'function') st = p.getStatus()
        } catch (e) {}
        safeTrace('audio prepare fail status=' + st + ' retry=' + (retried ? 1 : 0))
        if (!retried) {
          startOneCycle(true)
        } else {
          stopAlertAudio()
        }
        return
      }
      try {
        p.start()
      } catch (e) {
        safeTrace('audio start err ' + ((e && e.message) || e))
        stopAlertAudio()
      }
    })
  } catch (e) {}

  try {
    if (p.event && p.event.PLAY != null) {
      p.addEventListener(p.event.PLAY, (result) => {
        if (p !== player) return
        safeTrace('audio play result=' + (result ? 1 : 0))
        if (result === false) {
          stopAlertAudio()
        }
      })
    }
  } catch (e) {}

  try {
    p.addEventListener(p.event.COMPLETE, () => {
      if (p !== player) return
      if (audioEndAt && Date.now() + 250 < audioEndAt) {
        startOneCycle(false)
        return
      }
      stopAlertAudio()
    })
  } catch (e) {}

  try {
    p.setSource(p.source.FILE, { file: ALARM_FILE })
    p.prepare()
  } catch (e) {
    safeTrace('audio prepare throw ' + ((e && e.message) || e))
    if (!retried) {
      startOneCycle(true)
    } else {
      stopAlertAudio()
    }
  }
}

function playAlertAudio(durationMs) {
  stopAlertAudio()
  audioEndAt = Date.now() + durationMs
  if (typeof setTimeout === 'function') {
    audioStopTimer = setTimeout(() => {
      audioStopTimer = 0
      stopAlertAudio()
    }, durationMs + 400)
  }
  startOneCycle(false)
}

function startAlertVibrate(durationMs) {
  try {
    const v = getVibrator()
    if (!v) return
    stopVibrate()
    const scene = VIBRATOR_SCENE_CALL != null ? VIBRATOR_SCENE_CALL : VIBRATOR_SCENE_TIMER
    try {
      v.setMode({ mode: scene })
    } catch (e) {
      try {
        v.setMode(scene)
      } catch (e2) {}
    }
    try {
      v.start({ mode: scene })
    } catch (e) {
      try {
        v.start()
      } catch (e2) {}
    }
    if (typeof setTimeout === 'function') {
      vibrateTimer = setTimeout(() => {
        vibrateTimer = 0
        try {
          v.stop()
        } catch (e3) {}
      }, durationMs)
    }
  } catch (e) {}
}

export function playTestAlert(durationSec) {
  const sec = Math.max(1, Math.min(10, Number(durationSec) || 2))
  const ms = sec * 1000
  safeTrace('alarm test dur=' + sec + 's')
  startAlertVibrate(ms)
  playAlertAudio(ms)
}

const SIGNAL_ALARM_COOLDOWN_MS = 10 * 60 * 1000
let lastSignalAlarmAt = 0

/** Loud alert when no glucose can be read (BLE stuck, signal lost). */
export function postSignalAlarm(content, durationSec) {
  const now = Date.now()
  if (lastSignalAlarmAt && now - lastSignalAlarmAt < SIGNAL_ALARM_COOLDOWN_MS) return false
  lastSignalAlarmAt = now
  const sec = Math.max(1, Math.min(10, Number(durationSec) || 3))
  safeTrace('alarm signal ' + content)
  try {
    flushTrace()
  } catch (e) {}
  try {
    notify({
      title: 'AmazCGM',
      content: content,
      vibrate: 5,
      actions: [{ text: 'Open', file: 'page/index' }]
    })
  } catch (e) {}
  startAlertVibrate(sec * 1000)
  playAlertAudio(sec * 1000)
  return true
}

export function zoneForMmol(mmol) {
  const n = Number(mmol)
  if (!Number.isFinite(n) || n <= 0) return 'ok'
  const a = getAlarms()
  if (n <= a.low.mmol) return 'hypo'
  if (n >= a.high.mmol) return 'hyper'
  return 'ok'
}

export function postGlucoseAlarm(zone, mmol) {
  if (zone !== 'hypo' && zone !== 'hyper') {
    lastAlarmZone = 'ok'
    return
  }
  const now = Date.now()
  if (zone === lastAlarmZone && now - lastAlarmAt < ALARM_COOLDOWN_MS) return
  lastAlarmZone = zone
  lastAlarmAt = now

  const a = getAlarms()
  const cfg = zone === 'hypo' ? a.low : a.high
  const durationSec = Math.max(1, Math.min(10, Number(cfg.duration) || 3))
  const durationMs = durationSec * 1000
  const text = Number(mmol).toFixed(1) + ' mmol/L'
  const sound = !!cfg.sound
  safeTrace(
    'alarm ' +
      zone +
      ' ' +
      Number(mmol).toFixed(1) +
      ' sound=' +
      (sound ? 1 : 0) +
      ' dur=' +
      durationSec +
      's'
  )
  try {
    flushTrace()
  } catch (e) {}

  try {
    notify({
      title: 'AmazCGM',
      content: zone === 'hypo' ? 'Low glucose ' + text : 'High glucose ' + text,
      vibrate: sound ? 5 : 1,
      actions: [{ text: 'Open', file: 'page/index' }]
    })
  } catch (e) {}

  startAlertVibrate(durationMs)
  if (sound) {
    playAlertAudio(durationMs)
  }
}
