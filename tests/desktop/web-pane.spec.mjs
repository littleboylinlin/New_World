import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { startWork } from '../navigation-helpers.mjs'
import { exists, inWebView, openWebPane, partitionFiles, startSite, waitForView, webViews } from './web-helpers.mjs'

// The desktop web pane, run against the app from this checkout (npm run build first). Every page is
// served by a local test site; nothing on the internet is visited.

let site
let home
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => { site = await startSite({ secure: true }) })
test.afterAll(async () => { await site?.close() })
test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'new-world-web-'))
  await mkdir(join(home, 'NewWorld-languages'), { recursive: true })
  await writeFile(join(home, 'NewWorld-languages', 'language.json'), JSON.stringify({ locale: 'zh-CN' }))
})
test.afterEach(async () => { await rm(home, { recursive: true, force: true }) })

const profile = () => join(home, 'NewWorld')

async function launch() {
  const args = ['.', '--disable-gpu']
  if (process.platform === 'linux') args.push('--no-sandbox')
  const app = await electron.launch({ args, env: { ...process.env, XDG_CONFIG_HOME: home, APPDATA: home } })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { const [win] = BrowserWindow.getAllWindows(); win.setContentSize(1400, 900) })
  await expect(page.locator('#main')).toBeVisible()
  return { app, page }
}

async function newNovel(page, title = '网页样书') {
  await page.evaluate(() => { location.hash = '#/writing' })
  await expect(page.locator('.shelf-content')).toBeVisible()
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名', exact: true }).fill(title)
  await page.getByRole('button', { name: '创建小说', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '章节正文', exact: true })).toBeVisible()
}

/** Real windows (a web pane's view is not one). */
const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

const closeWeb = (pane) => pane.getByRole('button', { name: '关闭网页' }).click()

test('永远无痕：关闭网页块后读不到 Cookie 和网页存储，重启后也读不到，硬盘上没有这个会话的文件', async () => {
  let { app, page } = await launch()
  try {
    await newNovel(page)
    let pane = await openWebPane(page, `${site.url}/set`)
    await waitForView(app, (view) => view.title === 'set')
    const [view] = await webViews(app)
    expect(view.persistent).toBe(false)
    expect(view.storagePath).toBeNull()
    expect(view.preload).toBe(0)
    await expect.poll(() => inWebView(app, 'document.cookie')).toContain('script=1')
    expect(await inWebView(app, 'document.cookie')).toContain('server=1')
    expect(await inWebView(app, 'localStorage.getItem("kept")')).toBe('yes')
    // Nothing the app keeps (layouts, places, preferences) holds the address.
    expect(await page.evaluate((address) => Object.keys(localStorage).filter((key) => localStorage.getItem(key)?.includes(address)), site.url)).toEqual([])
    await closeWeb(pane)
    await expect.poll(async () => (await webViews(app)).length).toBe(0)

    pane = await openWebPane(page, `${site.url}/read`)
    const read = await waitForView(app, (item) => item.title.startsWith('{'))
    expect(JSON.parse(read.title)).toEqual({ cookie: '', local: 0, idb: 0 })
    await closeWeb(pane)
    expect(await partitionFiles(profile())).toEqual([])
  } finally { await app.close() }

  ;({ app, page } = await launch())
  try {
    await page.evaluate(() => { location.hash = '#/writing' })
    // A written work opens straight into its manuscript.
    await page.locator('.book-card').first().click()
    await expect(page.getByRole('textbox', { name: '章节正文', exact: true })).toBeVisible()
    // The web pane open when the app quit is not brought back.
    await expect(page.locator('.web-pane')).toHaveCount(0)
    await openWebPane(page, `${site.url}/read`)
    const read = await waitForView(app, (item) => item.title.startsWith('{'))
    expect(JSON.parse(read.title)).toEqual({ cookie: '', local: 0, idb: 0 })
  } finally { await app.close() }
  expect(await partitionFiles(profile())).toEqual([])
  expect(await exists(join(profile(), 'Partitions'))).toBe(false)
})

