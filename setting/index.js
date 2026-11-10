AppSettingsPage({
  storedText(val) {
    if (val == null || val === '') return ''
    if (typeof val === 'string') return val.trim()
    if (typeof val === 'object') {
      try {
        return JSON.stringify(val)
      } catch (e) {
        return ''
      }
    }
    return String(val).trim()
  },

  looksLikeScan(val) {
    try {
      const data = typeof val === 'string' ? JSON.parse(val) : val
      return !!(data && data.uid && data.patchInfo && data.bleAddress)
    } catch (e) {
      return false
    }
  },

  fieldOf(val, key) {
    try {
      const data = typeof val === 'string' ? JSON.parse(val) : val
      let raw = data && data[key]
      if (raw == null && key === 'unlockCode') raw = data && data.enableTime
      const n = Number(String(raw == null ? '' : raw).trim())
      return Number.isFinite(n) && n > 0 ? n : null
    } catch (e) {
      return null
    }
  },

  unlockCodeOf(val) {
    return this.fieldOf(val, 'unlockCode')
  },

  patchOf(val) {
    try {
      const data = typeof val === 'string' ? JSON.parse(val) : val
      const patch = String((data && data.patchInfo) || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toUpperCase()
      return patch || '?'
    } catch (e) {
      return '?'
    }
  },

  summarize(val) {
    try {
      const data = typeof val === 'string' ? JSON.parse(val) : val
      const code = this.unlockCodeOf(val)
      const count = this.fieldOf(val, 'nextUnlockCount')
      return {
        serial: String((data && data.serial) || '?'),
        patch: this.patchOf(val).replace(/(.{4})(?=.)/g, '$1 '),
        detail:
          'Unlock code ' +
          (code == null ? '?' : code) +
          ' · next count ' +
          (count == null ? '?' : count)
      }
    } catch (e) {
      return null
    }
  },

  labelStyle() {
    return {
      display: 'block',
      fontSize: '12px',
      color: '#888',
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
      marginBottom: '2px'
    }
  },

  titleStyle() {
    return {
      display: 'block',
      fontSize: '17px',
      fontWeight: 'bold',
      marginBottom: '4px'
    }
  },

  hintStyle() {
    return {
      display: 'block',
      fontSize: '13px',
      color: '#888',
      marginBottom: '12px',
      lineHeight: '18px'
    }
  },

  prettyJson(val) {
    if (val == null || val === '') return ''
    try {
      const data = typeof val === 'string' ? JSON.parse(val) : val
      return JSON.stringify(data, null, 2)
    } catch (e) {
      return String(val)
    }
  },

  savePaste(props, val) {
    const text = this.storedText(val != null ? val : this.draftJson)
    this.draftJson = text
    if (!text) {
      props.settingsStorage.removeItem('scanJson')
      props.settingsStorage.removeItem('scanJsonLatest')
      return
    }
    props.settingsStorage.setItem('scanJson', text)
    props.settingsStorage.setItem('scanJsonLatest', text)
  },

  openJsonEditor(storage) {
    storage.setItem('ui.jsonEditorOpen', '1')
  },

  closeJsonEditor(storage) {
    storage.removeItem('ui.jsonEditorOpen')
  },

  readBleTrace(storage) {
    const parts = Number(storage.getItem('bleTraceParts')) || 0
    if (parts > 0) {
      let s = ''
      for (let i = 0; i < parts; i++) {
        const chunk = storage.getItem('bleTrace.' + i)
        s += chunk == null ? '' : String(chunk)
      }
      return s
    }
    const legacy = storage.getItem('bleTrace')
    return legacy == null ? '' : String(legacy)
  },

  clearBleTrace(storage) {
    const parts = Number(storage.getItem('bleTraceParts')) || 0
    const extra = parts + 8
    for (let i = 0; i < extra; i++) {
      try {
        storage.removeItem('bleTrace.' + i)
      } catch (e) {}
    }
    try {
      storage.removeItem('bleTrace')
    } catch (e) {}
    try {
      storage.removeItem('bleTraceLen')
    } catch (e) {}
    try {
      storage.removeItem('bleTraceParts')
    } catch (e) {}
    try {
      storage.removeItem('bleTraceCopy')
    } catch (e) {}
    try {
      storage.removeItem('bleTraceCopyMsg')
    } catch (e) {}
  },

  copyViaTextarea(text) {
    try {
      if (typeof document === 'undefined') return false
      const el = document.createElement('textarea')
      el.value = text
      el.setAttribute('readonly', '')
      el.style.position = 'fixed'
      el.style.left = '-9999px'
      document.body.appendChild(el)
      el.focus()
      el.select()
      if (el.setSelectionRange) el.setSelectionRange(0, text.length)
      const ok = document.execCommand('copy')
      document.body.removeChild(el)
      return !!ok
    } catch (e) {
      return false
    }
  },

  copyLog(props) {
    const text = this.readBleTrace(props.settingsStorage)
    const fail = 'Copy failed'
    if (!text) {
      props.settingsStorage.setItem('bleTraceCopyMsg', 'No log yet')
      return
    }
    const okMsg = 'Copied · ' + text.length + 'b'
    const done = (ok) => {
      props.settingsStorage.setItem('bleTraceCopyMsg', ok ? okMsg : fail)
    }
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        navigator.clipboard.writeText
      ) {
        navigator.clipboard
          .writeText(text)
          .then(() => done(true))
          .catch(() => done(this.copyViaTextarea(text)))
        return
      }
    } catch (e) {}
    done(this.copyViaTextarea(text))
  },

  cardStyle() {
    return {
      background: '#fff',
      borderRadius: '14px',
      padding: '16px',
      marginBottom: '16px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
    }
  },

  btnStyle(kind) {
    const base = {
      width: '100%',
      borderRadius: '10px',
      padding: '12px 0',
      fontSize: '15px',
      fontWeight: 'bold',
      marginBottom: '10px'
    }
    if (kind === 'primary') {
      return Object.assign({}, base, {
        background: '#1b6b7a',
        color: '#fff',
        border: 'none'
      })
    }
    if (kind === 'destructive') {
      return Object.assign({}, base, {
        background: '#fff',
        color: '#c0392b',
        border: '1px solid #f5c6cb'
      })
    }
    return Object.assign({}, base, {
      background: '#fff',
      color: '#333',
      border: '1px solid #d0d5da'
    })
  },

  build(props) {
    const storage = props.settingsStorage
    const rawStored = storage.getItem('scanJson')
    const stored = this.storedText(rawStored)
    if (stored && rawStored && typeof rawStored === 'object') {
      this.savePaste(props, stored)
    }
    const editorOpen = String(storage.getItem('ui.jsonEditorOpen') || '') === '1'
    const bleTrace = this.readBleTrace(storage)
    const copyMsg = String(storage.getItem('bleTraceCopyMsg') || '')
    const traceLines = bleTrace ? bleTrace.split('\n').length : 0
    const logReady = bleTrace
      ? 'Ready to copy · ' + traceLines + ' lines'
      : 'No log yet'
    const validScan = this.looksLikeScan(stored)
    const summary = validScan ? this.summarize(stored) : null
    const jsonOpen = String(storage.getItem('ui.jsonPreviewOpen') || '') === '1'
    const jsonPreview = stored && jsonOpen ? this.prettyJson(stored) : ''
    const sensorChildren = [Text({ style: this.titleStyle() }, ['Libre 2+ sensor'])]

    if (summary) {
      sensorChildren.push(
        Text({ style: this.labelStyle() }, ['Serial']),
        Text(
          {
            style: {
              display: 'block',
              fontSize: '22px',
              fontWeight: 'bold',
              color: '#1b6b7a',
              marginBottom: '10px'
            }
          },
          [summary.serial]
        ),
        Text({ style: this.labelStyle() }, ['Patch info']),
        Text(
          {
            style: {
              display: 'block',
              fontSize: '17px',
              fontFamily: 'monospace',
              marginBottom: '8px'
            }
          },
          [summary.patch]
        ),
        Text({ style: this.hintStyle() }, [summary.detail])
      )
    } else {
      sensorChildren.push(
        Text({ style: this.hintStyle() }, [
          stored
            ? 'Stored text is not a AmazCGM for Android scan'
            : 'No sensor yet. In AmazCGM for Android tap Share JSON, then paste it here.'
        ])
      )
    }

    if (jsonPreview) {
      sensorChildren.push(
        View(
          {
            style: {
              height: '180px',
              overflowY: 'auto',
              WebkitOverflowScrolling: 'touch',
              background: '#f6f8fa',
              border: '1px solid #e1e4e8',
              borderRadius: '10px',
              padding: '12px',
              marginBottom: '12px'
            }
          },
          [
            Text(
              {
                style: {
                  display: 'block',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  lineHeight: '18px',
                  color: '#24292e'
                }
              },
              [jsonPreview]
            )
          ]
        )
      )
    }

    if (editorOpen) {
      sensorChildren.push(
        TextInput({
          label: 'Paste JSON',
          placeholder:
            '{ "serial": "...", "uid": "...", "patchInfo": "...", "bleAddress": "...", "unlockCode": "42" }',
          value: stored,
          maxLength: 8000,
          onChange: (val) => {
            this.savePaste(props, val)
            this.closeJsonEditor(storage)
          }
        }),
        Button({
          label: 'Cancel',
          style: this.btnStyle('secondary'),
          onClick: () => this.closeJsonEditor(storage)
        })
      )
    } else {
      sensorChildren.push(
        Button({
          label: 'Paste JSON',
          style: this.btnStyle('primary'),
          onClick: () => this.openJsonEditor(storage)
        })
      )
      if (stored) {
        sensorChildren.push(
          Button({
            label: jsonOpen ? 'Hide JSON' : 'Show JSON',
            style: this.btnStyle('secondary'),
            onClick: () => {
              if (jsonOpen) storage.removeItem('ui.jsonPreviewOpen')
              else storage.setItem('ui.jsonPreviewOpen', '1')
            }
          })
        )
      }
    }

    return View(
      {
        style: {
          background: '#f2f3f5',
          padding: '16px'
        }
      },
      [
        View(
          {
            style: this.cardStyle()
          },
          sensorChildren
        ),
        View(
          {
            style: this.cardStyle()
          },
          [
            Text(
              {
                style: {
                  display: 'block',
                  fontSize: '17px',
                  fontWeight: 'bold',
                  marginBottom: '4px'
                }
              },
              ['BLE log']
            ),
            Text(
              {
                style: {
                  display: 'block',
                  fontSize: '13px',
                  color: '#888',
                  marginBottom: '12px',
                  lineHeight: '18px'
                }
              },
              ['Watch Settings → Send log, then copy it here.']
            ),
            Text(
              {
                style: {
                  display: 'block',
                  fontSize: '15px',
                  fontWeight: 'bold',
                  color: bleTrace ? '#1b6b7a' : '#888',
                  marginBottom: '12px',
                  lineHeight: '20px'
                }
              },
              [logReady]
            ),
            Button({
              label: 'Copy log',
              style: this.btnStyle('primary'),
              onClick: () => this.copyLog(props)
            }),
            Text(
              {
                style: {
                  display: 'block',
                  fontSize: '13px',
                  color: copyMsg.indexOf('Copied') === 0 ? '#1b6b7a' : '#888',
                  marginBottom: '10px',
                  minHeight: '18px'
                }
              },
              [copyMsg]
            ),
            Button({
              label: 'Clear BLE log',
              style: this.btnStyle('destructive'),
              onClick: () => {
                this.clearBleTrace(storage)
              }
            })
          ]
        )
      ]
    )
  }
})
