import { start, stop, getAllAppServices } from '@zos/app-service'
import { queryPermission, requestPermission } from '@zos/app'
import { trace } from './trace'

export const SERVICE_FILE = 'app-service/sensor'

function granted(status) {
  return status && status[0] === 2
}

export function isSensorServiceRunning() {
  try {
    const list = getAllAppServices() || []
    for (let i = 0; i < list.length; i++) {
      const name = String(list[i] || '')
      if (name.indexOf('sensor') >= 0 || name.indexOf(SERVICE_FILE) >= 0) return true
    }
  } catch (e) {}
  return false
}

export function ensureBgPermission() {
  return new Promise((resolve, reject) => {
    const perms = ['device:os.bg_service', 'device:os.notification']
    const status = queryPermission({ permissions: perms })
    if (granted(status)) {
      resolve()
      return
    }
    requestPermission({
      permissions: perms,
      callback: (result) => {
        if (granted(result)) resolve()
        else reject(new Error('Background permission denied'))
      }
    })
  })
}

export function startSensorService() {
  return ensureBgPermission().then(
    () =>
      new Promise((resolve, reject) => {
        if (isSensorServiceRunning()) {
          resolve('already')
          return
        }
        let perm = ''
        try {
          const status = queryPermission({
            permissions: ['device:os.bg_service', 'device:os.notification']
          })
          perm = status == null ? 'null' : JSON.stringify(status)
        } catch (e) {
          perm = 'err'
        }
        const box = { rc: -1 }
        try {
          box.rc = start({
            file: SERVICE_FILE,
            reload: true,
            complete_func: (info) => {
              const result = info && info.result ? 1 : 0
              try {
                trace(
                  'svc start rc=' + box.rc + ' perm=' + perm + ' result=' + result
                )
              } catch (e) {}
              if (info && info.result) {
                resolve('started')
                return
              }
              if (isSensorServiceRunning()) {
                resolve('already')
                return
              }
              reject(new Error('Service start failed'))
            }
          })
        } catch (e) {
          try {
            trace(
              'svc start throw perm=' + perm + ' ' + (e && e.message ? e.message : e)
            )
          } catch (e2) {}
          reject(e instanceof Error ? e : new Error('Service start failed'))
          return
        }
        try {
          trace('svc start rc=' + box.rc + ' perm=' + perm)
        } catch (e) {}
      })
  )
}

export function stopSensorService() {
  return new Promise((resolve) => {
    if (!isSensorServiceRunning()) {
      resolve()
      return
    }
    stop({
      file: SERVICE_FILE,
      complete_func: () => resolve()
    })
  })
}
