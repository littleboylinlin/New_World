const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('newWorldDesktop', {
  platform: process.platform,
  arch: process.arch,
  reportReady: () => ipcRenderer.send('new-world:ready'),
  onSettingsRequested: (listener) => { ipcRenderer.on('new-world:open-settings', () => listener()) },
  getLanguage: () => ipcRenderer.invoke('new-world:get-language'),
  setLanguage: (locale) => ipcRenderer.invoke('new-world:set-language', locale),
  reloadForLanguage: () => ipcRenderer.invoke('new-world:reload-language'),
  downloadUpdate: (tag) => ipcRenderer.invoke('new-world:download-update', tag),
  installUpdate: (tag) => ipcRenderer.invoke('new-world:install-update', tag),
  onUpdateProgress: (listener) => {
    ipcRenderer.on('new-world:update-progress', (_event, progress) => listener(progress))
  },
  savePdf: (name) => ipcRenderer.invoke('new-world:save-pdf', name),
  getStorageLocation: () => ipcRenderer.invoke('new-world:get-storage-location'),
  setStorageLocation: () => ipcRenderer.invoke('new-world:set-storage-location'),
  resetStorageLocation: () => ipcRenderer.invoke('new-world:reset-storage-location'),
  getCloseBehavior: () => ipcRenderer.invoke('new-world:get-close-behavior'),
  setCloseBehavior: (mode) => ipcRenderer.invoke('new-world:set-close-behavior', mode),
  setWindowTheme: (theme) => ipcRenderer.invoke('new-world:set-window-theme', theme),
  minimizeWindow: () => ipcRenderer.send('new-world:window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send('new-world:window-maximize'),
  closeWindow: () => ipcRenderer.send('new-world:window-close'),
  isMaximized: () => ipcRenderer.invoke('new-world:window-is-maximized'),
  onMaximizeChange: (listener) => { ipcRenderer.on('new-world:window-maximized', (_event, maximized) => listener(maximized)) },
  getCaptureState: () => ipcRenderer.invoke('new-world:capture-state'),
  setCaptureShortcut: (shortcut) => ipcRenderer.invoke('new-world:set-capture-shortcut', shortcut),
  hideCapture: () => ipcRenderer.invoke('new-world:hide-capture'),
  onCaptureShown: (listener) => { ipcRenderer.on('new-world:capture-shown', () => listener()) },
  setRecentWorks: (works) => ipcRenderer.invoke('new-world:set-recent-works', works),
  onCommand: (listener) => { ipcRenderer.on('new-world:command', (_event, command) => listener(command)) },
  getBackupState: () => ipcRenderer.invoke('new-world:backup-state'),
  setBackupFrequency: (frequency) => ipcRenderer.invoke('new-world:backup-set-frequency', frequency),
  chooseBackupFolder: () => ipcRenderer.invoke('new-world:backup-choose-folder'),
  resetBackupFolder: () => ipcRenderer.invoke('new-world:backup-reset-folder'),
  setBackupPassword: (password) => ipcRenderer.invoke('new-world:backup-set-encryption', password),
  getBackupPassword: () => ipcRenderer.invoke('new-world:backup-password'),
  saveBackup: (name, bytes, automatic) => ipcRenderer.invoke('new-world:backup-save', name, bytes, automatic),
  openBackup: () => ipcRenderer.invoke('new-world:backup-open'),
  showBackupFolder: () => ipcRenderer.invoke('new-world:backup-show-folder'),
  getSpellingDictionaries: () => ipcRenderer.invoke('new-world:spelling-state'),
  importSpellingDictionaries: () => ipcRenderer.invoke('new-world:spelling-import'),
  downloadSpellingDictionary: (link) => ipcRenderer.invoke('new-world:spelling-download', link),
  removeSpellingDictionary: (language) => ipcRenderer.invoke('new-world:spelling-remove', language),
  onCloseRequested: (save) => {
    ipcRenderer.on('new-world:save-before-close', async () => {
      const saved = await Promise.resolve().then(save).catch(() => false)
      ipcRenderer.send('new-world:close-result', saved === true)
    })
  },
  getAiState: () => ipcRenderer.invoke('new-world:ai-state'),
  setAiEnabled: (enabled) => ipcRenderer.invoke('new-world:ai-set-enabled', enabled === true),
  setAiPort: (port) => ipcRenderer.invoke('new-world:ai-set-port', port),
  createAiClient: (input) => ipcRenderer.invoke('new-world:ai-create-client', input),
  updateAiClient: (id, patch) => ipcRenderer.invoke('new-world:ai-update-client', id, patch),
  rotateAiToken: (id) => ipcRenderer.invoke('new-world:ai-rotate-token', id),
  deleteAiClient: (id) => ipcRenderer.invoke('new-world:ai-delete-client', id),
  listAiAudit: (limit) => ipcRenderer.invoke('new-world:ai-list-audit', limit),
  clearAiAudit: () => ipcRenderer.invoke('new-world:ai-clear-audit'),
  onAiDispatch: (handler) => {
    const listener = (_event, packet) => handler(packet)
    ipcRenderer.on('new-world:ai-dispatch', listener)
    return () => ipcRenderer.removeListener('new-world:ai-dispatch', listener)
  },
  sendAiDispatchResult: (callId, result) => ipcRenderer.send('new-world:ai-dispatch-result', { callId, result }),
  onAiConfirmOpen: (handler) => {
    const listener = (_event, request) => handler(request)
    ipcRenderer.on('new-world:ai-confirm-open', listener)
    return () => ipcRenderer.removeListener('new-world:ai-confirm-open', listener)
  },
  onAiConfirmClose: (handler) => {
    const listener = (_event, detail) => handler(detail)
    ipcRenderer.on('new-world:ai-confirm-close', listener)
    return () => ipcRenderer.removeListener('new-world:ai-confirm-close', listener)
  },
  sendAiConfirmDecision: (confirmationId, approved) => ipcRenderer.invoke('new-world:ai-confirm-decision', {
    confirmationId,
    approved: approved === true,
  }),
})