test('权限请求一律拒绝且不弹框；file: 和 javascript: 导航被拦截；证书错误只有提示页，不能跳过', async () => {
  const { app, page } = await launch()
  try {
    await newNovel(page)
    const pane = await openWebPane(page, `${site.url}/permissions`)
    const view = await waitForView(app, (item) => item.title.startsWith('{'))
    const results = JSON.parse(view.title)
    expect(results.notification).toBe('denied')
    for (const name of ['geolocation', 'camera', 'microphone', 'clipboard', 'midi', 'usb']) expect(results[name], name).toMatch(/^denied:/)
    expect(await windowCount(app)).toBe(1)

    const field = pane.getByRole('textbox', { name: '网址或搜索内容' })
    for (const address of ['file:///etc/hostname', 'javascript:document.title="ran"']) {
      await field.fill(address)
      await field.press('Enter')
      await expect(page.getByText('只能打开 http 或 https 网页。').first()).toBeVisible()
      expect((await webViews(app))[0].url).toBe(`${site.url}/permissions`)
    }
    expect(await inWebView(app, 'document.title')).not.toBe('ran')
    // Even straight from the page's own link, a local file never opens.
    await field.fill(`${site.url}/local-link`)
    await field.press('Enter')
    await waitForView(app, (item) => item.title === 'local-link')
    await inWebView(app, 'document.getElementById("file").click()')
    await page.waitForTimeout(800)
    expect((await webViews(app))[0].url).toBe(`${site.url}/local-link`)
    // The main process refuses other schemes too, whatever asks.
    expect(await page.evaluate(() => {
      const id = document.querySelector('.web-pane') && [...document.querySelectorAll('.split-pane')].find((node) => node.classList.contains('web-pane'))?.dataset.pane
      return window.newWorldDesktop.web('navigate', id, 'file:///etc/hostname')
    })).toBe(false)

    await field.fill(`${site.secureUrl}/page?title=secret`)
    await field.press('Enter')
    await expect(pane.getByRole('heading', { name: '无法安全连接到这个网站' })).toBeVisible()
    await expect(pane.locator('.web-message button')).toHaveText(['后退'])
    const after = (await webViews(app))[0]
    expect(after.title).not.toBe('secret')
    expect(after.visible).not.toBe(true)
  } finally { await app.close() }
})

test('弹出窗口在同一个网页块里打开，不新建窗口', async () => {
  const { app, page } = await launch()
  try {
    await newNovel(page)
    await openWebPane(page, `${site.url}/popup`)
    await waitForView(app, (item) => item.title === 'popup')
    await inWebView(app, 'document.getElementById("blank").click()')
    await waitForView(app, (item) => item.title === 'blank-target')
    await inWebView(app, 'history.back()')
    await waitForView(app, (item) => item.title === 'popup')
    await inWebView(app, 'document.getElementById("open").click()')
    await waitForView(app, (item) => item.title === 'opened-window')
    expect(await windowCount(app)).toBe(1)
    expect((await webViews(app)).length).toBe(1)
  } finally { await app.close() }
})

async function selectInPage(app) {
  await inWebView(app, `(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById('text')); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.body.focus() })()`)
}

test('摘进灵感、转成待办：带上网页标题，「附带链接」默认不勾，选择会被记住', async () => {
  const { app, page } = await launch()
  try {
    await newNovel(page)
    const pane = await openWebPane(page, `${site.url}/page?title=雾港札记`)
    await waitForView(app, (item) => item.title === '雾港札记')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.focus())
    await selectInPage(app)
    const toIdea = pane.getByRole('button', { name: '摘进灵感' })
    await expect(toIdea).toBeVisible()
    await toIdea.click()
    let dialog = page.getByRole('dialog', { name: '摘进灵感' })
    const link = dialog.getByRole('checkbox', { name: '附带链接' })
    await expect(link).not.toBeChecked()
    await expect(dialog).toContainText('海边的灯塔在雾里一圈一圈地转。')
    await expect(dialog).toContainText('摘自《雾港札记》')
    await link.check()
    await dialog.getByRole('button', { name: '存为灵感' }).click()
    await expect(dialog).toBeHidden()
    // The "saved" notice keeps clear of the page, which stays live (no still picture) and usable.
    const notice = page.locator('.undo-toast:not(.leaving)')
    await expect(notice).toBeVisible()
    await expect(pane.locator('.web-snapshot')).toBeHidden()
    await expect.poll(async () => (await webViews(app))[0].visible).toBe(true)
    const [noticeBox, stageBox] = await Promise.all([notice, pane.locator('.web-stage')].map((locator) => locator.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    })))
    expect(noticeBox.right <= stageBox.left || noticeBox.left >= stageBox.right || noticeBox.bottom <= stageBox.top || noticeBox.top >= stageBox.bottom).toBe(true)
    if (await page.locator('.side-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('.side-toggle').click()
    await page.getByRole('tab', { name: /^灵感与待办/ }).click()
    await page.getByRole('tablist', { name: '灵感与待办' }).getByRole('tab', { name: /^灵感/ }).click()
    const idea = page.locator('.ideas-panel .idea-text').first()
    await expect(idea).toContainText('海边的灯塔在雾里一圈一圈地转。')
    await expect(idea).toContainText('摘自《雾港札记》')
    await expect(idea.getByRole('link', { name: `${site.url}/page?title=雾港札记`.replace('雾港札记', encodeURIComponent('雾港札记')) })).toBeVisible()

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.focus())
    await selectInPage(app)
    await pane.getByRole('button', { name: '转成待办' }).click()
    dialog = page.getByRole('dialog', { name: '转成待办' })
    // The last choice is kept.
    await expect(dialog.getByRole('checkbox', { name: '附带链接' })).toBeChecked()
    await dialog.getByRole('checkbox', { name: '附带链接' }).uncheck()
    await dialog.getByRole('button', { name: '建为待办' }).click()
    await expect(dialog).toBeHidden()
    const task = await page.evaluate(async () => {
      const db = await new Promise((resolve) => { const request = indexedDB.open('new-world-library'); request.onsuccess = () => resolve(request.result) })
      const names = [...db.objectStoreNames]
      const store = names.includes('tasks') ? 'tasks' : names.find((name) => /task/i.test(name))
      const rows = await new Promise((resolve) => { const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result) })
      db.close()
      const flat = rows.flatMap((row) => Array.isArray(row?.tasks) ? row.tasks : [row])
      return flat.find((item) => item?.title?.includes('海边的灯塔'))
    })
    expect(task.title).toBe('海边的灯塔在雾里一圈一圈地转。')
    expect(task.description).toContain('摘自《雾港札记》')
    expect(task.description).not.toContain(site.url)
    expect(task.link).toMatchObject({ library: 'original', title: '网页样书' })
    // Unticked last time, so unticked now.
    await selectInPage(app)
    await pane.getByRole('button', { name: '摘进灵感' }).click()
    await expect(page.getByRole('dialog', { name: '摘进灵感' }).getByRole('checkbox', { name: '附带链接' })).not.toBeChecked()
  } finally { await app.close() }
})

