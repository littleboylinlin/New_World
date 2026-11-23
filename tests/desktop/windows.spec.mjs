import { startWork, chooseImportType } from '../navigation-helpers.mjs'
import { writingMotionFlow, measureTyping } from '../writing-motion-helpers.mjs'
import { expectDesktopWorkInformation, projectDesktopFlow } from './project-flow.mjs'
import { desktopStorySettingsFlow } from './story-settings-flow.mjs'
import { desktopBookChatFlow } from './book-chat-flow.mjs'
import { desktopStoryAiFlow } from './story-ai-flow.mjs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { _electron as electron, expect, test } from '@playwright/test'
import { createPackage, extractAll } from '@electron/asar'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { file } from '../fixtures.mjs'
import { privateWebSmoke } from './web-helpers.mjs'
import { selectReading, createAnnotation } from '../annotation-helpers.mjs'
import { checkNativeHeader } from '../header-layout.mjs'
import { chapterHeading, editorAction, historyCount, saveNow } from '../editor-helpers.mjs'

const { version } = JSON.parse(await readFile('package.json', 'utf-8'))
const versionTag = `v${version}`
const releaseBase = 'https://github.com/littleboylinlin/New_World/releases'
const releaseList = 'https://api.github.com/repos/littleboylinlin/New_World/releases?per_page=100'
const releaseTags = 'https://api.github.com/repos/littleboylinlin/New_World/releases/tags/'
const mirrorLatest = 'https://dl.writenewworld.com/latest.json'
const withoutMirror = (page) => page.route(mirrorLatest, (route) => route.fulfill({ status: 404, body: '', headers: { 'access-control-allow-origin': '*' } }))
const installer = process.env.NEW_WORLD_INSTALLER
const installDir = installer && (process.env.NEW_WORLD_INSTALL_DIR || join(process.env.LOCALAPPDATA, 'Programs', 'New World'))
const installedApp = installDir && join(installDir, 'New World.exe')
const uninstaller = installDir && join(installDir, 'Uninstall New World.exe')
const setup = promisify(execFile)
const editor = (page) => page.getByRole('textbox', { name: '章节正文' })
const status = (page) => page.locator('.save-status')

async function openSettingsCategory(page, category, locale = 'zh-CN') {
  const settingsPage = page.locator('.settings-page')
  if (!(await settingsPage.isVisible())) {
    await page.getByRole('link', { name: locale === 'en' ? 'Settings' : '设置', exact: true }).click()
    await expect(settingsPage).toBeVisible()
  }
  if (category) {
    await settingsPage.locator(`.settings-nav-item[data-category="${category}"]`).click()
  }
  return category ? settingsPage.locator(`.settings-panel[data-category="${category}"]`) : settingsPage
}

async function runSetup(path, directory = '') {
  const { stdout } = await setup('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$params = '/S'; if ($env:NEW_WORLD_SETUP_DIR) { $params += ' /D=' + $env:NEW_WORLD_SETUP_DIR }; $process = Start-Process -FilePath $env:NEW_WORLD_SETUP_FILE -ArgumentList $params -PassThru -Wait; Write-Output $process.ExitCode"], {
    env: { ...process.env, NEW_WORLD_SETUP_FILE: resolve(path), NEW_WORLD_SETUP_DIR: directory }, timeout: 90_000,
  })
  return Number(stdout.trim())
}

// The opening animation is off unless a test asks for it, so it never stands between a test and the page.
async function launch(testInfo, extraArgs = [], { intro = false } = {}) {
  const profile = testInfo.outputPath('profile')
  await mkdir(profile, { recursive: true })
  if (!installedApp) {
    const languageRoot = join(profile, 'NewWorld-languages')
    await mkdir(languageRoot, { recursive: true })
    const preference = join(languageRoot, 'language.json')
    if (!await stat(preference).catch(() => false)) await writeFile(preference, JSON.stringify({ locale: 'zh-CN' }))
  }
  const args = installedApp ? [] : ['.']
  // Keep normal startup offline. Version tests serve controlled responses via Chromium.
  args.push(...extraArgs)
  args.push('--proxy-server=http://127.0.0.1:1', '--disable-gpu')
  if (process.platform === 'linux' && !process.env.DISPLAY) args.push('--ozone-platform=headless')
  return electron.launch({ executablePath: installedApp || undefined, args, env: { ...process.env, XDG_CONFIG_HOME: profile, NEW_WORLD_DISABLE_INTRO: intro ? '0' : '1' } })
}

async function install() {
  const code = await runSetup(installer, installDir)
  const details = code ? await readFile(join(tmpdir(), 'NewWorld-language-install.log'), 'utf8').catch(() => '') : ''
  expect(code, details).toBe(0)
  expect((await stat(installedApp)).isFile()).toBe(true)
}

async function stop(app) {
  const exited = app.waitForEvent('close', { timeout: 10_000 }).catch(() => {})
  await app.evaluate(({ app }) => { setTimeout(() => app.exit(), 0) }).catch(() => {})
  await app.close().catch(() => {})
  await exited
}

const exportLabels = { txt: 'TXT', md: 'Markdown', html: 'HTML', docx: 'DOCX', pdf: 'PDF' }

async function exportTo(page, format) {
  await editorAction(page, '导出')
  const dialog = page.getByRole('dialog', { name: '导出编辑稿' })
  await dialog.getByRole('radio', { name: exportLabels[format] }).check()
  await dialog.getByRole('button', { name: '开始导出' }).click()
  // The dialog closes after Electron finishes native printing and writes the PDF.
  await expect(dialog).toBeHidden({ timeout: 30_000 })
}

async function expectCleanPdf(bytes, expectedText) {
  const loading = getDocument({ data: Uint8Array.from(bytes) })
  try {
    const pdf = await loading.promise
    expect(pdf.numPages).toBe(1)
    const page = await pdf.getPage(1)
    const { fnArray, argsArray } = await page.getOperatorList()
    // Read the PDF's paint colors before the display renderer antialiases the text.
    const colors = new Set(fnArray.flatMap((op, index) => (
      op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor ? [argsArray[index][0]] : []
    )))
    expect(colors.has('#000000')).toBe(true)
    expect([...colors].filter((color) => color !== '#000000' && color !== '#ffffff')).toEqual([])
    const text = (await page.getTextContent()).items.map((item) => item.str ?? '').join('')
    const normalized = (value) => value.normalize('NFKC').replace(/\s+/g, '')
    expect(normalized(text)).toContain(normalized(expectedText))
  } finally {
    await loading.destroy()
  }
}

test.beforeAll(async () => {
  if (installer) {
    await install()
    const oldPack = join(process.env.APPDATA, 'NewWorld-languages', 'packs', '0.0.0')
    await mkdir(oldPack, { recursive: true })
    await writeFile(join(oldPack, 'en.json'), 'old cache')
    const abandoned = join(tmpdir(), 'New World Updates', 'download-aB123C')
    await mkdir(abandoned, { recursive: true })
    await writeFile(join(abandoned, 'previous.exe'), 'old download')
  }
})

