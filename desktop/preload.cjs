const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('newWorldDesktop', {
  getLanguage: () => ipcRenderer.invoke('new-world:get-language'),
  setLanguage: (locale) => ipcRenderer.invoke('new-world:set-language', locale),
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
  onCloseRequested: (save) => {
    ipcRenderer.on('new-world:save-before-close', async () => {
      const saved = await Promise.resolve().then(save).catch(() => false)
      ipcRenderer.send('new-world:close-result', saved === true)
    })
  },
})
