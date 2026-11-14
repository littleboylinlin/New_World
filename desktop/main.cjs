const { t, createLanguageStore } = require('./language.cjs')
const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, protocol, safeStorage, screen, session, shell, Tray } = require('electron')
const { mkdirSync, readFileSync } = require('node:fs')
const { readFile, stat, writeFile } = require('node:fs/promises')
const { basename, dirname, extname, isAbsolute, join, relative, resolve } = require('node:path')
const storageLocation = require('./storage-location.cjs')
const closeBehavior = require('./close-behavior.cjs')
const windowTheme = require('./window-theme.cjs')
const spelling = require('./spelling.cjs')
const backups = require('./backup.cjs')
const capture = require('./capture.cjs')
const { createAiStore } = require('./ai-store.cjs')
const { createAiBridge } = require('./ai-bridge.cjs')
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
let theme = windowTheme.readTheme(appData)

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
let aiStore
let aiBridge
let aiRendererReady = false
const aiPendingDispatches = new Map()

function fullAiState() {
  if (!aiStore || !aiBridge) return null
  return { ...aiStore.getPublicState(), bridge: aiBridge.getStatus() }
}

function trustedMainRenderer(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && trustedFrame(event))
}

function rejectPendingAiDispatches(reason) {
  for (const [callId, entry] of Array.from(aiPendingDispatches.entries())) {
    clearTimeout(entry.timer)
    aiPendingDispatches.delete(callId)
    entry.resolve({ ok: false, statusCode: 503, code: 'renderer_unavailable', message: reason })
  }
}

function dispatchToRenderer(payload) {
  if (!mainWindow || mainWindow.isDestroyed() || !aiRendererReady) {
    return Promise.resolve({ ok: false, statusCode: 503, code: 'renderer_unavailable', message: 'New_World window is not ready.' })
  }
  const callId = require('node:crypto').randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      aiPendingDispatches.delete(callId)
      resolve({ ok: false, statusCode: 504, code: 'dispatch_timeout', message: 'Renderer operation timed out.' })
    }, 15_000)
    aiPendingDispatches.set(callId, { resolve, timer })
    try {
      mainWindow.webContents.send('new-world:ai-dispatch', { callId, payload })
    } catch {
      clearTimeout(timer)
      aiPendingDispatches.delete(callId)
      resolve({ ok: false, statusCode: 503, code: 'renderer_unavailable', message: 'Failed to contact application window.' })
    }
  })
}

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
  if (trustedFrame(event) && event.sender === mainWindow?.webContents) {
    aiRendererReady = true
    flushCommands()
  }
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

// The page reports its theme so the next window opens with the same background.
ipcMain.handle('new-world:set-window-theme', (event, next) => {
  if (!trustedFrame(event) || !windowTheme.isTheme(next)) throw new Error(t('main.invalidSettingsRequest'))
  if (next !== theme) {
    try { windowTheme.writeTheme(appData, next) } catch (error) { console.warn('New World theme:', error.code || error.message) }
    theme = next
  }
  applyWindowTheme()
})

// Spelling dictionaries the writer adds from a file or a link, on top of the bundled English ones.
let dictionaryNetwork
let downloadingDictionary = false

function spellingState() {
  if (process.platform === 'darwin') return { supported: false, bundled: [], added: [] }
  return { supported: true, bundled: spelling.languages, added: spelling.addedLanguages(profile) }
}

function useDictionaries() {
  const local = session.defaultSession
  local.setSpellCheckerLanguages(spelling.activeLanguages(profile, local.availableSpellCheckerLanguages))
}

function dictionaryResult(added, error, insecure = false) {
  if (added.length) useDictionaries()
  return { state: spellingState(), added, ...(error ? { error } : {}), ...(insecure ? { insecure } : {}) }
}

function dictionaryError(error) {
  if (error instanceof spelling.DictionaryError) return error.code
  console.warn('New World dictionary:', error.code || error.message)
  return 'download'
}

ipcMain.handle('new-world:spelling-state', (event) => {
  if (!trustedFrame(event)) throw new Error(t('main.invalidSettingsRequest'))
  return spellingState()
})