test.afterAll(async () => {
  if (!uninstaller || !await stat(uninstaller).catch(() => false)) return
  expect(await runSetup(uninstaller)).toBe(0)
  for (const key of ['Run', 'Explorer\\StartupApproved\\Run']) {
    await expect(setup('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\' + key, '/v', 'NewWorldBackground']))
      .rejects.toHaveProperty('code', 1)
  }
  await expect(stat(installedApp)).rejects.toHaveProperty('code', 'ENOENT')
  expect((await stat(join(process.env.APPDATA, 'NewWorld', 'IndexedDB'))).isDirectory()).toBe(true)
})

test('桌面平滑写作：光标、输入法、打字机模式和长章节输入性能', async ({}, info) => {
  const app = await launch(info)
  try {
    const page = await app.firstWindow()
    await writingMotionFlow(page)
    const result = await measureTyping(page)
    console.info('Typing performance:', JSON.stringify(result))
    await info.attach('typing-performance.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
    expect(result.fullCounts).toBe(0)
    expect(result.snapshots).toBe(0)
    expect(result.dispatch.median).toBeLessThan(16)
    expect(result.dispatch.p95).toBeLessThan(50)
    await page.screenshot({ path: info.outputPath('windows-writing-motion.png') })
  } finally { await stop(app) }
})

test('桌面离线打开、读写和导出，关闭及重新安装后保留原文和续写', async ({}, testInfo) => {
  // Installed Windows runs share the library with the preceding attempt.
  const attempt = testInfo.retry ? `（重试 ${testInfo.retry}）` : ''
  const originalTitle = '桌面续写原文' + attempt
  const pdfTitle = '桌面 PDF' + attempt
  const original = file(originalTitle + '.txt', '路旁亮着一盏灯。' + attempt)
  const savedText = '第一卷正文。Windows desktop export.' + attempt
  let app = await launch(testInfo)
  try {
    let page = await app.firstWindow()
    await expect(page.locator('#app-version')).toHaveText(versionTag)
    if (installer) {
      await expect.poll(() => stat(join(process.env.APPDATA, 'NewWorld-languages', 'packs', '0.0.0')).then(() => true, () => false)).toBe(false)
      await expect.poll(() => readFile(join(process.env.APPDATA, 'NewWorld', 'NewWorld-cache-version'), 'utf8').catch(() => '')).toBe(version)
      await expect.poll(() => stat(join(tmpdir(), 'New World Updates', 'download-aB123C')).then(() => true, () => false)).toBe(false)
    }
    await expect(page).toHaveURL('new-world://app/')
    await expect(page.locator('#update-banner')).toBeHidden()
    expect(await page.evaluate(() => ({ secure: isSecureContext, node: typeof require }))).toEqual({ secure: true, node: 'undefined' })
    // The app header replaces the system title bar. Windows draws its own caption buttons instead of the native
    // overlay, so they expose an accessible name but no system hover tooltip, and the header reserves room for them.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible())).toBe(false)
    const english = await page.locator('html').getAttribute('lang') === 'en'
    const header = await page.evaluate(() => {
      const inner = document.querySelector('.header-inner')
      const trash = document.querySelector('#trash-link').getBoundingClientRect()
      const settings = document.querySelector('#settings').getBoundingClientRect()
      const sidebar = document.querySelector('#app-sidebar').getBoundingClientRect()
      const controls = document.querySelector('.window-controls').getBoundingClientRect()
      // Only the buttons on screen: "Exit full screen" waits hidden until the window goes full screen.
      const buttons = [...document.querySelectorAll('.window-controls button')].filter((node) => node.checkVisibility()).map((node) => ({
        label: node.getAttribute('aria-label'), title: node.getAttribute('title'),
      }))
      return {
        top: inner.getBoundingClientRect().top, reserved: parseFloat(getComputedStyle(inner).paddingRight),
        gap: innerWidth - trash.right, viewport: innerWidth, buttons, right: controls.right, height: controls.height,
        settingsLeft: settings.left, sidebarLeft: sidebar.left, settingsBottom: settings.bottom, viewportHeight: innerHeight,
      }
    })
    expect(header.top).toBe(0)
    expect(header.reserved).toBeGreaterThan(90)
    expect(header.gap).toBeGreaterThan(90)
    expect(header.settingsLeft).toBeGreaterThanOrEqual(header.sidebarLeft - 1)
    expect(header.settingsBottom).toBeLessThanOrEqual(header.viewportHeight + 1)
    expect(header.buttons).toEqual((english
      ? ['Minimize', 'Maximize', 'Close window']
      : ['最小化', '最大化', '关闭窗口']).map((label) => ({ label, title: null })))
    expect(Math.abs(header.right - header.viewport)).toBeLessThanOrEqual(1)
    expect(header.height).toBe(46)
    await page.screenshot({ path: testInfo.outputPath('windows-home.png') })
    await checkNativeHeader(app, page, testInfo, 'windows')
    const controls = page.locator('.window-controls')
    await page.locator('#writing-link').click()
    await page.locator('[data-filter="reference"]').click()
    await page.locator('input[type=file]').setInputFiles(original)
    await chooseImportType(page, 'reference')
    await page.getByRole('link', { name: `查看 ${originalTitle}`, exact: true }).click()
    const projectUrl = page.url()
    await page.getByRole('button', { name: '新建续写' }).click()
    const continuation = page.getByRole('dialog', { name: '新建续写', exact: true })
    await continuation.getByRole('textbox', { name: '续写名称' }).fill('到达港口' + attempt)
    await continuation.getByRole('button', { name: '开始续写' }).click()
    await expect(continuation).toBeHidden({ timeout: 30_000 })
    await expect(editor(page)).toBeEditable({ timeout: 30_000 })
    await editor(page).fill('这段先保存。')
    const draftUrl = page.url()
    await expect(status(page)).toHaveText('已保存')
    const pdfPath = testInfo.outputPath('稿件.pdf')
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, pdfPath)
    await editor(page).fill(savedText)
    const exporting = performance.now()
    await exportTo(page, 'pdf')
    const exportedPdf = await readFile(pdfPath)
    console.info(`Desktop PDF export and write completed in ${Math.round(performance.now() - exporting)} ms`)
    expect(exportedPdf.subarray(0, 5).toString()).toBe('%PDF-')
    await expectCleanPdf(exportedPdf, savedText)
    await expect(page.locator('.print-edition')).toHaveCount(0)

    if (installer) {
      expect(await runSetup(installer)).toBe(2)
      await expect(editor(page)).toHaveText(savedText)
    }

    // No manual save and no wait for the autosave debounce before closing via the custom caption button.
    const lastText = `${savedText} 保存后再关窗。`
    await editor(page).fill(lastText)
    const exited = app.waitForEvent('close')
    await controls.getByRole('button', { name: english ? 'Close window' : '关闭窗口', exact: true }).click()
    await exited
    if (installer) await install()

    app = await launch(testInfo)
    page = await app.firstWindow()
    await page.goto(draftUrl)
    await expect(editor(page)).toHaveText(lastText, { timeout: 30_000 })
    await page.goto(projectUrl)
    await page.getByRole('link', { name: `查看原文 ${originalTitle}` }).click()
    await expect(page.getByRole('article')).toHaveText(original.buffer.toString())

    const originalPath = testInfo.outputPath(original.name)
    await app.evaluate(({ session }, savePath) => {
      session.defaultSession.once('will-download', (_event, item) => item.setSavePath(savePath))
    }, originalPath)
    await page.getByRole('button', { name: '下载原文件' }).click()
    await expect.poll(async () => readFile(originalPath).catch(() => null), { timeout: 30_000 }).toEqual(original.buffer)

    await page.getByRole('link', { name: 'New World 书库首页' }).click()
    await page.getByRole('link', { name: '写作', exact: true }).click()
    await page.locator('[data-filter="original"]').click()
    await expect(page.getByRole('link', { name: `查看 ${originalTitle}`, exact: true })).toHaveCount(0)
    await page.locator('input[type=file]').setInputFiles(file(pdfTitle + '.pdf', exportedPdf))
    await chooseImportType(page, 'original')
    await page.getByRole('link', { name: `查看 ${pdfTitle}`, exact: true }).click({ timeout: 30_000 })
    const canvas = page.getByRole('img', { name: 'PDF 第 1 页' })
    await expect(canvas).toBeVisible({ timeout: 30_000 })
    const marginsAreWhite = await canvas.evaluate((page) => {
      const context = page.getContext('2d')
      const x = Math.floor(page.width / 2)
      const y = Math.floor(page.height / 2)
      return [[x, 6], [6, y], [page.width - 7, y], [x, page.height - 7]].every(([x, y]) => (
        context.getImageData(x, y, 1, 1).data.every((channel) => channel === 255)
      ))
    })
    expect(marginsAreWhite).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('windows-reader.png') })
  } finally {
    await stop(app)
  }
})

test('阅读批注在安装版中可选区创建、悬停固定、切换形式并在重启后保留', async ({}, testInfo) => {
  let app = await launch(testInfo)
  try {
    let page = await app.firstWindow()
    await page.locator('#writing-link').click()
    await page.locator('[data-filter="original"]').click()
    await startWork(page)
    await page.getByRole('textbox', { name: '作品名' }).fill('桌面批注')
    await page.getByRole('button', { name: '创建小说' }).click()
    await editor(page).fill('桌面正文。\n第二段，English!')
    await editorAction(page, '阅读模式')
    await expect(page.locator('.annotation-manager summary')).toContainText('（0）')
    await selectReading(page, 2, 12)
    await createAnnotation(page, '重启后仍保留的批注\n第二行', 'mark', '#78b8ed')
    await page.locator('.annotation-mark').first().hover()
    await expect(page.locator('.annotation-popup')).toContainText('重启后仍保留')
    await page.locator('.annotation-popup .annotation-text').click()
    await chapterHeading(page).hover()
    await expect(page.locator('.annotation-popup')).toHaveAttribute('data-pinned', 'true')
    await page.locator('.annotation-popup').getByRole('button', { name: '编辑批注' }).click()
    const dialog = page.getByRole('dialog', { name: '编辑批注' })
    await dialog.getByLabel('展示形式').selectOption('inline')
    await dialog.getByLabel('自定义文字颜色').fill('#59738c')
    await dialog.getByRole('button', { name: '保存批注' }).click()
    await expect(page.locator('.annotation-inline')).toContainText('第二行')
    await expect(page.locator('.annotation-inline')).toHaveCSS('color', 'rgb(89, 115, 140)')
    await expect(page.locator('.annotation-inline')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const url = page.url()
    await stop(app)
    app = await launch(testInfo)
    page = await app.firstWindow()
    await page.goto(url)
    await expect(editor(page)).toHaveText('桌面正文。第二段，English!')
    await editorAction(page, '阅读模式')
    await expect(page.locator('.annotation-inline')).toContainText('重启后仍保留的批注')
    await expect(page.locator('.annotation-inline')).toHaveCSS('color', 'rgb(89, 115, 140)')
    await expect(page.locator('.annotation-inline')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page.locator('.novel-body').evaluate((node) => node.scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: testInfo.outputPath('windows-annotations.png'), fullPage: true })
  } finally { await stop(app) }
})

test('Windows 自绘窗口按钮可最大化、还原与最小化', async ({}, testInfo) => {
  const app = await launch(testInfo)
  try {
    const page = await app.firstWindow()
    const controls = page.locator('.window-controls')
    await expect(controls).toBeVisible()
    const english = await page.locator('html').getAttribute('lang') === 'en'
    const maximized = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())
    await controls.getByRole('button', { name: english ? 'Maximize' : '最大化', exact: true }).click()
    await expect.poll(maximized).toBe(true)
    const restore = controls.getByRole('button', { name: english ? 'Restore' : '还原', exact: true })
    await expect(restore).toBeVisible()
    await restore.click()
    await expect.poll(maximized).toBe(false)
    await expect(controls.getByRole('button', { name: english ? 'Maximize' : '最大化', exact: true })).toBeVisible()
    await controls.getByRole('button', { name: english ? 'Minimize' : '最小化', exact: true }).click()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true)
  } finally {
    await stop(app)
  }
})

