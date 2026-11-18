'use strict'

const backgroundFlag = '--background-login'
const windowsName = 'NewWorldBackground'

function loginItems(app, platform, argv = process.argv) {
  const supported = platform === 'darwin' || platform === 'win32'
  const options = platform === 'darwin' ? { type: 'mainAppService' } : {
    name: windowsName, path: process.execPath,
    args: [...(app.isPackaged ? [] : ['"' + app.getAppPath() + '"']), backgroundFlag],
  }
  function get() {
    if (!supported) return 'off'
    const state = app.getLoginItemSettings(options)
    if (platform === 'win32') {
      // Electron's openAtLogin reads the default AppUserModelId, even when a named Run entry was registered.
      return state.launchItems.some((item) => item.scope === 'user' && item.name === windowsName && item.enabled) ? 'on' : 'off'
    }
    if (state.status === 'requires-approval') return 'approval'
    return state.openAtLogin ? 'on' : 'off'
  }
  return {
    get,
    set(enabled) {
      if (!supported || typeof enabled !== 'boolean') throw new Error('Invalid login item setting')
      app.setLoginItemSettings({ ...options, openAtLogin: enabled })
      const state = get()
      if ((state !== 'off') !== enabled) throw new Error('Login item change failed')
      return state
    },
    backgroundLaunch() {
      if (platform === 'darwin') return app.getLoginItemSettings(options).wasOpenedAtLogin
      return platform === 'win32' && argv.includes(backgroundFlag)
    },
  }
}

module.exports = { loginItems, backgroundFlag }