ipcMain.handle('new-world:spelling-import', async (event) => {
  if (!trustedFrame(event) || process.platform === 'darwin') throw new Error(t('main.invalidSettingsRequest'))
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: t('spelling.importTitle'), properties: ['openFile', 'multiSelections'],
    filters: [{ name: t('spelling.dictionaryFiles'), extensions: ['bdic'] }],
  })
  const added = []
  if (picked.canceled) return dictionaryResult(added)
  for (const path of picked.filePaths) {
    try {
      if ((await stat(path)).size > spelling.maxBytes) throw new spelling.DictionaryError('size')
      added.push(spelling.addDictionary(profile, basename(path), await readFile(path)))
    } catch (error) {
      return dictionaryResult(added, dictionaryError(error))
    }
  }
  return dictionaryResult(added)
})

ipcMain.handle('new-world:spelling-download', async (event, link) => {
  if (!trustedFrame(event) || process.platform === 'darwin' || typeof link !== 'string' || link.length > 2048) {
    throw new Error(t('main.invalidSettingsRequest'))
  }
  if (downloadingDictionary) return dictionaryResult([], 'busy')
  downloadingDictionary = true
  try {
    const { url, name } = spelling.downloadName(link.trim())
    if (!dictionaryNetwork) {
      // A separate session that only lets through the download the writer asked for.
      dictionaryNetwork = session.fromPartition('new-world-dictionaries')
      dictionaryNetwork.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, done) => {
        const target = new URL(request.url)
        // The link itself must be https; some download servers redirect to plain http.
        done({ cancel: !downloadingDictionary || request.method !== 'GET' || !['https:', 'http:'].includes(target.protocol)
          || Boolean(target.username || target.password) })
      })
    }
    const response = await dictionaryNetwork.fetch(url, {
      redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new spelling.DictionaryError('download')
    if (Number(response.headers.get('content-length') || 0) > spelling.maxBytes) throw new spelling.DictionaryError('size')
    const bytes = Buffer.from(await response.arrayBuffer())
    const insecure = Boolean(response.url) && new URL(response.url).protocol === 'http:'
    return dictionaryResult([spelling.addDictionary(profile, name, bytes)], undefined, insecure)
  } catch (error) {
    return dictionaryResult([], dictionaryError(error))
  } finally {
    downloadingDictionary = false
  }
})

ipcMain.handle('new-world:spelling-remove', async (event, language) => {
  if (!trustedFrame(event) || process.platform === 'darwin' || typeof language !== 'string') throw new Error(t('main.invalidSettingsRequest'))
  spelling.removeDictionary(profile, language)
  // Chromium lets go of the file once the language is no longer used; Windows keeps it locked until then.
  useDictionaries()
  for (let attempt = 0; attempt < 20 && spelling.deletePendingRemovals(profile).includes(language); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return spellingState()
})

// Library backups: the page builds each backup file; the main process keeps the settings, the
// password (encrypted with the system keychain) and writes the files into the chosen folder.
const maxBackupBytes = 2 * 1024 * 1024 * 1024

function backupState() {
  const config = backups.readConfig(appData)
  const documents = app.getPath('documents')
  return {
    frequency: config.frequency, folder: backups.folderOf(config, documents), defaultFolder: backups.defaultFolder(documents),
    custom: Boolean(config.folder), encrypt: config.encrypt, lastAutomatic: config.lastAutomatic,
    // Asking the macOS keychain can show a prompt, so only Linux, where it may be missing, is checked up front.
    due: backups.due(config), canEncrypt: process.platform !== 'linux' || safeStorage.isEncryptionAvailable(),
  }
}

function updateBackups(change) {
  backups.writeConfig(appData, { ...backups.readConfig(appData), ...change })
  return backupState()
}

function backupRequest(event) {
  if (!trustedFrame(event)) throw new Error(t('main.invalidSettingsRequest'))
}

ipcMain.handle('new-world:backup-state', (event) => {
  backupRequest(event)
  return backupState()
})

ipcMain.handle('new-world:backup-set-frequency', (event, frequency) => {
  backupRequest(event)
  if (!backups.frequencies.includes(frequency)) throw new Error(t('main.invalidSettingsRequest'))
  return updateBackups({ frequency })
})

ipcMain.handle('new-world:backup-choose-folder', async (event) => {
  backupRequest(event)
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: t('backup.chooseFolderTitle'), defaultPath: backupState().folder, properties: ['openDirectory', 'createDirectory'],
  })
  if (picked.canceled || !picked.filePaths[0]) return null
  return updateBackups({ folder: picked.filePaths[0] })
})