function stable(tag, fields = {}) {
  const name = `New-World-Setup-${tag.slice(1)}-x64.exe`
  return {
    tag_name: tag, draft: false, prerelease: false, body: '改进离线写作。',
    assets: [{
      name, size: 1, state: 'uploaded', digest: 'sha256:' + 'a'.repeat(64),
      browser_download_url: `${releaseBase}/download/${tag}/${name}`,
    }],
    ...fields,
  }
}

// The mirror has nothing here: latest.json and the mirrored installer both answer 404, so GitHub serves both.
async function mockUpdateDownload(app, release, { filePath, body }) {
  const metadata = releaseTags + release.tag_name
  const download = release.assets[0].browser_download_url
  const mirrored = `https://dl.writenewworld.com/${release.tag_name}/${release.assets[0].name}`
  await app.evaluate(({ session }, fixture) => {
    const { createReadStream } = process.getBuiltinModule('node:fs')
    const { Readable } = process.getBuiltinModule('node:stream')
    globalThis.testUpdateRequests = []
    globalThis.testUpdateConnections = []
    const gate = Promise.withResolvers()
    globalThis.testContinueUpdate = gate.resolve
    const fetch = (slot) => async (url, options) => {
      const range = options?.headers?.Range ?? null
      globalThis.testUpdateRequests.push({ url, range })
      if (url === fixture.metadata) return Response.json(fixture.release)
      if (url !== fixture.download) return new Response(null, { status: 404 })
      if (!fixture.filePath) return new Response(fixture.body)
      const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(range) ?? []
      if (!first || !last) return new Response(null, { status: 400 })
      const start = Number(first), end = Number(last)
      const stream = Readable.toWeb(createReadStream(fixture.filePath, { start, end }))
      const metadata = { status: 206, headers: {
        'content-range': `bytes ${start}-${end}/${fixture.release.assets[0].size}`,
        'content-length': String(end - start + 1),
      } }
      if (range === 'bytes=0-0') return new Response(stream, metadata)
      globalThis.testUpdateConnections.push(slot)
      const reader = stream.getReader()
      let sent = false
      return new Response(new ReadableStream({
        async pull(controller) {
          if (sent) await gate.promise
          const { value, done } = await reader.read()
          if (done) controller.close()
          else {
            controller.enqueue(value)
            sent = true
          }
        },
        cancel: () => reader.cancel(),
      }), metadata)
    }
    for (let slot = 0; slot < 6; slot++) {
      session.fromPartition(slot ? `new-world-update-${slot}` : 'new-world-update').fetch = fetch(slot)
    }
  }, { metadata, download, release, filePath, body })
  const requests = [
    { url: mirrorLatest, range: null },
    { url: metadata, range: null },
    { url: mirrored, range: 'bytes=0-0' },
    { url: download, range: 'bytes=0-0' },
  ]
  if (!filePath) {
    // The corrupt whole-file winner falls back to the mirror once more.
    return [...requests, ...[mirrored, download, mirrored].map((url) => ({ url, range: null }))]
  }
  const blockSize = 4 * 1024 * 1024
  const size = release.assets[0].size
  for (let start = 0; start < size; start += blockSize) {
    requests.push({ url: download, range: `bytes=${start}-${Math.min(start + blockSize, size) - 1}` })
  }
  return requests
}

test('启动检查 Windows 正式安装包，支持失败重试并保护未保存的稿件', async ({}, testInfo) => {
  const app = await launch(testInfo)
  try {
    const page = await app.firstWindow()
    let launchChecks = 0
    page.on('request', (request) => { if (request.url() === releaseList) launchChecks++ })
    await expect(page.getByRole('link', { name: 'New World 书库首页' })).toBeVisible()
    const [major, minor, patch] = version.split('.').map(Number)
    const next = `v${major}.${minor}.${patch + 10}`
    const older = `v${major}.${minor}.${patch + 2}`
    const future = `v${major + 1}.0.0`
    const foreign = stable(future)
    foreign.assets[0].browser_download_url = 'https://example.invalid/setup.exe'
    const noDigest = stable(future)
    delete noDigest.assets[0].digest
    let result = [stable(older), stable(next), stable(future, { assets: [] }), stable(`${future}-rc.1`, { prerelease: true }), stable(future, { draft: true }), foreign, noDigest]
    let requests = 0
    let responseStatus = 200
    // The launch check tries the mirror before GitHub; wait for its GitHub request so only the reloaded page is counted.
    await expect.poll(() => launchChecks, { timeout: 20_000 }).toBeGreaterThan(0).catch(() => {})
    await withoutMirror(page)
    await page.route(releaseList, async (route) => {
      requests++
      if (responseStatus === 0) return route.abort('internetdisconnected')
      await route.fulfill({ status: responseStatus, json: result, headers: { 'access-control-allow-origin': '*' } })
    })
    await page.addInitScript(() => {
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'chapters' && globalThis.desktopTestStorageFull) throw new DOMException('test', 'QuotaExceededError')
        return put.apply(this, args)
      }
    })
    await page.reload()
    const banner = page.locator('#update-banner')
    await expect(banner).toContainText(next)
    expect(requests).toBe(1)
    await banner.getByRole('button', { name: '本次忽略' }).click()
    await expect(banner).toBeHidden()
    const help = await openSettingsCategory(page, 'updates')
    await expect(help).toContainText(`当前运行版本 ${versionTag} · Windows x64`)
    await expect(help).toContainText('改进离线写作。')
    await expect(help.getByRole('link', { name: '查看 GitHub 发布页' })).toHaveAttribute('href', `${releaseBase}/tag/${next}`)
    await expect(help.getByRole('button', { name: '重新加载当前网页' })).toHaveCount(0)
    const check = help.getByRole('button', { name: '检查更新' })
    result = [stable(future, { assets: [] }), stable(versionTag)]
    await check.click()
    await expect(help.locator('.update-state')).toHaveText('当前已是最新版本。')
    responseStatus = 0
    await check.click()
    await expect(help.locator('.update-state')).toContainText('无法连接 GitHub')
    responseStatus = 429
    await check.click()
    await expect(help.locator('.update-state')).toContainText('更新服务器暂时繁忙，请稍后重试或切换网络。')
    responseStatus = 200
    result = { unexpected: true }
    await check.click()
    await expect(help.locator('.update-state')).toContainText('版本信息不完整或格式异常')
    result = [stable(future, { assets: [] }), foreign, noDigest]
    await check.click()
    await expect(help.locator('.update-state')).toContainText('暂未提供可校验的 Windows x64 正式安装包')
    result = [stable(next)]
    await check.click()
    await expect(help.locator('.update-state')).toContainText(next)
    expect(requests).toBe(7)
    await page.locator('.settings-back').click()

    await page.locator('#writing-link').click()
    await page.locator('[data-filter="original"]').click()
    await startWork(page)
    await page.getByRole('textbox', { name: '作品名' }).fill('检查更新时的稿件')
    await page.getByRole('button', { name: '创建小说' }).click()
    await expect(editor(page)).toBeVisible()
    const draftUrl = page.url()
    await app.evaluate(({ shell }) => {
      globalThis.testExternalLinks = []
      shell.openExternal = async (url) => { globalThis.testExternalLinks.push(url) }
    })
    const corrupt = stable(next)
    const expectedRequests = await mockUpdateDownload(app, corrupt, { body: 'x' })
    await page.evaluate(() => { globalThis.desktopTestStorageFull = true })
    await editor(page).fill('这段正文必须留在桌面端。')
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await expect(page).toHaveURL(draftUrl)
    await expect(status(page)).toHaveText('未保存 · 失败')
    await expect(page.locator('.settings-page')).toBeHidden()
    expect(await app.evaluate(() => globalThis.testExternalLinks)).toEqual([])
    expect(await app.evaluate(() => globalThis.testUpdateRequests)).toEqual([])
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect(status(page)).toHaveText('未保存 · 失败')
    await page.evaluate(() => { globalThis.desktopTestStorageFull = false })
    await openSettingsCategory(page, 'updates')
    const download = help.getByRole('button', { name: '更新并重启' })
    await download.click()
    await expect(help.getByRole('alert')).toContainText(installer ? 'SHA-256 校验不匹配' : '适用于已安装的 Windows x64 正式版')
    expect(await app.evaluate(() => globalThis.testUpdateRequests)).toEqual(installer ? expectedRequests : [])
    expect(await app.evaluate(() => globalThis.testExternalLinks)).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('windows-updates.png') })
    await page.locator('.settings-back').click()
    await expect(page).toHaveURL(draftUrl)
    await expect(status(page)).toHaveText('已保存')
    const invalid = await page.evaluate(() => window.newWorldDesktop.downloadUpdate('https://example.invalid/'))
    expect(invalid.ok).toBe(false)
    expect(await app.evaluate(() => globalThis.testUpdateRequests)).toEqual(installer ? expectedRequests : [])
  } finally {
    await stop(app)
  }
})

