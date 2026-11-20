'use strict'

// Web panes: plain web pages shown beside the text in the desktop app, always private.
// Each pane has its own in-memory session (a partition without the "persist:" prefix), so cookies,
// cache, localStorage, IndexedDB and service workers never reach the disk. A pane's session is
// emptied when the pane closes and when the app quits. Pages get no preload and no app IPC.

const { randomUUID } = require('node:crypto')
const { join } = require('node:path')

/** Only ordinary web pages may be shown. */
function isWebUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch { return false }
}

/** Chromium's certificate errors are -200 to -299 (net/base/net_error_list.h). */
const isCertificateError = (code) => code <= -200 && code > -300

/** A pane id from the app's own page: short, plain characters only. */
/** The most text a page summary reads from one page. */
const maxPageText = 200000

const isPaneId = (value) => typeof value === 'string' && /^[a-z0-9-]{1,64}$/i.test(value)

function readBounds(value) {
  if (!value || typeof value !== 'object') return undefined
  const numbers = ['x', 'y', 'width', 'height'].map((key) => Number(value[key]))
  if (numbers.some((number) => !Number.isFinite(number))) return undefined
  const [x, y, width, height] = numbers.map((number) => Math.round(number))
  if (width < 1 || height < 1 || width > 20000 || height > 20000) return undefined
  return { x, y, width, height }
}

/**
 * Creates the panes' controller. `window()` is the main window, `send(state)` reports to its page,
 * `command(entry)` asks its page to keep selected text as an idea or a task.
 */