ipcMain.handle('new-world:backup-reset-folder', (event) => {
  backupRequest(event)
  return updateBackups({ folder: null })
})

ipcMain.handle('new-world:backup-set-encryption', (event, password) => {
  backupRequest(event)
  if (password === null) return updateBackups({ encrypt: false, password: null })
  if (typeof password !== 'string' || !password || password.length > 256) throw new Error(t('main.invalidSettingsRequest'))
  if (!safeStorage.isEncryptionAvailable()) throw new Error(t('backup.keychainUnavailable'))
  return updateBackups({ encrypt: true, password: safeStorage.encryptString(password).toString('base64') })
})

ipcMain.handle('new-world:backup-password', (event) => {
  backupRequest(event)
  const config = backups.readConfig(appData)
  if (!config.encrypt || !config.password) return null
  return safeStorage.decryptString(Buffer.from(config.password, 'base64'))
})

ipcMain.handle('new-world:backup-save', (event, name, bytes, automatic) => {
  backupRequest(event)
  if (typeof name !== 'string' || !(bytes instanceof Uint8Array) || bytes.length > maxBackupBytes) throw new Error(t('main.invalidSettingsRequest'))
  const folder = backupState().folder
  const path = backups.saveBackup(folder, name, bytes)
  if (automatic === true) {
    backups.writeConfig(appData, { ...backups.readConfig(appData), lastAutomatic: Date.now() })
    backups.pruneAutomatic(folder)
  }
  return { path, state: backupState() }
})

ipcMain.handle('new-world:backup-open', async (event) => {
  backupRequest(event)
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: t('backup.openTitle'), defaultPath: backupState().folder, properties: ['openFile'],
    filters: [{ name: t('backup.files'), extensions: ['zip'] }],
  })
  const path = picked.filePaths[0]
  if (picked.canceled || !path) return null
  if ((await stat(path)).size > maxBackupBytes) throw new Error(t('backup.tooLarge'))
  return { name: basename(path), bytes: await readFile(path) }
})

ipcMain.handle('new-world:backup-show-folder', async (event) => {
  backupRequest(event)
  const folder = backupState().folder
  mkdirSync(folder, { recursive: true })
  const problem = await shell.openPath(folder)
  if (problem) throw new Error(problem)
})

function windowBackground() {
  return windowTheme.backgroundColor(theme, nativeTheme.shouldUseDarkColors)
}

function applyWindowTheme() {
  nativeTheme.themeSource = windowTheme.themeSource(theme)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(windowBackground())
}

// Quick notes: a global shortcut opens a small window that writes straight into the library.
let captureShortcut = capture.readShortcut(appData)
let captureRegistered = false
let captureWindow
let recentWorks = []
let pendingCommands = []

function registerCapture() {
  if (captureRegistered) globalShortcut.unregisterAll()
  captureRegistered = false
  if (captureShortcut === 'off') return
  try { captureRegistered = globalShortcut.register(captureShortcut, openCapture) } catch { captureRegistered = false }
}

function captureState() {
  return { shortcut: captureShortcut, options: capture.shortcuts, registered: captureShortcut === 'off' || captureRegistered,
    labels: Object.fromEntries(capture.shortcuts.map((shortcut) => [shortcut, capture.shortcutLabel(shortcut)])) }
}

const quickNoteFlag = '--quick-note'