async function stagePreviousApp(previous, testInfo) {
  // Exercise the real installed executable and NSIS package without building a second installer.
  const archive = join(installDir, 'resources', 'app.asar')
  const fixture = testInfo.outputPath('previous-app')
  extractAll(archive, fixture)
  const metadata = join(fixture, 'package.json')
  const packageInfo = JSON.parse(await readFile(metadata, 'utf-8'))
  expect(packageInfo.version).toBe(version)
  await writeFile(metadata, JSON.stringify({ ...packageInfo, version: previous }))
  const assets = join(fixture, 'dist', 'assets')
  let replaced = false
  for (const bundle of (await readdir(assets)).filter((name) => name.endsWith('.js'))) {
    const path = join(assets, bundle)
    const renderer = await readFile(path, 'utf8')
    if (renderer.includes(version)) {
      replaced = true
      await writeFile(path, renderer.replaceAll(version, previous))
    }
  }
  expect(replaced).toBe(true)
  const staged = testInfo.outputPath('previous-app.asar')
  await createPackage(fixture, staged)
  await rename(staged, archive)
}

async function restartedPid(previousPid) {
  const { stdout } = await setup('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$window = Get-Process -Name 'New World' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:NEW_WORLD_TEST_EXE -and $_.Id -ne [int]$env:NEW_WORLD_PREVIOUS_PID -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($window) { $window.Id }"], {
    env: { ...process.env, NEW_WORLD_TEST_EXE: installedApp, NEW_WORLD_PREVIOUS_PID: String(previousPid) }, timeout: 12_000,
  })
  return Number(stdout.trim())
}

async function closeRestarted(pid) {
  await setup('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$window = Get-Process -Id ([int]$env:NEW_WORLD_RESTART_PID) -ErrorAction Stop; if ($window.Path -ne $env:NEW_WORLD_TEST_EXE -or !$window.CloseMainWindow() -or !$window.WaitForExit(10000)) { throw 'Could not close the restarted test application' }"], {
    env: { ...process.env, NEW_WORLD_TEST_EXE: installedApp, NEW_WORLD_RESTART_PID: String(pid) }, timeout: 15_000,
  })
}

test('应用内下载校验、原目录覆盖安装和自动重启后保留下载期间的编辑', async ({}, testInfo) => {
  test.skip(!installer, '此用例需要 Windows 安装包')
  const [major, minor, patch] = version.split('.').map(Number)
  const previous = patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.99`
  const release = stable(versionTag)
  release.assets[0].size = (await stat(installer)).size
  release.assets[0].digest = 'sha256:' + createHash('sha256').update(await readFile(installer)).digest('hex')
  await stagePreviousApp(previous, testInfo)
  const obsolete = join(installDir, 'resources', 'obsolete-previous-version.txt')
  await writeFile(obsolete, 'must disappear')

  let app = await launch(testInfo)
  let restarted = 0
  try {
    const priorPid = app.process().pid
    const page = await app.firstWindow()
    expect(await app.evaluate(({ app }) => app.getVersion())).toBe(previous)
    const requests = await mockUpdateDownload(app, release, { filePath: installer })
    await withoutMirror(page)
    await page.route(releaseList, (route) => route.fulfill({
      json: [release], headers: { 'access-control-allow-origin': '*' },
    }))
    await page.addInitScript(() => {
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'chapters' && globalThis.desktopTestStorageFull) throw new DOMException('test', 'QuotaExceededError')
        return put.apply(this, args)
      }
    })
    await page.reload()
    await expect(page.locator('#app-version')).toHaveText('v' + previous)
    await expect(page.locator('#update-banner')).toContainText(versionTag)
    await page.locator('#writing-link').click()
    await page.locator('[data-filter="original"]').click()
    await startWork(page)
    await page.getByRole('textbox', { name: '作品名' }).fill('应用内更新前的稿件')
    await page.getByRole('button', { name: '创建小说' }).click()
    await editor(page).fill('更新前已写好的正文。')
    await expect(status(page)).toHaveText('已保存')
    const draftUrl = page.url()
    const help = await openSettingsCategory(page, 'updates')
    const update = help.getByRole('button', { name: '更新并重启' })
    await update.click()
    const progress = help.getByRole('progressbar', { name: '安装包下载进度' })
    await expect.poll(() => progress.evaluate((bar) => bar.value)).toBeGreaterThan(0)
    await expect(page.locator('#update-banner')).toContainText(/ · \d+% · [\d.,]+ (?:B|KiB|MiB)\/s/)
    await page.screenshot({ path: testInfo.outputPath('windows-update-download.png') })
    await page.locator('.settings-back').click()
    const lastText = '下载期间新增的正文也要保留。'
    await page.evaluate(() => { globalThis.desktopTestStorageFull = true })
    await editor(page).fill(lastText)
    await app.evaluate(() => globalThis.testContinueUpdate())
    await expect(page.locator('#update-banner')).toContainText('安装包已下载', { timeout: 30_000 })
    const actualRequests = await app.evaluate(() => globalThis.testUpdateRequests)
    expect(actualRequests.slice(0, 4)).toEqual(requests.slice(0, 4))
    expect(actualRequests).toHaveLength(requests.length)
    expect(actualRequests.slice(4)).toEqual(expect.arrayContaining(requests.slice(4)))
    expect(new Set(await app.evaluate(() => globalThis.testUpdateConnections)).size).toBe(6)
    await expect(page.locator('.novel-body')).toHaveText(lastText)
    await page.evaluate(() => { globalThis.desktopTestStorageFull = false })
    await page.locator('#update-banner').getByRole('button', { name: '查看更新' }).click()
    await expect(help.getByRole('alert')).toContainText('安装包已下载')
    const exited = app.waitForEvent('close', { timeout: 30_000 })
    await update.click()
    await exited
    app = undefined

    await expect.poll(async () => {
      restarted = await restartedPid(priorPid)
      return restarted
    }, { timeout: 60_000 }).toBeGreaterThan(0)
    await closeRestarted(restarted)
    restarted = 0
    app = await launch(testInfo)
    const current = await app.firstWindow()
    expect(await app.evaluate(({ app }) => app.getVersion())).toBe(version)
    await expect(stat(obsolete)).rejects.toHaveProperty('code', 'ENOENT')
    await expect.poll(async () => (await readdir(join(tmpdir(), 'New World Updates'))).filter((name) => name.startsWith('download-')), { timeout: 30_000 }).toEqual([])
    await expect(current.locator('#app-version')).toHaveText(versionTag)
    await current.goto(draftUrl)
    await expect(editor(current)).toHaveText(lastText)
  } finally {
    if (app) await stop(app)
    if (restarted) await closeRestarted(restarted).catch(() => {})
  }
})

test('英语语言包按需获取，切换菜单与界面后离线重开仍保留选择', async ({}, testInfo) => {
  let app = await launch(testInfo)
  try {
    let page = await app.firstWindow()
    await expect(page.getByRole('link', { name: '设置', exact: true })).toBeVisible()
    if (installer) {
      expect(await app.evaluate(({ app }) => {
        const { existsSync } = process.getBuiltinModule('node:fs')
        const { join } = process.getBuiltinModule('node:path')
        return existsSync(join(app.getAppPath(), 'dist', 'locales'))
      })).toBe(false)
    }
    const pack = await readFile('public/locales/New-World-lang-en.json', 'utf8')
    await app.evaluate(({ session }, body) => {
      globalThis.testLanguageRequests = []
      session.fromPartition('new-world-language-packs').fetch = async (url) => {
        globalThis.testLanguageRequests.push(url)
        return url.endsWith('/New-World-lang-en.json') ? new Response(body) : new Response(null, { status: 404 })
      }
    }, pack)
    let settings = await openSettingsCategory(page, 'general')
    await settings.getByRole('combobox', { name: '语言', exact: true }).selectOption('en')
    await settings.getByRole('button', { name: '应用语言' }).click()
    await expect.poll(() => app.evaluate(({ app }) => {
      const { readFileSync } = process.getBuiltinModule('node:fs')
      const { join } = process.getBuiltinModule('node:path')
      return JSON.parse(readFileSync(join(app.getPath('appData'), 'NewWorld-languages', 'language.json'), 'utf8')).locale
    })).toBe('en')
    settings = page.locator('.settings-page')
    await expect(settings).toBeVisible()
    await expect(settings.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((item) => item.label))).toEqual(['Edit', 'View'])
    if (installer) {
      expect(await app.evaluate(() => globalThis.testLanguageRequests)).toEqual([
        `https://dl.writenewworld.com/v${version}/New-World-lang-en.json`,
      ])
    }
    await page.screenshot({ path: testInfo.outputPath('windows-english-settings.png') })
    await settings.locator('.settings-back').click()
    await checkNativeHeader(app, page, testInfo, 'windows')
    await stop(app)
    app = await launch(testInfo)
    page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Writing stats' })).toBeVisible()
    settings = await openSettingsCategory(page, 'general', 'en')
    await expect(settings.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('en')
    await settings.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN')
    await settings.getByRole('button', { name: 'Apply language' }).click()
    await expect(page.locator('.settings-page').getByRole('heading', { name: '常规', exact: true })).toBeVisible()
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((item) => item.label))).toEqual(['编辑', '视图'])
  } finally { await stop(app) }
})

