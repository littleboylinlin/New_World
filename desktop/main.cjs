const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } = require('electron')
const { mkdirSync } = require('node:fs')
const { readFile, writeFile } = require('node:fs/promises')
const { extname, isAbsolute, join, relative, resolve } = require('node:path')
const storageLocation = require('./storage-location.cjs')

const appId = 'com.littleboylinlin.newworld'
const appUrl = 'new-world://app/'
const repository = 'littleboylinlin/New_World'
const windowsReleases = `https://api.github.com/repos/${repository}/releases?per_page=100`
const releaseBase = `https://github.com/${repository}/releases/`
const windowsTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
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

ipcMain.handle('new-world:open-installer', (event, tag) => {
  if (!trustedFrame(event) || typeof tag !== 'string' || tag.length > 40 || !windowsTag.test(tag) || /\s/.test(tag)) {
    throw new Error('无效的 Windows 安装包地址。')
  }
  const version = tag.slice(1)
  return shell.openExternal(`${releaseBase}download/${tag}/New-World-Setup-${version}-x64.exe`)
})

ipcMain.handle('new-world:save-pdf', async (event, name) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!trustedFrame(event) || !window || typeof name !== 'string' || name.length > 130) throw new Error('无效的 PDF 文件名。')
  const filename = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'New World 编辑稿'
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: '保存 PDF', defaultPath: join(app.getPath('documents'), `${filename}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (canceled || !filePath) return
  const data = await event.sender.printToPDF({ printBackground: true, preferCSSPageSize: true })
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
  if (!trustedFrame(event)) throw new Error('无效的存储位置请求。')
  return { path: profile, defaultPath: defaultProfile, custom: profile !== defaultProfile }
})

ipcMain.handle('new-world:set-storage-location', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!trustedFrame(event) || !window) throw new Error('无效的存储位置请求。')
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: '选择书库存储位置',
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (canceled || !filePaths[0]) return null
  const result = storageLocation.setLocation(appData, filePaths[0], { programDir: resolve(app.getPath('exe'), '..') })
  if (result.error) throw new Error(result.error)
  scheduleRestart()
  return { path: result.to, custom: result.to !== defaultProfile, restart: true }
})

ipcMain.handle('new-world:reset-storage-location', (event) => {
  if (!trustedFrame(event)) throw new Error('无效的存储位置请求。')
  const result = storageLocation.resetLocation(appData)
  if (result.error) throw new Error(result.error)
  if (result.unchanged) return null
  scheduleRestart()
  return { path: result.to, custom: false, restart: true }
})

let mainWindow
let closing = false

function openWindow() {
  mainWindow = new BrowserWindow({
    width: 1220, height: 850, minWidth: 480, minHeight: 420,
    backgroundColor: '#f7f6ef',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false,
    },
  })
  const contents = mainWindow.webContents
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    // Only the app's own release pages may leave this window.
    if (url.startsWith(`${releaseBase}tag/`) && /^v?[a-zA-Z0-9.%+\-]+$/.test(url.slice(`${releaseBase}tag/`.length))) {
      void shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })
  contents.on('will-prevent-unload', () => {
    if (closing) return
    closing = true
    contents.send('new-world:save-before-close')
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
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.focus()
  })
  app.on('window-all-closed', () => app.quit())
  app.whenReady().then(() => {
    const local = session.defaultSession
    local.setPermissionRequestHandler((_contents, _permission, allow) => allow(false))
    local.setPermissionCheckHandler(() => false)
    local.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, done) => {
      done({ cancel: request.url !== windowsReleases || request.method !== 'GET' })
    })
    protocol.handle('new-world', serveApp)
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '编辑', submenu: [
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
      ] },
      { label: '视图', submenu: [
        { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '还原缩放' }, { role: 'togglefullscreen', label: '全屏' },
      ] },
    ]))
    return openWindow()
  }).catch(() => {
    dialog.showErrorBox('New World', '无法打开本地应用文件。请重新安装 New World。')
    app.exit(1)
  })
}