function openCapture() {
  if (!captureWindow || captureWindow.isDestroyed()) {
    captureWindow = new BrowserWindow({
      width: 520, height: 360, show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, backgroundColor: windowBackground(),
      icon: join(__dirname, 'icon.png'),
      webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true },
    })
    harden(captureWindow.webContents, captureWindow, false)
    // Like a spotlight panel, it steps aside when another window takes the focus; the text stays.
    captureWindow.on('blur', () => { if (captureWindow && !captureWindow.isDestroyed()) captureWindow.hide() })
    captureWindow.on('closed', () => { captureWindow = undefined })
    void captureWindow.loadURL(`${appUrl}#/capture`).catch(() => {})
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const [width, height] = captureWindow.getSize()
  captureWindow.setPosition(Math.round(area.x + (area.width - width) / 2), Math.round(area.y + area.height * 0.28))
  // On a Mac the shortcut fires while another app is in front; the panel has to take the focus.
  if (process.platform === 'darwin') app.focus({ steal: true })
  captureWindow.show()
  captureWindow.focus()
  captureWindow.webContents.send('new-world:capture-shown')
}

/** Runs a page command in the main window, opening it first when needed. */
function command(value, show = true) {
  if (show || !mainWindow) showWindow()
  if (mainWindow && !mainWindow.webContents.isLoading()) mainWindow.webContents.send('new-world:command', value)
  else pendingCommands.push(value)
}

function flushCommands() {
  const queued = pendingCommands
  pendingCommands = []
  for (const value of queued) mainWindow?.webContents.send('new-world:command', value)
}

function trayMenu() {
  return Menu.buildFromTemplate(capture.trayTemplate({
    t, shortcut: captureShortcut, recent: recentWorks, capture: openCapture, command,
    showFolder: () => {
      const folder = backupState().folder
      try { mkdirSync(folder, { recursive: true }) } catch { /* shell reports a missing folder */ }
      void shell.openPath(folder)
    },
    settings: () => { showWindow(); mainWindow?.webContents.send('new-world:open-settings') },
    show: showWindow, quit: quitApp,
  }))
}

ipcMain.handle('new-world:capture-state', (event) => {
  if (!trustedFrame(event)) throw new Error(t('main.invalidSettingsRequest'))
  return captureState()
})

ipcMain.handle('new-world:set-capture-shortcut', (event, shortcut) => {
  if (!trustedFrame(event) || !capture.shortcuts.includes(shortcut)) throw new Error(t('main.invalidSettingsRequest'))
  captureShortcut = capture.writeShortcut(appData, shortcut)
  registerCapture()
  refreshMenus()
  return captureState()
})

ipcMain.handle('new-world:hide-capture', (event) => {
  if (!trustedFrame(event)) throw new Error(t('main.invalidSettingsRequest'))
  if (captureWindow && !captureWindow.isDestroyed()) captureWindow.hide()
})

ipcMain.handle('new-world:set-recent-works', (event, works) => {
  if (!trustedFrame(event)) throw new Error(t('main.invalidSettingsRequest'))
  recentWorks = capture.recentWorks(works)
  if (tray) tray.setContextMenu(trayMenu())
})

/** The same safeguards for every window: no navigation, no new windows, the text right-click menu. */
function harden(contents, window, ideas) {
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('context-menu', (_event, params) => {
    const template = capture.contextTemplate(params, {
      t,
      replace: (word) => contents.replaceMisspelling(word),
      learn: (word) => contents.session.addWordToSpellCheckerDictionary(word),
      saveIdea: ideas ? (text) => contents.send('new-world:command', { type: 'idea', text }) : undefined,
    })
    if (template && !window.isDestroyed()) Menu.buildFromTemplate(template).popup({ window })
  })
  contents.setWindowOpenHandler(({ url }) => {
    // Only the app's own release pages may leave this window.
    if (url.startsWith(releasePages + 'tag/') && /^v?[a-zA-Z0-9.%+\-]+$/.test(url.slice((releasePages + 'tag/').length))) {
      void shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })
}

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
  tray.setContextMenu(trayMenu())
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
  if (tray) tray.setContextMenu(trayMenu())
  // The right-click list of the taskbar icon on Windows, and the Dock menu on a Mac.
  if (process.platform === 'win32') {
    app.setUserTasks([{
      program: process.execPath, arguments: app.isPackaged ? quickNoteFlag : `"${app.getAppPath()}" ${quickNoteFlag}`,
      iconPath: process.execPath, iconIndex: 0, title: t('ideas.capture'), description: t('ideas.shortcutHint'),
    }])
  } else if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: t('ideas.capture'), click: openCapture },
      { label: t('shelf.newNovel'), click: () => command({ type: 'new-novel' }) },
      { label: t('ideas.title'), click: () => command({ type: 'ideas' }) },
    ]))
  }
}