test('黑色主题重开时窗口直接以深色底色打开，不先闪浅色', async ({}, testInfo) => {
  const themeFile = ({ app }) => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const { join } = process.getBuiltinModule('node:path')
    try { return JSON.parse(readFileSync(join(app.getPath('appData'), 'NewWorld-appearance.json'), 'utf8')).theme } catch { return null }
  }
  const windowState = ({ BrowserWindow, nativeTheme }) => ({
    background: BrowserWindow.getAllWindows()[0]?.getBackgroundColor().toLowerCase(),
    source: nativeTheme.themeSource,
  })
  let app = await launch(testInfo)
  try {
    let page = await app.firstWindow()
    let section = await openSettingsCategory(page, 'appearance')
    await section.getByRole('radio', { name: /黑色/ }).check()
    await expect.poll(() => app.evaluate(themeFile)).toBe('dark')
    await expect.poll(() => app.evaluate(windowState)).toEqual({ background: '#131210', source: 'dark' })
    await stop(app)

    app = await launch(testInfo)
    page = await app.firstWindow()
    // Checked as soon as the window exists: the background comes from the saved theme, not the page.
    expect(await app.evaluate(windowState)).toEqual({ background: '#131210', source: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.screenshot({ path: testInfo.outputPath('windows-dark-theme.png') })

    // Leave the shared profile as it was for the other desktop tests.
    section = await openSettingsCategory(page, 'appearance')
    await section.getByRole('radio', { name: /跟随系统/ }).check()
    await expect.poll(() => app.evaluate(themeFile)).toBe('system')
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
  } finally { await stop(app) }
})

test('冷启动开场动画会自行结束：窗口在后台时也不会一直挡住页面', async ({}, testInfo) => {
  const app = await launch(testInfo, [], { intro: true })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    expect(await page.evaluate(() => 'newWorldIntro' in window)).toBe(true)
    // Animation frames can stop for a window that is not in front; the intro must end on its own anyway.
    await app.evaluate(({ BrowserWindow }) => { const [win] = BrowserWindow.getAllWindows(); win.blur(); win.minimize() })
    await expect(page.locator('.nw-intro')).toHaveCount(0, { timeout: 15_000 })
    await app.evaluate(({ BrowserWindow }) => { const [win] = BrowserWindow.getAllWindows(); win.restore(); win.focus() })
    await expect(page).toHaveURL('new-world://app/')
    await page.locator('#writing-link').click()
    await expect(page).toHaveURL(/#\/writing/)
  } finally { await stop(app) }
})

test('拼写检查使用随应用安装的英文词典，不需要联网下载', async ({}, testInfo) => {
  const app = await launch(testInfo)
  try {
    const page = await app.firstWindow()
    expect(await app.evaluate(({ app, session }) => {
      const { readdirSync } = process.getBuiltinModule('node:fs')
      const { join } = process.getBuiltinModule('node:path')
      return {
        files: readdirSync(join(app.getPath('userData'), 'Dictionaries')).filter((name) => name.endsWith('.bdic')).sort(),
        languages: session.defaultSession.getSpellCheckerLanguages(),
      }
    })).toEqual({ files: ['en-GB-10-2.bdic', 'en-US-10-2.bdic'], languages: ['en-US', 'en-GB'] })
    await app.evaluate(({ BrowserWindow, session }) => {
      globalThis.dictionaryFailures = []
      session.defaultSession.on('spellcheck-dictionary-download-failure', (_event, language) => globalThis.dictionaryFailures.push(language))
      // Record the right click instead of opening the native menu, which would wait for input.
      const contents = BrowserWindow.getAllWindows()[0].webContents
      contents.removeAllListeners('context-menu')
      contents.on('context-menu', (_event, params) => {
        globalThis.spellingClick = { word: params.misspelledWord, suggestions: params.dictionarySuggestions }
      })
    })

    await page.locator('#writing-link').click()
    await page.locator('[data-filter="original"]').click()
    await startWork(page)
    await page.getByRole('textbox', { name: '作品名' }).fill('Spelling')
    await page.getByRole('button', { name: '创建小说' }).click()
    await expect(editor(page)).toBeVisible()
    await page.getByRole('button', { name: '外观', exact: true }).click()
    const spelling = page.getByRole('group', { name: '外观' }).getByRole('checkbox', { name: '拼写检查' })
    await spelling.check()
    await page.keyboard.press('Escape')
    await editor(page).click()
    await page.keyboard.type('Teh lighthouse ')

    await expect.poll(async () => {
      await editor(page).locator('p').first().click({ button: 'right', position: { x: 8, y: 12 } })
      return app.evaluate(() => globalThis.spellingClick?.word ?? '')
    }, { timeout: 20_000 }).toBe('Teh')
    expect((await app.evaluate(() => globalThis.spellingClick.suggestions)).length).toBeGreaterThan(0)
    expect(await app.evaluate(() => globalThis.dictionaryFailures)).toEqual([])

    // Leave the shared profile as it was for the other desktop tests.
    await page.getByRole('button', { name: '外观', exact: true }).click()
    await spelling.uncheck()
  } finally { await stop(app) }
})

test('可导入或从链接下载其他语言的拼写词典，与内置词典一起使用并可移除', async ({}, testInfo) => {
  const app = await launch(testInfo)
  try {
    const page = await app.firstWindow()
    const languages = () => app.evaluate(({ session }) => session.defaultSession.getSpellCheckerLanguages())
    // The file dialog is native, so it returns a prepared copy of an English dictionary instead.
    await app.evaluate(({ app, dialog }) => {
      const { copyFileSync } = process.getBuiltinModule('node:fs')
      const { join } = process.getBuiltinModule('node:path')
      const file = join(app.getPath('temp'), 'en-AU-10-2.bdic')
      copyFileSync(join(app.getPath('userData'), 'Dictionaries', 'en-US-10-2.bdic'), file)
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    })
    const section = await openSettingsCategory(page, 'appearance')
    const list = section.getByRole('list', { name: '拼写词典' })
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect(list).toContainText('en-US')
    await expect(list).toContainText('en-GB')

    await section.getByRole('button', { name: '导入词典文件…' }).click()
    await expect(section.locator('.dictionary-box .settings-state')).toContainText('已添加')
    await expect(list.getByRole('listitem')).toHaveCount(3)
    await expect.poll(languages).toEqual(['en-US', 'en-GB', 'en-AU'])

    // The desktop tests run offline, so the dictionary session answers with a real dictionary file.
    await app.evaluate(({ app, session }) => {
      const { readFileSync } = process.getBuiltinModule('node:fs')
      const { join } = process.getBuiltinModule('node:path')
      const body = readFileSync(join(app.getPath('userData'), 'Dictionaries', 'en-US-10-2.bdic'))
      globalThis.testDictionaryRequests = []
      session.fromPartition('new-world-dictionaries').fetch = async (url) => {
        globalThis.testDictionaryRequests.push(url)
        if (!url.endsWith('/fr-fr-3-0.bdic')) return new Response(null, { status: 404 })
        // Like Chromium's download server, which can redirect to plain http.
        return { ok: true, url: 'http://r1.example.gvt1.com/edgedl/chrome/dict/fr-fr-3-0.bdic', headers: new Headers(), arrayBuffer: async () => body }
      }
    })
    await section.getByRole('textbox', { name: '或从链接下载' }).fill('https://redirector.gvt1.com/edgedl/chrome/dict/fr-fr-3-0.bdic')
    await section.getByRole('button', { name: '下载', exact: true }).click()
    await expect(section.locator('.dictionary-box .settings-state')).toContainText('已添加', { timeout: 60_000 })
    await expect(list).toContainText('fr-FR')
    await expect(section.locator('.dictionary-box .settings-state')).toContainText('未加密的 http')
    await expect.poll(languages).toEqual(['en-US', 'en-GB', 'en-AU', 'fr-FR'])
    expect(await app.evaluate(() => globalThis.testDictionaryRequests)).toEqual(['https://redirector.gvt1.com/edgedl/chrome/dict/fr-fr-3-0.bdic'])
    await page.screenshot({ path: testInfo.outputPath('windows-spelling-dictionaries.png') })

    await section.getByRole('textbox', { name: '或从链接下载' }).fill('https://example.com/french.bdic')
    await section.getByRole('button', { name: '下载', exact: true }).click()
    await expect(section.locator('.dictionary-box .settings-state')).toContainText('文件名不对')

    for (const code of ['en-AU', 'fr-FR']) await list.getByRole('listitem').filter({ hasText: code }).getByRole('button').click()
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect.poll(languages).toEqual(['en-US', 'en-GB'])
    // Removed dictionaries are deleted right away, not left for the next start.
    expect(await app.evaluate(({ app }) => {
      const { readdirSync } = process.getBuiltinModule('node:fs')
      const { join } = process.getBuiltinModule('node:path')
      return readdirSync(join(app.getPath('userData'), 'Dictionaries')).sort()
    })).toEqual(['en-GB-10-2.bdic', 'en-US-10-2.bdic'])
  } finally { await stop(app) }
})

test('自动备份和立即备份写入自选文件夹，可加密，并能从备份恢复', async ({}, testInfo) => {
  const folder = testInfo.outputPath('backups')
  const backups = async () => (await readdir(folder).catch(() => [])).sort()
  const app = await launch(testInfo)
  try {
    const page = await app.firstWindow()
    // Native file dialogs are replaced: folders resolve to the test folder, files to the chosen backup.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async (_window, options) => ({
        canceled: false, filePaths: [options.properties.includes('openDirectory') ? folder : globalThis.testRestorePath],
      })
    }, folder)

    await page.locator('#writing-link').click()
    await page.locator('[data-filter="original"]').click()
    await startWork(page)
    await page.getByRole('textbox', { name: '作品名' }).fill('备份的灯塔')
    await page.getByRole('button', { name: '创建小说' }).click()
    await editor(page).fill('守夜人把灯点亮。')
    await saveNow(page)
    await expect(page.locator('.save-status')).toHaveText('已保存')

    const section = await openSettingsCategory(page, 'backup')
    await expect(section.getByRole('radio', { name: '每天' })).toBeChecked()
    await expect(section.locator('.backup-location')).toContainText('New World Backups')
    await section.getByRole('button', { name: '选择文件夹…' }).click()
    await expect(section.locator('.backup-location')).toContainText(folder)
    await expect(section.locator('.backup-location')).toContainText('自选位置')

    await section.getByRole('radio', { name: '用密码加密' }).check()
    const ask = page.getByRole('dialog', { name: '设置备份密码' })
    await ask.getByLabel('密码', { exact: true }).fill('harbour')
    await ask.getByLabel('再次输入密码').fill('harbour')
    await ask.getByRole('button', { name: '设置密码' }).click()
    await expect(section.locator('.backup-state')).toHaveText('之后的备份都会加密。')
    expect(JSON.stringify(await app.evaluate(({ app }) => {
      const { readFileSync } = process.getBuiltinModule('node:fs')
      const { join } = process.getBuiltinModule('node:path')
      return JSON.parse(readFileSync(join(app.getPath('appData'), 'NewWorld-backup.json'), 'utf8'))
    }))).not.toContain('harbour')

    await section.getByRole('button', { name: '立即备份' }).click()
    await expect(section.locator('.backup-state')).toContainText(/已备份 \d+ 部作品到/)
    const manual = (await backups()).find((name) => name.startsWith('New-World-backup-'))
    expect(manual).toBeTruthy()
    expect((await readFile(join(folder, manual)))[6] & 1).toBe(1)

    // The first automatic backup is due right away and runs shortly after the start.
    await expect(section.locator('.backup-last')).toContainText('上次自动备份', { timeout: 60_000 })

    await page.locator('.settings-back').click()
    await editor(page).fill('恢复前改过的正文。')
    await saveNow(page)
    await expect(page.locator('.save-status')).toHaveText('已保存')

    await app.evaluate((_electron, path) => { globalThis.testRestorePath = path }, join(folder, manual))
    await openSettingsCategory(page, 'backup')
    await section.getByRole('button', { name: '从备份恢复…' }).click()
    const password = page.getByRole('dialog', { name: '输入备份密码' })
    await password.getByLabel('密码', { exact: true }).fill('harbour')
    await password.getByRole('button', { name: '打开' }).click()
    await page.getByRole('dialog', { name: '从备份恢复' }).getByRole('button', { name: '替换当前书库' }).click()
    await expect(page.getByText(/已从备份恢复 \d+ 部作品。/)).toBeVisible()
    expect((await backups()).some((name) => name.startsWith('New-World-before-restore-'))).toBe(true)
    await page.locator('#writing-link').click()
    await page.locator('[data-filter="original"]').click()
    await page.getByRole('link', { name: '查看 备份的灯塔', exact: true }).click()
    await expect(editor(page)).toHaveText('守夜人把灯点亮。')

    // Leave the shared profile as it was for the other desktop tests.
    await openSettingsCategory(page, 'backup')
    await section.getByRole('radio', { name: '不加密' }).check()
    await expect(section.locator('.backup-state')).toHaveText('之后的备份不加密。')
    await section.getByRole('button', { name: '恢复默认位置' }).click()
    await expect(section.locator('.backup-location')).toContainText('默认位置')
  } finally { await stop(app) }
})

