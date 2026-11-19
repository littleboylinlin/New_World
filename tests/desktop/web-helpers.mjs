import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect } from '@playwright/test'

// Shared steps for the desktop web pane: a local test site (nothing on the internet is visited),
// and reading the private web views from the main process.

const page = (title, body = '', script = '') => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font: 16px sans-serif; margin: 0; padding: 24px">${body}<script>${script}</script></body>`

const routes = {
  '/page': (url) => page(url.searchParams.get('title') ?? '测试页', `<p id="text">海边的灯塔在雾里一圈一圈地转。</p><p>第二段：守夜人数着浪声。</p>`),
  '/set': () => page('set', '<p>写入存储</p>', `
    document.cookie = 'script=1; max-age=3600'
    localStorage.setItem('kept', 'yes')
    indexedDB.open('private-test', 1).onupgradeneeded = (event) => event.target.result.createObjectStore('items')
    navigator.serviceWorker?.register('/worker.js').catch(() => {})
    caches?.open('private-test').then((cache) => cache.put('/page', new Response('x'))).catch(() => {})`),
  '/read': () => page('read', '', `
    const report = (idb) => { document.title = JSON.stringify({ cookie: document.cookie, local: localStorage.length, idb }) }
    indexedDB.databases().then((list) => report(list.length), () => report(-1))`),
  '/worker.js': () => 'self.addEventListener("fetch", () => {})',
  '/permissions': () => page('permissions', '<p>权限</p>', `
    const results = {}
    const done = () => { document.title = JSON.stringify(results) }
    const settle = (name, promise) => promise.then((value) => { results[name] = String(value) }, (error) => { results[name] = 'denied:' + (error?.name || error?.code || error) })
    Promise.all([
      settle('notification', Notification.requestPermission()),
      settle('geolocation', new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 4000 }))),
      settle('camera', navigator.mediaDevices ? navigator.mediaDevices.getUserMedia({ video: true }) : Promise.reject(new Error('none'))),
      settle('microphone', navigator.mediaDevices ? navigator.mediaDevices.getUserMedia({ audio: true }) : Promise.reject(new Error('none'))),
      settle('clipboard', navigator.clipboard ? navigator.clipboard.readText() : Promise.reject(new Error('none'))),
      settle('midi', navigator.requestMIDIAccess ? navigator.requestMIDIAccess() : Promise.reject(new Error('none'))),
      settle('usb', navigator.usb ? navigator.usb.requestDevice({ filters: [] }) : Promise.reject(new Error('none'))),
    ]).then(done)`),
  '/popup': () => page('popup', `<p><a id="blank" target="_blank" href="/page?title=blank-target">新标签链接</a></p>
    <p><button id="open" onclick="window.open('/page?title=opened-window')">window.open</button></p>`),
  '/local-link': () => page('local-link', '<p><a id="file" href="file:///etc/hostname">本地文件</a></p>'),
}

/** A local site over http, and (when asked) an https one whose certificate nobody trusts. */
export async function startSite({ secure = false } = {}) {
  const handle = (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const route = routes[url.pathname]
    if (!route) { response.writeHead(404); response.end('not found'); return }
    const headers = { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' }
    if (url.pathname === '/set') headers['set-cookie'] = 'server=1; Max-Age=3600; Path=/'
    response.writeHead(200, headers)
    response.end(route(url))
  }
  const server = createServer(handle)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const site = { url: `http://127.0.0.1:${server.address().port}`, servers: [server], directory: '' }
  if (secure) {
    // A throwaway self-signed certificate, made now with the system's openssl and deleted afterwards.
    site.directory = await mkdtemp(join(tmpdir(), 'new-world-cert-'))
    const key = join(site.directory, 'key.pem'), cert = join(site.directory, 'cert.pem')
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'])
    const secureServer = createSecureServer({ key: await readFile(key), cert: await readFile(cert) }, handle)
    await new Promise((resolve) => secureServer.listen(0, '127.0.0.1', resolve))
    site.secureUrl = `https://localhost:${secureServer.address().port}`
    site.servers.push(secureServer)
  }
  site.close = async () => {
    for (const server of site.servers) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)) }
    if (site.directory) await rm(site.directory, { recursive: true, force: true })
  }
  return site
}

