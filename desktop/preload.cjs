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
})
