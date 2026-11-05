import { set as alarmSet, cancel as alarmCancel } from '@zos/alarm'

const SERVICE_FILE = 'app-service/sensor'

export function later(ms, fn) {
  if (typeof setTimeout === 'function') {
    return { kind: 'timeout', id: setTimeout(fn, ms) }
  }
  if (ms < 500) {
    fn()
    return null
  }
  try {
    const id = alarmSet({
      url: SERVICE_FILE,
      delay: Math.max(1, Math.ceil(ms / 1000)),
      param: 'retry'
    })
    return { kind: 'alarm', id }
  } catch (e) {
    return null
  }
}

export function cancelLater(handle) {
  if (!handle) return
  if (handle.kind === 'timeout' && typeof clearTimeout === 'function') {
    clearTimeout(handle.id)
    return
  }
  if (handle.kind === 'alarm') {
    try {
      alarmCancel(handle.id)
    } catch (e) {}
  }
}

export function every(ms, fn) {
  if (typeof setInterval === 'function') {
    return { kind: 'interval', id: setInterval(fn, ms) }
  }
  return null
}

export function cancelEvery(handle) {
  if (!handle) return
  if (handle.kind === 'interval' && typeof clearInterval === 'function') {
    clearInterval(handle.id)
  }
}