test('备份保留份数只在确认名单后清理升级遗留和缩减份数的旧备份', async ({}, info) => {
  const folder = info.outputPath('retention')
  await mkdir(folder, { recursive: true })
  const names = (kind, count) => Array.from({ length: count }, (_, index) =>
    `New-World-${kind}-2026-01-${String(index + 1).padStart(2, '0')}-000000.zip`)
  const automatic = names('auto-backup', 7)
  const restored = names('before-restore', 12)
  const others = [...names('backup', 2), 'user-backup.zip', 'New-World-before-restore-KEEP.zip']
  const all = [...automatic, ...restored, ...others]
  await Promise.all(all.map((name) => writeFile(join(folder, name), 'test fixture')))
  const app = await launch(info)
  try {
    const page = await app.firstWindow()
    const section = await openSettingsCategory(page, 'backup')
    const prior = await page.evaluate(() => window.newWorldDesktop.getBackupState())
    await page.evaluate(() => window.newWorldDesktop.setBackupFrequency('off'))
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, folder)
    await section.getByRole('button', { name: '选择文件夹…' }).click()
    await expect(section.locator('.backup-location')).toContainText(folder)
    const auto = section.getByLabel('自动备份保留份数')
    const before = section.getByLabel('恢复前备份保留份数')
    const clean = page.getByRole('dialog', { name: '清理旧备份？' })
    const onDisk = async () => (await readdir(folder)).sort()
    try {
      await expect(auto).toHaveValue('10')
      await expect(before).toHaveValue('10')
      await expect(section.getByText('有 2 份旧备份超出保留份数。')).toBeVisible()
      expect(await onDisk()).toEqual(all.toSorted())
      await auto.selectOption('5')
      await expect(clean.getByRole('listitem')).toHaveText(automatic.slice(0, 2))
      await clean.getByRole('button', { name: '取消' }).click()
      await expect(clean).toBeHidden()
      await expect(auto).toHaveValue('10')
      expect(await onDisk()).toEqual(all.toSorted())
      await auto.selectOption('5')
      await clean.getByRole('button', { name: '清理', exact: true }).click()
      await expect(auto).toHaveValue('5')
      await expect(clean).toBeHidden()
      expect(await onDisk()).toEqual([...automatic.slice(2), ...restored, ...others].sort())
      await section.getByRole('button', { name: '清理', exact: true }).click()
      await expect(clean.getByRole('listitem')).toHaveText(restored.slice(0, 2))
      await clean.getByRole('button', { name: '清理', exact: true }).click()
      await expect(clean).toBeHidden()
      await expect(section.getByText('有 2 份旧备份超出保留份数。')).toBeHidden()
      expect(await onDisk()).toEqual([...automatic.slice(2), ...restored.slice(2), ...others].sort())
      await before.selectOption('null')
      await expect.poll(() => page.evaluate(async () => (await window.newWorldDesktop.getBackupState()).retention['before-restore'])).toBeNull()
    } finally {
      await page.evaluate(async (previous) => {
        const desktop = window.newWorldDesktop
        for (const [kind, limit] of Object.entries(previous.retention)) {
          const plan = await desktop.planBackupRetention(kind, limit)
          await desktop.applyBackupRetention(kind, limit, plan.token)
        }
        await desktop.setBackupFrequency(previous.frequency)
        if (!previous.custom) await desktop.resetBackupFolder()
      }, prior)
      if (prior.custom) {
        await app.evaluate(({ dialog }, path) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
        }, prior.folder)
        await page.evaluate(() => window.newWorldDesktop.chooseBackupFolder())
      }
    }
  } finally { await stop(app) }
})

