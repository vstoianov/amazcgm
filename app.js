import { BaseApp } from '@zeppos/zml/base-app'
import { markAppClosed } from './shared/session'

App(
  BaseApp({
    globalData: {
      sensorClient: null,
      freshLaunch: true,
      traceLines: [],
      traceHydrated: false
    },
    onCreate() {
      this.globalData.freshLaunch = true
    },
    onDestroy() {
      try {
        markAppClosed()
      } catch (e) {}
    }
  })
)