test('覆盖层出现时网页换成截图，收起后恢复；拖动分隔线后原生视图的位置和大小跟着块走', async () => {
  const { app, page } = await launch()
  try {
    await newNovel(page)
    const pane = await openWebPane(page, `${site.url}/page?title=位置`)
    await waitForView(app, (item) => item.title === '位置' && item.visible !== false)
    const stage = pane.locator('.web-stage')
    const matches = async () => {
      const [view] = await webViews(app)
      const box = await stage.evaluate((node) => { const r = node.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })
      const zoom = view.zoom
      return view.visible !== false && ['x', 'y', 'width', 'height'].every((key) => Math.abs(view.bounds[key] - Math.round(box[key] * zoom)) <= 1)
    }
    await expect.poll(matches).toBe(true)

    // The Aa panel drops over the page: a still picture takes its place, then the page comes back.
    await page.getByRole('button', { name: '外观' }).first().click()
    await expect(pane.locator('.web-snapshot')).toBeVisible()
    await expect.poll(async () => (await webViews(app))[0].visible).toBe(false)
    expect(await pane.locator('.web-snapshot').getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await webViews(app))[0].visible).toBe(true)
    await expect(pane.locator('.web-snapshot')).toBeHidden()

    const divider = page.getByRole('separator', { name: '调整分块大小' })
    const handle = await divider.boundingBox()
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 300)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 - 160, handle.y + 300, { steps: 8 })
    await expect.poll(matches).toBe(true)
    await page.mouse.up()
    await expect.poll(matches).toBe(true)
    await divider.focus()
    await page.keyboard.press('Shift+ArrowRight')
    await expect.poll(matches).toBe(true)
    // The window itself changes size (still wide enough for both panes; narrower moves the page into the drawer).
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 780))
    await expect.poll(matches).toBe(true)
  } finally { await app.close() }
})

test('从「网页」标签拖进分块；窄屏时在抽屉里打开，原生视图随抽屉出现和收起', async () => {
  const { app, page } = await launch()
  try {
    await newNovel(page)
    if (await page.locator('.side-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('.side-toggle').click()
    await page.getByRole('tab', { name: /^网页/ }).click()
    const entry = page.locator('.web-panel').getByRole('button', { name: '新网页' })
    const area = await page.locator('.split-view').boundingBox()
    const box = await entry.boundingBox()
    await page.mouse.move(box.x + 20, box.y + box.height / 2)
    await page.mouse.down()
    for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 20 + (area.x + area.width * .2 - box.x - 20) * i / 12, box.y + (area.y + area.height * .9 - box.y) * i / 12)
    await expect(page.locator('.drop-preview')).toBeVisible()
    await page.mouse.up()
    const pane = page.locator('.split-view .web-pane')
    await expect(pane).toHaveCount(1)
    await expect.poll(async () => { const b = await pane.boundingBox(); return Math.abs(b.y - (area.y + area.height / 2)) < 3 }).toBe(true)
    await expect(pane.getByRole('textbox', { name: '网址或搜索内容' })).toBeFocused()
    await closeWeb(pane)

    await app.evaluate(({ BrowserWindow }) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(300, 300); win.setContentSize(420, 800) })
    const drawn = await openWebPane(page, `${site.url}/page?title=抽屉`)
    await expect(page.locator('.compare-drawer')).toHaveAttribute('data-state', 'open')
    await expect(page.locator('.compare-drawer .web-pane')).toHaveCount(1)
    const stage = drawn.locator('.web-stage')
    await expect.poll(async () => {
      const [view] = await webViews(app)
      const r = await stage.evaluate((node) => { const b = node.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height } })
      return Boolean(view?.visible) && Math.abs(view.bounds.x - Math.round(r.x * view.zoom)) <= 1 && Math.abs(view.bounds.width - Math.round(r.width * view.zoom)) <= 1
    }).toBe(true)
    await page.keyboard.press('Escape')
    await page.locator('.compare-scrim').click({ position: { x: 10, y: 200 } }).catch(() => {})
    await expect(page.locator('.compare-drawer')).toHaveAttribute('data-state', 'closed')
    await expect.poll(async () => (await webViews(app))[0].visible).toBe(false)
  } finally { await app.close() }
})