function createWebPanes({ electron, window, send, command, t }) {
  const { WebContentsView, session, shell, Menu, app } = electron
  const panes = new Map()

  function stateOf(pane) {
    const contents = pane.view.webContents
    if (contents.isDestroyed()) return { id: pane.id, closed: true }
    const history = contents.navigationHistory
    return {
      id: pane.id,
      url: pane.blocked ? pane.lastUrl : contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      error: pane.error,
    }
  }
  const report = (pane, extra = {}) => { if (!pane.closed) send({ ...stateOf(pane), ...extra }) }

  function lockDown(pane) {
    const { view, session: ses } = pane
    const contents = view.webContents
    // No permission is ever granted and nothing is asked: camera, microphone, location,
    // notifications, clipboard reading, MIDI, USB, HID, serial, Bluetooth and the rest.
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.setDevicePermissionHandler(() => false)
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    ses.on('select-hid-device', (event, _details, callback) => { event.preventDefault(); callback('') })
    ses.on('select-serial-port', (event, _ports, _contents, callback) => { event.preventDefault(); callback('') })
    ses.on('select-usb-device', (event, _details, callback) => { event.preventDefault(); callback('') })
    contents.on('select-bluetooth-device', (event, _devices, callback) => { event.preventDefault(); callback('') })
    // Local files and every scheme other than the web's own never load, from any frame.
    ses.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (_request, done) => done({ cancel: true }))
    ses.setCertificateVerifyProc((_request, callback) => callback(-3))
    // Downloads always ask where to save; nothing is saved by itself.
    ses.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), item.getFilename()) })
    })
    const guard = (event, url) => {
      if (isWebUrl(url)) return
      event.preventDefault()
      pane.blocked = true
      report(pane, { blocked: url.slice(0, 200) })
    }
    contents.on('will-navigate', (event) => guard(event, event.url))
    contents.on('will-redirect', (event) => guard(event, event.url))
    // Frames inside a page may also be blank or written inline; nothing else besides the web.
    contents.on('will-frame-navigate', (event) => { if (!event.isMainFrame && !isWebUrl(event.url) && !/^about:(blank|srcdoc)$/.test(event.url)) event.preventDefault() })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    // Pop-ups open in the same pane; no new window is ever created.
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) void load(pane, url)
      return { action: 'deny' }
    })
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) { pane.error = undefined; pane.blocked = false }
    })
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      pane.error = { kind: isCertificateError(code) ? 'certificate' : 'failed', code, description, url }
      report(pane)
    })
    for (const name of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) {
      contents.on(name, () => report(pane))
    }
    contents.on('focus', () => report(pane, { focused: true }))
    contents.on('context-menu', (_event, params) => {
      const selected = Boolean(params.selectionText?.trim())
      const link = isWebUrl(params.linkURL) ? params.linkURL : ''
      const template = [
        ...(link ? [
          { label: t('web.openLinkHere'), click: () => void load(pane, link) },
          { label: t('web.openLinkOutside'), click: () => void shell.openExternal(link) },
          { type: 'separator' },
        ] : []),
        ...(selected ? [
          { label: t('main.copy'), role: 'copy' },
          { label: t('web.toIdea'), click: () => void keep(pane, 'idea') },
          { label: t('web.toTask'), click: () => void keep(pane, 'task') },
          { type: 'separator' },
        ] : []),
        { label: t('web.back'), enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
        { label: t('web.forward'), enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
        { label: t('web.reload'), click: () => contents.reload() },
      ]
      const owner = window()
      if (owner && !owner.isDestroyed()) Menu.buildFromTemplate(template).popup({ window: owner })
    })
  }

  function create(id) {
    if (!isPaneId(id) || panes.has(id)) throw new Error('Invalid web pane')
    const owner = window()
    if (!owner || owner.isDestroyed()) throw new Error('No window')
    const partition = `new-world-web-${randomUUID()}`
    const ses = session.fromPartition(partition, { cache: false })
    const view = new WebContentsView({
      webPreferences: {
        partition, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false, webviewTag: false, spellcheck: false, safeDialogs: true, navigateOnDragDrop: false,
      },
    })
    // Pages see a plain Chromium, not the app's name and version.
    view.webContents.setUserAgent(view.webContents.getUserAgent().replace(/\s(Electron|new-world|NewWorld)\/\S+/gi, ''))
    view.setVisible(false)
    owner.contentView.addChildView(view)
    const pane = { id, view, session: ses, partition, error: undefined, blocked: false, lastUrl: '', closed: false }
    panes.set(id, pane)
    lockDown(pane)
    return { partition }
  }

  async function load(pane, url) {
    if (!isWebUrl(url)) { report(pane, { blocked: String(url).slice(0, 200) }); return false }
    pane.lastUrl = url
    pane.error = undefined
    try { await pane.view.webContents.loadURL(url) } catch { /* Failures are reported by did-fail-load. */ }
    return true
  }

  const paneOf = (id) => {
    const pane = panes.get(id)
    if (!pane || pane.closed) throw new Error('No such web pane')
    return pane
  }

  /** Reads the selected text with a one-off expression; nothing stays in the page. */
  async function selection(id) {
    const pane = paneOf(id)
    const text = await pane.view.webContents.executeJavaScript('String(globalThis.getSelection ? getSelection() : "")', false).catch(() => '')
    return typeof text === 'string' ? text.trim().slice(0, 20000) : ''
  }

  /**
   * Reads the visible text of the whole page with a one-off expression, only when the writer asks
   * for a summary of it. Nothing stays in the page and nothing else is read.
   */
  async function pageText(id) {
    const pane = paneOf(id)
    const contents = pane.view.webContents
    const text = await contents.executeJavaScript('String(document.body ? (document.body.innerText || document.body.textContent || "") : "")', false).catch(() => '')
    const clean = typeof text === 'string' ? text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxPageText) : ''
    return { text: clean, title: contents.getTitle().slice(0, 300), url: isWebUrl(contents.getURL()) ? contents.getURL() : '' }
  }

  async function keep(pane, kind) {
    const text = await selection(pane.id)
    if (!text) return
    const contents = pane.view.webContents
    command({ type: 'web-keep', kind, id: pane.id, text, title: contents.getTitle().slice(0, 300), url: isWebUrl(contents.getURL()) ? contents.getURL() : '' })
  }

  async function close(id) {
    const pane = panes.get(id)
    if (!pane) return
    pane.closed = true
    panes.delete(id)
    const owner = window()
    try { if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(pane.view) } catch { /* Already gone with the window. */ }
    try { if (!pane.view.webContents.isDestroyed()) pane.view.webContents.close() } catch { /* Already closed. */ }
    // Empty the in-memory session as well, so nothing lingers until the app quits.
    await Promise.allSettled([pane.session.clearStorageData(), pane.session.clearCache(), pane.session.clearAuthCache?.(), pane.session.clearHostResolverCache?.()])
  }

  return {
    create,
    navigate: (id, url) => load(paneOf(id), url),
    back: (id) => { const history = paneOf(id).view.webContents.navigationHistory; if (history.canGoBack()) history.goBack() },
    forward: (id) => { const history = paneOf(id).view.webContents.navigationHistory; if (history.canGoForward()) history.goForward() },
    reload: (id) => paneOf(id).view.webContents.reload(),
    stop: (id) => paneOf(id).view.webContents.stop(),
    /** Places the page over its pane, in the page's CSS pixels times the window's zoom. */
    place(id, rect, visible) {
      const pane = paneOf(id)
      const owner = window()
      const bounds = readBounds(rect)
      if (bounds && owner && !owner.isDestroyed()) {
        const zoom = owner.webContents.getZoomFactor()
        pane.view.setBounds({ x: Math.round(bounds.x * zoom), y: Math.round(bounds.y * zoom), width: Math.round(bounds.width * zoom), height: Math.round(bounds.height * zoom) })
      }
      pane.view.setVisible(Boolean(visible && bounds))
    },
    async capture(id) {
      const pane = paneOf(id)
      const image = await pane.view.webContents.capturePage()
      return image.isEmpty() ? '' : image.toDataURL()
    },
    selection,
    pageText,
    keep: (id, kind) => keep(paneOf(id), kind === 'task' ? 'task' : 'idea'),
    focus: (id) => paneOf(id).view.webContents.focus(),
    openOutside(id) {
      const url = paneOf(id).view.webContents.getURL()
      if (isWebUrl(url)) void shell.openExternal(url)
    },
    state: (id) => stateOf(paneOf(id)),
    close,
    /** Closes every pane (the window closed or the app quits). */
    closeAll: () => Promise.allSettled([...panes.keys()].map(close)),
    size: () => panes.size,
  }
}

module.exports = { createWebPanes, isWebUrl, isCertificateError, isPaneId, readBounds }