test('灵感速记：全局快捷键可在设置里更换，任务栏的速记任务打开小窗并存进书库', async ({}, testInfo) => {
  const app = await launch(testInfo)
  const shortcutFile = ({ app }) => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const { join } = process.getBuiltinModule('node:path')
    try { return JSON.parse(readFileSync(join(app.getPath('appData'), 'NewWorld-capture.json'), 'utf8')).shortcut } catch { return null }
  }
  const registered = (shortcut) => app.evaluate(({ globalShortcut }, value) => globalShortcut.isRegistered(value), shortcut)
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    expect(await registered('Control+Alt+N')).toBe(true)

    const section = await openSettingsCategory(page, 'capture')
    const shortcut = section.getByRole('button', { name: /^全局快捷键 / })
    await expect(shortcut).toHaveText('Ctrl + Alt + N')
    await shortcut.click()
    for (const key of ['Space', 'Shift+A', 'Shift+1']) {
      await page.keyboard.press(key)
      await expect(section.getByRole('alert')).toContainText('只用 Shift 时，请搭配 F1–F24。')
      await expect(shortcut).toHaveAttribute('aria-pressed', 'true')
    }
    expect(await registered('Control+Alt+N')).toBe(true)
    await page.keyboard.press('Alt+Shift+N')
    await expect(shortcut).toHaveText('Alt + Shift + N')
    await expect.poll(() => registered('Alt+Shift+N')).toBe(true)
    expect(await registered('Control+Alt+N')).toBe(false)
    expect(await app.evaluate(shortcutFile)).toBe('Alt+Shift+N')
    const occupied = 'Control+Shift+F9'
    expect(await app.evaluate(({ globalShortcut }, value) => globalShortcut.register(value, () => {}), occupied)).toBe(true)
    try {
      await shortcut.click()
      await page.keyboard.press(occupied)
      await expect(section.getByRole('alert')).toHaveText('该组合键已被占用')
      await expect(shortcut).toHaveText('Alt + Shift + N')
      expect(await registered('Alt+Shift+N')).toBe(true)
      expect(await app.evaluate(shortcutFile)).toBe('Alt+Shift+N')
    } finally {
      await app.evaluate(({ globalShortcut }, value) => globalShortcut.unregister(value), occupied)
    }
    await section.getByRole('button', { name: '关闭快捷键' }).click()
    await expect.poll(() => registered('Alt+Shift+N')).toBe(false)
    // Leave the shared profile as it was for the other desktop tests.
    await section.getByRole('button', { name: '恢复默认' }).click()
    await expect.poll(() => registered('Control+Alt+N')).toBe(true)
    expect(await app.evaluate(shortcutFile)).toBe('Control+Alt+N')
    await page.locator('.settings-back').click()

    // The taskbar task starts New World again with --quick-note.
    const opened = app.waitForEvent('window')
    await app.evaluate(({ app }) => { app.emit('second-instance', {}, [process.execPath, '--quick-note'], process.cwd()) })
    const note = await opened
    const box = note.getByRole('textbox', { name: '灵感' })
    await expect(box).toBeVisible()
    await note.screenshot({ path: testInfo.outputPath('windows-quick-note.png') })
    await box.fill('桌面小窗记下的灵感')
    await box.press('Enter')
    await expect(note.getByRole('status')).toHaveText('已记下')
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().endsWith('#/capture'))?.isVisible())).toBe(false)

    await page.evaluate(() => { location.hash = '#/ideas' })
    await expect(page.getByRole('list', { name: '灵感列表' })).toContainText('桌面小窗记下的灵感')
  } finally { await stop(app) }
})

test('AI 接入与权限：桌面端启用本地接口、写入作品并在人工二次确认后才允许删除', async ({}, testInfo) => {
  const app = await launch(testInfo)
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    const section = await openSettingsCategory(page, 'ai')

    await expect(section.locator('.ai-badge').first()).toHaveText('已停用')
    await section.locator('input[data-ai-global-enable="true"]').check()
    await expect(section.locator('.ai-badge').first()).toContainText('本地监听 127.0.0.1:')
    const endpointText = await section.locator('.ai-endpoint-line').innerText()
    const portMatch = endpointText.match(/http:\/\/127\.0\.0\.1:(\d+)\/v1/)
    expect(portMatch).toBeTruthy()
    const baseUrl = `http://127.0.0.1:${portMatch[1]}/v1`

    await section.getByLabel('AI 配置名称').fill('DesktopAgent')
    await section.getByRole('button', { name: '添加 AI 配置' }).click()
    await expect(section.locator('.ai-token-banner')).toBeVisible()
    const token = (await section.locator('.ai-token-value').innerText()).trim()
    expect(token.startsWith('nw_ai_')).toBe(true)
    await section.getByRole('button', { name: '我已保存' }).click()

    const card = section.locator('.ai-client-card').filter({ hasText: 'DesktopAgent' })
    for (const perm of ['create', 'read', 'update', 'delete']) {
      await card.locator(`input[data-ai-perm="${perm}"]`).check()
    }
    await card.getByRole('radio', { name: '允许访问整个小说库' }).check()
    await page.locator('.settings-back').click()

    // Verify secret token is hashed cleanly on disk and never stored in plaintext
    const storedAiConfig = await app.evaluate(({ app }) => {
      const { readFileSync } = process.getBuiltinModule('node:fs')
      const { join } = process.getBuiltinModule('node:path')
      return readFileSync(join(app.getPath('appData'), 'NewWorld-ai.json'), 'utf8')
    })
    expect(storedAiConfig).not.toContain(token)
    expect(storedAiConfig).toContain('tokenHash')

    // Real HTTP call through Electron Main Process -> IPC -> Renderer IndexedDB business layer
    const createRes = await fetch(`${baseUrl}/works`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        library: 'original',
        title: '桌面 AI 联调作品',
        initialChapters: [{ title: '第一章', format: 'text', content: '桌面端主进程真实调用写入的正文。' }],
      }),
    })
    expect(createRes.status).toBe(201)
    const createdJson = await createRes.json()
    const workId = createdJson.data.work.id

    await page.evaluate(() => { location.hash = '#/original' })
    await expect(page.locator('.book-title', { hasText: '桌面 AI 联调作品' })).toBeVisible()

    // Delete requires manual human confirmation inside native Electron dialog
    const confirmDialog = page.getByRole('dialog', { name: '确认 AI 请求的操作' })
    const delPromise = fetch(`${baseUrl}/works/original/${workId}?wait=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    await expect(confirmDialog).toBeVisible()
    await expect(confirmDialog).toContainText('桌面 AI 联调作品')
    await confirmDialog.getByRole('button', { name: '本人确认执行' }).click()
    const delRes = await delPromise
    expect(delRes.status).toBe(200)
    await expect(page.locator('.book-title', { hasText: '桌面 AI 联调作品' })).toHaveCount(0)

    const auditText = await app.evaluate(({ app }) => {
      const { readFileSync } = process.getBuiltinModule('node:fs')
      const { join } = process.getBuiltinModule('node:path')
      return readFileSync(join(app.getPath('appData'), 'NewWorld-ai-audit.jsonl'), 'utf8')
    })
    expect(auditText).toContain('DesktopAgent')
    expect(auditText).toContain('works.delete')

    // Reset AI config so shared profile starts disabled again
    await openSettingsCategory(page, 'ai')
    await section.locator('.ai-client-card').filter({ hasText: 'DesktopAgent' }).getByRole('button', { name: '撤销配置' }).click()
    await page.getByRole('dialog', { name: /撤销配置/ }).getByRole('button', { name: '撤销配置' }).click()
    await expect(section.locator('.ai-client-card')).toHaveCount(0)
    await section.locator('input[data-ai-global-enable="true"]').uncheck()
    await expect(section.locator('.ai-badge').first()).toHaveText('已停用')
    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow()
  } finally { await stop(app) }
})

test('10. AI 历史版本与回收站保护：Windows 桌面端重启后仍可预览恢复历史正文与被删对象', async ({}, testInfo) => {
  let app = await launch(testInfo)
  try {
    let page = await app.firstWindow()
    await expect(page.getByRole('link', { name: '设置', exact: true })).toBeVisible()

    const section = await openSettingsCategory(page, 'ai')
    await section.locator('input[data-ai-global-enable="true"]').check()
    await expect(section.locator('.ai-badge').first()).toContainText('本地监听 127.0.0.1:')
    const portMatch = (await section.locator('.ai-endpoint-line').innerText()).match(/http:\/\/127\.0\.0\.1:(\d+)\/v1/)
    expect(portMatch).toBeTruthy()
    const baseUrl = `http://127.0.0.1:${portMatch[1]}/v1`

    await section.getByLabel('AI 配置名称').fill('RecoveryDesktopAI')
    await section.getByRole('button', { name: '添加 AI 配置' }).click()
    await expect(section.locator('.ai-token-banner')).toBeVisible()
    const token = (await section.locator('.ai-token-value').innerText()).trim()
    expect(token.startsWith('nw_ai_')).toBe(true)
    await section.getByRole('button', { name: '我已保存' }).click()

    const card = section.locator('.ai-client-card').filter({ hasText: 'RecoveryDesktopAI' })
    for (const perm of ['create', 'read', 'update', 'delete']) {
      await card.locator(`input[data-ai-perm="${perm}"]`).check()
      await expect(card.locator(`input[data-ai-perm="${perm}"]`)).toBeChecked()
    }
    await card.getByRole('radio', { name: '允许访问整个小说库' }).check()
    await expect(card.getByRole('radio', { name: '允许访问整个小说库' })).toBeChecked()
    await page.locator('.settings-back').click()

    const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    const v0 = '桌面初版正文：灯塔守夜人检查了雾笛开关。'
    const v1 = '桌面一版正文：灯塔守夜人检查并擦拭了雾笛开关。'
    const v2 = '桌面二版正文：灯塔守夜人检查并重启了雾笛开关。'

    const createRes = await fetch(`${baseUrl}/works`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        library: 'original',
        title: '桌面历史与回收站恢复检验作品',
        initialChapters: [
          { title: '第一章', format: 'text', content: v0 },
          { title: '将被删进回收站的章节', format: 'text', content: '桌面待删章正文，重启后必须从回收站找回。' },
        ],
      }),
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json()
    const workId = created.data.work.id
    const editionId = created.data.editions[0].id
    const edDetail = await (await fetch(`${baseUrl}/works/original/${workId}/editions/${editionId}`, { headers: { Authorization: `Bearer ${token}` } })).json()
    const ch1Id = edDetail.data.edition.chapters[0].id
    const ch2Id = edDetail.data.edition.chapters[1].id

    const ideaCreateRes = await fetch(`${baseUrl}/ideas`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ text: '桌面重启后恢复的灵感', work: { library: 'original', bookId: workId } }),
    })
    expect(ideaCreateRes.status).toBe(201)
    const ideaId = (await ideaCreateRes.json()).data.idea.id

    // Consecutive AI edits create distinct snapshots v0, v1
    expect((await fetch(`${baseUrl}/works/original/${workId}/editions/${editionId}/chapters/${ch1Id}`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ content: v1 }),
    })).status).toBe(200)
    expect((await fetch(`${baseUrl}/works/original/${workId}/editions/${editionId}/chapters/${ch1Id}`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ content: v2 }),
    })).status).toBe(200)

    // AI cannot access trash directly
    const trashRes = await fetch(`${baseUrl}/trash`, { headers: { Authorization: `Bearer ${token}` } })
    expect(trashRes.status).toBe(403)
    expect((await trashRes.json()).error.code).toBe('recovery_data_forbidden')

    // Confirmed deletes move chapter & idea into Trash
    const confirmDialog = page.getByRole('dialog', { name: '确认 AI 请求的操作' })
    const delChPromise = fetch(`${baseUrl}/works/original/${workId}/editions/${editionId}/chapters/${ch2Id}?wait=true`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    })
    await expect(confirmDialog).toBeVisible()
    await confirmDialog.getByRole('button', { name: '本人确认执行' }).click()
    expect((await delChPromise).status).toBe(200)

    const delIdeaPromise = fetch(`${baseUrl}/ideas/${ideaId}?wait=true`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    })
    await expect(confirmDialog).toBeVisible()
    await confirmDialog.getByRole('button', { name: '本人确认执行' }).click()
    expect((await delIdeaPromise).status).toBe(200)

    // Restart the Electron app cleanly to verify disk persistence of revisions & trash
    await stop(app)
    app = await launch(testInfo)
    page = await app.firstWindow()
    await expect(page.getByRole('link', { name: '设置', exact: true })).toBeVisible()

    // Open edition and restore v0 from History dialog (automatically backing up v2 first)
    await page.evaluate((u) => { location.hash = u }, `#/original/${workId}/${editionId}`)
    await expect(editor(page)).toHaveText(v2)
    await expect.poll(() => historyCount(page)).toBe('2')
    await editorAction(page, '历史版本')
    const revDialog = page.getByRole('dialog', { name: /历史版本/ })
    await expect(revDialog).toBeVisible()
    await revDialog.locator('button.revision-item').nth(1).click()
    await expect(revDialog.locator('.revision-preview-text')).toHaveText(v0)
    await revDialog.getByRole('button', { name: '恢复此版本' }).click()
    await expect(editor(page)).toHaveText(v0)
    await expect.poll(() => historyCount(page)).toBe('3')

    // Open Trash UI and restore both the deleted chapter and idea across restart
    await page.evaluate(() => { location.hash = '#/trash' })
    const trashList = page.getByRole('list', { name: '回收站内容' })
    await expect(trashList).toContainText('将被删进回收站的章节')
    await expect(trashList).toContainText('桌面重启后恢复的灵感')
    const chRow = trashList.locator('.trash-row').filter({ has: page.locator('.book-title', { hasText: '将被删进回收站的章节' }) })
    await chRow.getByRole('button', { name: '恢复' }).click()
    await expect(chRow).toHaveCount(0)
    const ideaRow = trashList.locator('.trash-row').filter({ has: page.locator('.book-title', { hasText: '桌面重启后恢复的灵感' }) })
    await ideaRow.getByRole('button', { name: '恢复' }).click()
    await expect(ideaRow).toHaveCount(0)

    await page.evaluate((u) => { location.hash = u }, `#/original/${workId}/${editionId}`)
    await expect(page.locator('.chapter-list')).toContainText('将被删进回收站的章节')
    await page.evaluate(() => { location.hash = '#/ideas' })
    await expect(page.getByRole('list', { name: '灵感列表' })).toContainText('桌面重启后恢复的灵感')

    // Clean up AI config so profile returns to default disabled state
    const resetSection = await openSettingsCategory(page, 'ai')
    await resetSection.locator('.ai-client-card').filter({ hasText: 'RecoveryDesktopAI' }).getByRole('button', { name: '撤销配置' }).click()
    await page.getByRole('dialog', { name: /撤销配置/ }).getByRole('button', { name: '撤销配置' }).click()
    await resetSection.locator('input[data-ai-global-enable="true"]').uncheck()
    await expect(resetSection.locator('.ai-badge').first()).toHaveText('已停用')
  } finally { await stop(app) }
})


