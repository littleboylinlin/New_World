const { t, createLanguageStore } = require('./language.cjs')
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, session, shell, Tray } = require('electron')
const { mkdirSync, readFileSync } = require('node:fs')
const { readFile, writeFile } = require('node:fs/promises')
const { dirname, extname, isAbsolute, join, relative, resolve } = require('node:path')
const storageLocation = require('./storage-location.cjs')
const closeBehavior = require('./close-behavior.cjs')
const { createWindowsUpdater, UpdateError } = require('./windows-update.cjs')
const { createMacUpdater, MacUpdateError } = require('./macos-update.cjs')
const { createMacInstaller } = require('./macos-install.cjs')
const { releasePages, windowsReleaseList } = require('./windows-release.mjs')

const appId = 'com.littleboylinlin.newworld'
const appUrl = 'new-world://app/'
const policy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' https://api.github.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'new-world', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

// Keep the IndexedDB origin stable across releases; the profile directory is configurable.
const appData = app.getPath('appData')
const defaultProfile = join(appData, 'NewWorld')
const location = storageLocation.applyPending(appData)
const profile = location.current
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
if (process.platform === 'win32') app.setAppUserModelId(appId)
let behavior = closeBehavior.readBehavior(appData)

async function serveApp(request) {
  try {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.host !== 'app' || url.username || url.password) return new Response(null, { status: 404 })
    const pathname = decodeURIComponent(url.pathname)
    if (/[\\\0:]/.test(pathname)) return new Response(null, { status: 404 })
    const root = join(app.getAppPath(), 'dist')
    const file = resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`)
    const within = relative(root, file)
    if (!within || within.startsWith('..') || isAbsolute(within)) return new Response(null, { status: 404 })
    return new Response(await readFile(file), { headers: {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Content-Security-Policy': policy,
      'X-Content-Type-Options': 'nosniff',
    } })
  } catch {
    return new Response(null, { status: 404 })
  }
}

function trustedFrame(event) {
  const frame = event.senderFrame
  return frame === event.sender.mainFrame && frame?.url.startsWith(appUrl)
}

let desktopUpdater
let languages
let macInstaller
let maintenanceStarted = false

function languageNetworkFor(manifest, partition) {
  const network = session.fromPartition(partition)
  const prefix = `https://github.com/littleboylinlin/New_World/releases/download/v${manifest.version}/`
  const allowedFiles = Object.values(manifest.packs).map((pack) => prefix + pack.file)
  network.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, done) => {
    const url = new URL(request.url)
    done({ cancel: request.method !== 'GET' || url.protocol !== 'https:' || Boolean(url.username || url.password)
      || (Boolean(url.port) && url.port !== '443')
      || (!allowedFiles.includes(request.url) && url.hostname !== 'release-assets.githubusercontent.com') })
  })
  return network
}

ipcMain.on('new-world:ready', (event) => {
  if (!trustedFrame(event) || !languages || maintenanceStarted) return
  maintenanceStarted = true
  const token = process.env.NEW_WORLD_UPDATE_TOKEN
  delete process.env.NEW_WORLD_UPDATE_TOKEN
  void (async () => {
    await macInstaller?.finishBoot(app.getVersion(), token)
    await languages.cleanup()
    const cacheVersion = join(profile, 'NewWorld-cache-version')
    if (await readFile(cacheVersion, 'utf8').catch(() => '') !== app.getVersion()) {
      await session.defaultSession.clearCache()
      await session.defaultSession.clearCodeCaches({})
      await writeFile(cacheVersion, app.getVersion(), { mode: 0o600 })
    }
    if (process.env.NEW_WORLD_UPDATE_FAILED) {
      delete process.env.NEW_WORLD_UPDATE_FAILED
      void dialog.showMessageBox({ type: 'error', title: 'New World', message: t('macUpdate.restoredOldVersion') })
    }
  })().catch((error) => console.warn('New World startup cleanup:', error.code || error.message))
})

async function performUpdate(event, action) {
  if (!trustedFrame(event)) throw new Error(t('main.invalidUpdateRequest'))
  if (!desktopUpdater) return { ok: false, message: t(process.platform === 'darwin' ? 'macUpdate.installedAppRequired' : 'main.inAppUpdatesRequireAnInstalledWindowsX64') }
  try {
    const result = await action()
    return result === false ? { ok: true, canceled: true } : { ok: true }
  } catch (error) {
    return { ok: false, message: (error instanceof UpdateError || error instanceof MacUpdateError) ? t(error.message) : t('update.theUpdateFailedTryAgainLater') }
  }
}

ipcMain.handle('new-world:download-update', (event, tag) => performUpdate(event, () => (
  desktopUpdater.download(tag, (received, total) => {
    if (!event.sender.isDestroyed()) event.sender.send('new-world:update-progress', { tag, received, total })
  })
)))

ipcMain.handle('new-world:install-update', (event, tag) => performUpdate(event, async () => {
  await session.defaultSession.flushStorageData()
  await desktopUpdater.install(tag)
  setImmediate(() => app.quit())
}))