function openWindow() {
  nativeTheme.themeSource = windowTheme.themeSource(theme)
  mainWindow = new BrowserWindow({
    width: 1220, height: 850, minWidth: 480, minHeight: 420,
    backgroundColor: windowBackground(),
    icon: join(__dirname, 'icon.png'),
    // The app header is the title bar. macOS keeps its native traffic lights; Windows draws its own
    // window buttons in the header so they carry no system hover tooltip.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 16 } } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true,
    },
  })
  // The menu stays registered for its shortcuts but is never shown.
  if (process.platform !== 'darwin') mainWindow.setMenuBarVisibility(false)
  const contents = mainWindow.webContents
  harden(contents, mainWindow, true)
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
  mainWindow.on('closed', () => {
    mainWindow = undefined
    closing = false
    aiRendererReady = false
    rejectPendingAiDispatches('Application window closed.')
    // A hidden quick note window must not keep the app running once the main window is gone.
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy()
  })
  contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      aiRendererReady = false
      rejectPendingAiDispatches('Application window reloaded.')
    }
  })
  if (process.platform !== 'darwin') {
    const reportMaximized = () => { if (!contents.isDestroyed()) contents.send('new-world:window-maximized', mainWindow.isMaximized()) }
    mainWindow.on('maximize', reportMaximized)
    mainWindow.on('unmaximize', reportMaximized)
  }
  return mainWindow.loadURL(appUrl)
}

// The custom Windows caption buttons. Close goes through the same save-before-close flow as the native button.
function windowControl(event, action) {
  if (!mainWindow || event.sender !== mainWindow.webContents || !trustedFrame(event)) return
  action(mainWindow)
}

ipcMain.on('new-world:window-minimize', (event) => windowControl(event, (window) => window.minimize()))
ipcMain.on('new-world:window-maximize', (event) => windowControl(event, (window) => {
  if (window.isMaximized()) window.unmaximize()
  else window.maximize()
}))
ipcMain.on('new-world:window-close', (event) => windowControl(event, (window) => window.close()))
ipcMain.handle('new-world:window-is-maximized', (event) => (
  mainWindow && event.sender === mainWindow.webContents && trustedFrame(event) ? mainWindow.isMaximized() : false
))

ipcMain.on('new-world:close-result', (event, saved) => {
  if (!closing || !mainWindow || event.sender !== mainWindow.webContents || !trustedFrame(event)) return
  closing = false
  if (saved === true) mainWindow.close()
})

ipcMain.on('new-world:ai-dispatch-result', (event, data) => {
  if (!trustedMainRenderer(event) || !data || typeof data.callId !== 'string') return
  const entry = aiPendingDispatches.get(data.callId)
  if (!entry) return
  clearTimeout(entry.timer)
  aiPendingDispatches.delete(data.callId)
  entry.resolve(data.result)
})

ipcMain.handle('new-world:ai-state', (event) => {
  if (!trustedMainRenderer(event)) return null
  return fullAiState()
})

ipcMain.handle('new-world:ai-set-enabled', async (event, enabled) => {
  if (!trustedMainRenderer(event) || !aiStore || !aiBridge) return null
  aiStore.setEnabled(enabled === true)
  await aiBridge.sync()
  return fullAiState()
})

ipcMain.handle('new-world:ai-set-port', async (event, port) => {
  if (!trustedMainRenderer(event) || !aiStore || !aiBridge) return null
  aiStore.setPort(port)
  await aiBridge.sync()
  return fullAiState()
})