/** The private web views of the main window, read in the main process. */
export function webViews(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const owner = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && /^new-world:\/\/app\/(#\/(?!capture|compare)|$)/.test(win.webContents.getURL()))
    if (!owner) return []
    return owner.contentView.children.map((view) => ({
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      bounds: view.getBounds(),
      visible: typeof view.getVisible === 'function' ? view.getVisible() : null,
      persistent: view.webContents.session.isPersistent(),
      storagePath: view.webContents.session.storagePath,
      zoom: owner.webContents.getZoomFactor(),
      preload: view.webContents.session.getPreloads?.().length ?? 0,
    }))
  })
}

/** Runs a one-off expression in the web view at `index` (test only). */
export function inWebView(app, code, index = 0) {
  return app.evaluate(({ BrowserWindow }, { code, index }) => {
    const owner = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && /^new-world:\/\/app\/(#\/(?!capture|compare)|$)/.test(win.webContents.getURL()))
    return owner.contentView.children[index].webContents.executeJavaScript(code, true)
  }, { code, index })
}

export async function waitForView(app, predicate, index = 0, message = 'web view') {
  await expect.poll(async () => { const view = (await webViews(app))[index]; return Boolean(view && predicate(view)) }, { message, timeout: 15000 }).toBe(true)
  return (await webViews(app))[index]
}

/** Opens a blank web pane from the toolbar's "⋯" and goes to an address. */
export async function openWebPane(page, address) {
  await page.locator('.more-toggle').click()
  await page.getByRole('menuitem', { name: '打开网页' }).click()
  const field = page.locator('.web-pane').last().getByRole('textbox', { name: '网址或搜索内容' })
  await expect(field).toBeFocused()
  if (address) { await field.fill(address); await field.press('Enter') }
  return page.locator('.web-pane').last()
}

/** Every file and folder under the profile whose name mentions the private web partitions. */
export async function partitionFiles(profile) {
  const found = []
  async function walk(directory) {
    let entries = []
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (/new-world-web/i.test(entry.name)) found.push(path)
      if (entry.isDirectory()) await walk(path)
    }
  }
  await walk(profile)
  return found
}

export const exists = (path) => stat(path).then(() => true, () => false)

/**
 * The installed app's quick check of the web pane: a page's cookie and storage are gone once the
 * pane closes, and nothing of the private session is under the app's profile.
 */
export async function privateWebSmoke(app, page, startWork) {
  const site = await startSite()
  try {
    await page.waitForLoadState('load')
    await page.locator('#writing-link').click()
    await page.locator('[data-filter="original"]').click()
    await startWork(page)
    await page.getByRole('textbox', { name: '作品名', exact: true }).fill('无痕冒烟')
    await page.getByRole('button', { name: '创建小说', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '章节正文', exact: true })).toBeVisible()
    let pane = await openWebPane(page, `${site.url}/set`)
    await waitForView(app, (view) => view.title === 'set')
    const [view] = await webViews(app)
    expect(view.persistent).toBe(false)
    expect(view.storagePath).toBeNull()
    await expect.poll(() => inWebView(app, 'document.cookie')).toContain('server=1')
    await pane.getByRole('button', { name: '关闭网页' }).click()
    await expect.poll(async () => (await webViews(app)).length).toBe(0)
    pane = await openWebPane(page, `${site.url}/read`)
    const read = await waitForView(app, (item) => item.title.startsWith('{'))
    expect(JSON.parse(read.title)).toEqual({ cookie: '', local: 0, idb: 0 })
    await pane.getByRole('button', { name: '关闭网页' }).click()
    const profile = await app.evaluate(({ app }) => app.getPath('userData'))
    expect(await partitionFiles(profile)).toEqual([])
  } finally { await site.close() }
}