ipcMain.handle('new-world:save-pdf', async (event, name) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!trustedFrame(event) || !window || typeof name !== 'string' || name.length > 130) throw new Error(t('main.invalidPdfFilename'))
  const filename = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || t('export.newWorldManuscript')
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: t('main.savePdf'), defaultPath: join(app.getPath('documents'), `${filename}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (canceled || !filePath) return
  const data = await event.sender.printToPDF({ printBackground: false, preferCSSPageSize: true })
  await writeFile(filePath, data)
})

function scheduleRestart() {
  app.relaunch()
  setTimeout(async () => {
    try { await session.defaultSession.flushStorageData() } catch { /* storage may already be closed */ }
    app.exit(0)
  }, 400)
}

ipcMain.handle('new-world:get-storage-location', (event) => {
  if (!trustedFrame(event)) throw new Error(t('main.invalidStorageLocationRequest'))
  return { path: profile, defaultPath: defaultProfile, custom: profile !== defaultProfile }
})

ipcMain.handle('new-world:set-storage-location', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!trustedFrame(event) || !window) throw new Error(t('main.invalidStorageLocationRequest'))
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: t('main.chooseALibraryStorageFolder'),
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (canceled || !filePaths[0]) return null
  const result = storageLocation.setLocation(appData, filePaths[0], { programDir: process.platform === 'darwin' ? resolve(app.getPath('exe'), '../../..') : resolve(app.getPath('exe'), '..') })
  if (result.error) throw new Error(t(result.error))
  scheduleRestart()
  return { path: result.to, custom: result.to !== defaultProfile, restart: true }
})

ipcMain.handle('new-world:reset-storage-location', (event) => {
  if (!trustedFrame(event)) throw new Error(t('main.invalidStorageLocationRequest'))
  const result = storageLocation.resetLocation(appData)
  if (result.error) throw new Error(t(result.error))
  if (result.unchanged) return null
  scheduleRestart()
  return { path: result.to, custom: false, restart: true }
})

ipcMain.handle('new-world:get-language', (event) => {
  if (!trustedFrame(event) || !languages?.current) throw new Error('Invalid language request')
  return languages.current
})

ipcMain.handle('new-world:set-language', async (event, locale) => {
  if (!trustedFrame(event) || !languages) throw new Error('Invalid language request')
  const pack = await languages.activate(locale)
  refreshMenus()
  return pack
})

ipcMain.handle('new-world:reload-language', (event) => {
  if (!trustedFrame(event)) throw new Error('Invalid language request')
  setImmediate(() => { if (!event.sender.isDestroyed()) event.sender.reload() })
})

ipcMain.handle('new-world:get-close-behavior', (event) => {
  if (!trustedFrame(event)) throw new Error(t('main.invalidSettingsRequest'))
  return behavior
})

ipcMain.handle('new-world:set-close-behavior', (event, mode) => {
  if (!trustedFrame(event) || !closeBehavior.isMode(mode)) throw new Error(t('closeBehavior.invalidCloseBehavior'))
  try {
    closeBehavior.writeBehavior(appData, mode)
  } catch {
    throw new Error(t('settings.settingsCouldNotBeSavedTryAgain'))
  }
  behavior = mode
  return behavior
})

let mainWindow
let closing = false
let forceQuit = false
let tray

function showWindow() {
  if (!mainWindow) {
    void openWindow().catch(() => {})
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function quitApp() {
  forceQuit = true
  app.quit()
}

function createTray() {
  const image = nativeImage.createFromPath(join(__dirname, 'tray.png'))
  tray = new Tray(process.platform === 'darwin' ? image.resize({ width: 18, height: 18 }) : image)
  tray.setToolTip('New World')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('main.showNewWorld'), click: showWindow },
    { label: t('settings.quit'), click: quitApp },
  ]))
  tray.on('click', showWindow)
}

function refreshMenus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'New World', submenu: [
      { role: 'about', label: t('macMenu.about') },
      { type: 'separator' },
      { label: t('settings.title'), accelerator: 'Cmd+,', click: () => { showWindow(); mainWindow?.webContents.send('new-world:open-settings') } },
      { type: 'separator' },
      { role: 'hide', label: t('macMenu.hide') },
      { role: 'hideOthers', label: t('macMenu.hideOthers') },
      { role: 'unhide', label: t('macMenu.showAll') },
      { type: 'separator' },
      { label: t('macMenu.quit'), accelerator: 'Cmd+Q', click: quitApp },
    ] }] : []),
    { label: t('main.edit'), submenu: [
      ...(process.platform === 'darwin' ? [{ role: 'undo', label: t('editor.undo') }, { role: 'redo', label: t('editor.redo') }, { type: 'separator' }] : []),
      { role: 'cut', label: t('main.cut') }, { role: 'copy', label: t('main.copy') },
      { role: 'paste', label: t('main.paste') }, { role: 'selectAll', label: t('common.selectAll') },
    ] },
    { label: t('main.view'), submenu: [
      { role: 'zoomIn', label: t('main.zoomIn') }, { role: 'zoomOut', label: t('main.zoomOut') },
      { role: 'resetZoom', label: t('main.resetZoom') }, { role: 'togglefullscreen', label: t('main.fullScreen') },
    ] },
  ]))
  if (tray) tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('main.showNewWorld'), click: showWindow },
    { label: t('settings.quit'), click: quitApp },
  ]))
}

function openWindow() {
  mainWindow = new BrowserWindow({
    width: 1220, height: 850, minWidth: 480, minHeight: 420,
    backgroundColor: '#f4eee2',
    // The app header is the title bar. Windows draws only the window buttons over its right end.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 16 } }
      : { titleBarOverlay: { color: '#16130f', symbolColor: '#f4eee2', height: 46 } }),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false,
    },
  })
  // The menu stays registered for its shortcuts but is never shown.
  if (process.platform !== 'darwin') mainWindow.setMenuBarVisibility(false)
  const contents = mainWindow.webContents
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    // Only the app's own release pages may leave this window.
    if (url.startsWith(releasePages + 'tag/') && /^v?[a-zA-Z0-9.%+\-]+$/.test(url.slice((releasePages + 'tag/').length))) {
      void shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })
  contents.on('will-prevent-unload', () => {
    if (closing) return
    closing = true
    contents.send('new-world:save-before-close')
  })
  mainWindow.on('close', (event) => {
    if (closeBehavior.closeAction(behavior, { forceQuit }) !== 'background') return
    event.preventDefault()
    mainWindow.hide()
  })
  mainWindow.on('closed', () => { mainWindow = undefined; closing = false })
  return mainWindow.loadURL(appUrl)
}

ipcMain.on('new-world:close-result', (event, saved) => {
  if (!closing || !mainWindow || event.sender !== mainWindow.webContents || !trustedFrame(event)) return
  closing = false
  if (saved === true) mainWindow.close()
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('activate', showWindow)
  app.on('before-quit', () => { forceQuit = true })
  app.on('window-all-closed', () => app.quit())
  app.whenReady().then(async () => {
    const local = session.defaultSession
    local.setPermissionRequestHandler((_contents, _permission, allow) => allow(false))
    local.setPermissionCheckHandler(() => false)
    local.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, done) => {
      done({ cancel: request.url !== windowsReleaseList || request.method !== 'GET' })
    })
    if (app.isPackaged && process.platform === 'win32' && process.arch === 'x64') {
      desktopUpdater = createWindowsUpdater({
        network: session.fromPartition('new-world-update'),
        cache: join(app.getPath('temp'), 'New World Updates'),
        installDir: dirname(app.getPath('exe')),
        version: app.getVersion(),
      })
    }
    if (app.isPackaged && process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) {
      const cache = join(appData, 'NewWorld-updates', 'macos')
      macInstaller = createMacInstaller({
        bundle: resolve(app.getPath('exe'), '../../..'), cache, arch: process.arch,
        prepareLanguage: async (manifest) => {
          const network = languageNetworkFor(manifest, 'new-world-update-language')
          const store = await createLanguageStore({ root: join(appData, 'NewWorld-languages'), manifest, request: (url, options) => network.fetch(url, options) })
          await store.prepare(languages.current.locale)
        },
      })
      desktopUpdater = await createMacUpdater({
        network: session.fromPartition('new-world-update'), version: app.getVersion(), arch: process.arch,
        cache, legacyDownloads: app.getPath('downloads'), installer: macInstaller,
      })
    }
    const manifest = JSON.parse(readFileSync(app.isPackaged
      ? join(__dirname, 'language-manifest.json')
      : join(app.getAppPath(), 'public', 'locales', 'manifest.json'), 'utf8'))
    const languageNetwork = languageNetworkFor(manifest, 'new-world-language-packs')
    languages = await createLanguageStore({
      root: join(appData, 'NewWorld-languages'), manifest,
      request: (url, options) => languageNetwork.fetch(url, options),
      developmentRoot: app.isPackaged ? undefined : join(app.getAppPath(), 'public', 'locales'),
    })
    while (true) {
      try {
        await languages.initialize(app.getSystemLocale())
        break
      } catch {
        const { response } = await dialog.showMessageBox({
          type: 'error', title: 'New World',
          message: 'Unable to load the language pack. Check your connection and retry. / 无法加载语言包，请联网后重试。',
          buttons: ['Retry / 重试', 'Quit / 退出'], defaultId: 0, cancelId: 1,
        })
        if (response === 1) { app.exit(1); return }
      }
    }
    protocol.handle('new-world', serveApp)
    refreshMenus()
    try { createTray() } catch { /* tray is unavailable on some desktop environments */ }
    return openWindow()
  }).catch(() => {
    dialog.showErrorBox('New World', t('main.theLocalApplicationFilesCouldNotBeOpened'))
    app.exit(1)
  })
}
