const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('newWorldDesktop', {
  openInstaller: (tag) => ipcRenderer.invoke('new-world:open-installer', tag),
  savePdf: (name) => ipcRenderer.invoke('new-world:save-pdf', name),
  onCloseRequested: (save) => {
    ipcRenderer.on('new-world:save-before-close', async () => {
      const saved = await Promise.resolve().then(save).catch(() => false)
      ipcRenderer.send('new-world:close-result', saved === true)
    })
  },
})