ipcMain.handle('new-world:ai-create-client', (event, input) => {
  if (!trustedMainRenderer(event) || !aiStore) return null
  const created = aiStore.createClient(input)
  return { state: fullAiState(), client: created.client, token: created.token }
})

ipcMain.handle('new-world:ai-update-client', (event, id, patch) => {
  if (!trustedMainRenderer(event) || !aiStore || !aiBridge) return null
  const updated = aiStore.updateClient(id, patch)
  if (!updated.client.enabled || !updated.client.permissions.delete) {
    aiBridge.cancelClientPending(id, 'client_updated')
  }
  return { state: fullAiState(), client: updated.client }
})

ipcMain.handle('new-world:ai-rotate-token', (event, id) => {
  if (!trustedMainRenderer(event) || !aiStore) return null
  const rotated = aiStore.rotateClientToken(id)
  return { state: fullAiState(), client: rotated.client, token: rotated.token }
})

ipcMain.handle('new-world:ai-delete-client', (event, id) => {
  if (!trustedMainRenderer(event) || !aiStore || !aiBridge) return null
  aiBridge.cancelClientPending(id, 'client_deleted')
  aiStore.deleteClient(id)
  return fullAiState()
})

ipcMain.handle('new-world:ai-list-audit', (event, limit) => {
  if (!trustedMainRenderer(event) || !aiStore) return []
  return aiStore.listAudit(limit)
})

ipcMain.handle('new-world:ai-clear-audit', (event) => {
  if (!trustedMainRenderer(event) || !aiStore) return []
  return aiStore.clearAudit()
})

ipcMain.handle('new-world:ai-confirm-decision', async (event, data) => {
  if (!trustedMainRenderer(event) || !aiBridge || !data) return { ok: false, status: 'unauthorized' }
  return aiBridge.handleConfirmDecision({
    confirmationId: data.confirmationId,
    approved: data.approved === true,
  })
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Starting New World again shows the open window; the taskbar's quick note task opens the note window.
  app.on('second-instance', (_event, argv) => { if (argv.includes(quickNoteFlag)) openCapture(); else showWindow() })
  app.on('activate', showWindow)
  app.on('before-quit', () => {
    forceQuit = true
    void aiBridge?.stop()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    void aiBridge?.stop()
  })
  app.whenReady().then(async () => {
    nativeTheme.on('updated', () => {
      if (theme === 'system' && mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(windowBackground())
    })
    const local = session.defaultSession
    local.setPermissionRequestHandler((_contents, _permission, allow) => allow(false))
    local.setPermissionCheckHandler(() => false)
    if (process.platform !== 'darwin') {
      try {
        spelling.installDictionaries(profile)
        useDictionaries()
      } catch (error) {
        console.warn('New World spelling:', error.code || error.message)
      }
    }
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
    aiStore = createAiStore(appData)
    const testConfirmTimeout = !app.isPackaged && Number(process.env.NEW_WORLD_AI_TEST_TIMEOUT_MS) >= 500
      ? Number(process.env.NEW_WORLD_AI_TEST_TIMEOUT_MS)
      : undefined
    aiBridge = createAiBridge({
      store: aiStore,
      dispatchOperation: dispatchToRenderer,
      onAttentionNeeded: () => showWindow(),
      onPromptConfirmation: (request) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('new-world:ai-confirm-open', request)
        }
      },
      onCloseConfirmation: (detail) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('new-world:ai-confirm-close', detail)
        }
      },
      ...(testConfirmTimeout ? { confirmTimeoutMs: testConfirmTimeout } : {}),
    })
    await aiBridge.sync()
    refreshMenus()
    try { createTray() } catch { /* tray is unavailable on some desktop environments */ }
    registerCapture()
    const opened = openWindow()
    if (process.argv.includes(quickNoteFlag)) openCapture()
    return opened
  }).catch(() => {
    dialog.showErrorBox('New World', t('main.theLocalApplicationFilesCouldNotBeOpened'))
    app.exit(1)
  })
}