test('.newworld 冷启动导入、中文路径导出与系统关联热打开保护正在编辑的稿件', async ({}, testInfo) => {
  let app = await launch(testInfo, [resolve('docs/examples/雾港.newworld')])
  try {
    const page = await app.firstWindow()
    const output = testInfo.outputPath('中文 ✦ 完整工程.newworld')
    const url = await projectDesktopFlow({ app, page, output, openThroughOS: async (path) => {
      if (installedApp) {
        const { stdout } = await setup('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "(Get-Item 'HKCU:\\Software\\Classes\\.newworld').GetValue('')"])
        expect(stdout.trim()).toBeTruthy()
        await setup('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:NEW_WORLD_PROJECT_FILE'], {
          env: { ...process.env, NEW_WORLD_PROJECT_FILE: path }, timeout: 20_000,
        })
      } else {
        await app.evaluate(({ app }, path) => { app.emit('second-instance', {}, [process.execPath, path], process.cwd()) }, path)
      }
    } })
    await stop(app)
    app = await launch(testInfo)
    const reopened = await app.firstWindow()
    await reopened.goto(url)
    await expectDesktopWorkInformation(reopened)
    await expect(editor(reopened)).toHaveText('文件关联打开时仍在编辑的正文。')
  } finally { await stop(app) }
})


if (process.platform === 'win32') test('Windows 登录项控制注册表，后台登录只显示速记，普通启动唤回主窗口', async ({}, info) => {
  const app = await launch(info, ['--background-login'])
  try {
    const page = await app.firstWindow()
    await expect(page.locator('#app-version')).toHaveText(versionTag)
    const mainVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((window) => !window.webContents.getURL().endsWith('#/capture')).isVisible())
    expect(await mainVisible()).toBe(false)
    expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+N'))).toBe(true)
    const opened = app.waitForEvent('window')
    await app.evaluate(({ app }) => app.emit('second-instance', {}, [process.execPath, '--quick-note'], process.cwd()))
    const capture = await opened
    await expect(capture.locator('.capture-text')).toBeFocused()
    await capture.keyboard.press('Tab')
    await capture.locator('.capture-task-title').fill('后台登录后记下的提醒')
    await capture.locator('.capture-task-title').press('Enter')
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().endsWith('#/capture')).isVisible())).toBe(false)
    expect(await mainVisible()).toBe(false)
    await app.evaluate(({ app }) => app.emit('second-instance', {}, [process.execPath], process.cwd()))
    await expect.poll(mainVisible).toBe(true)
    await page.evaluate(() => { location.hash = '#/notes/tasks' })
    await page.locator('.task-nav a[href="#/notes/tasks/later"]').click()
    await expect(page.getByRole('button', { name: '后台登录后记下的提醒', exact: true }).first()).toBeVisible()

    const general = await openSettingsCategory(page, 'general')
    const toggle = general.getByRole('switch')
    await expect(toggle).toBeEnabled()
    await expect(toggle).not.toBeChecked()
    const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    await toggle.check()
    const registered = () => setup('reg.exe', ['query', runKey, '/v', 'NewWorldBackground']).then(({ stdout }) => stdout, () => '')
    await expect.poll(registered).toContain('--background-login')
    await toggle.uncheck()
    await expect.poll(registered).toBe('')
    if (uninstaller) {
      await toggle.check()
      await expect.poll(registered).toContain('--background-login')
    }
  } finally { await stop(app) }
})

test('网页块永远无痕：安装版关闭网页块后读不到 Cookie，配置目录里没有这个会话的文件', async ({}, testInfo) => {
  const app = await launch(testInfo)
  try {
    const page = await app.firstWindow()
    await privateWebSmoke(app, page, startWork)
  } finally { await stop(app) }
})

test('Windows 故事设定独立窗口可重开，编辑器与设定实时同步', async ({}, info) => {
  const app = await launch(info)
  try {
    await desktopStorySettingsFlow(app, await app.firstWindow(), 'Windows 故事设定验收')
  } finally { await stop(app) }
})

test('Windows AI 对话走主进程流式请求，能点选并在重开后保留', async ({}, info) => {
  await desktopBookChatFlow(() => launch(info), stop, 'Windows AI 对话验收')
})

test('Windows 设定窗口通过主进程提取与检查并定位主窗口正文', async ({}, info) => {
  await desktopStoryAiFlow(() => launch(info), stop, 'Windows 设定检查验收')
})
