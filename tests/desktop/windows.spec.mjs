import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test } from '@playwright/test'
import { createPackage, extractAll } from '@electron/asar'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { file } from '../fixtures.mjs'

const { version } = JSON.parse(await readFile('package.json', 'utf-8'))
const versionTag = `v${version}`
const releaseBase = 'https://github.com/littleboylinlin/New_World/releases'
const releaseList = 'https://api.github.com/repos/littleboylinlin/New_World/releases?per_page=100'
const releaseTags = 'https://api.github.com/repos/littleboylinlin/New_World/releases/tags/'
const installer = process.env.NEW_WORLD_INSTALLER
const installDir = installer && (process.env.NEW_WORLD_INSTALL_DIR || join(process.env.LOCALAPPDATA, 'Programs', 'New World'))
const installedApp = installDir && join(installDir, 'New World.exe')
const uninstaller = installDir && join(installDir, 'Uninstall New World.exe')
const setup = promisify(execFile)
const editor = (page) => page.getByRole('textbox', { name: '章节正文' })
const status = (page) => page.locator('.save-status')

async function runSetup(path) {
  const { stdout } = await setup('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$process = Start-Process -FilePath $env:NEW_WORLD_SETUP_FILE -ArgumentList '/S' -PassThru -Wait; Write-Output $process.ExitCode"], {
    env: { ...process.env, NEW_WORLD_SETUP_FILE: resolve(path) }, timeout: 90_000,
  })
  return Number(stdout.trim())
}

async function launch(testInfo) {
  const profile = testInfo.outputPath('profile')
  await mkdir(profile, { recursive: true })
  const args = installedApp ? [] : ['.']
  // Keep normal startup offline. Version tests serve controlled responses via Chromium.
  args.push('--proxy-server=http://127.0.0.1:1', '--disable-gpu')
  if (process.platform === 'linux' && !process.env.DISPLAY) args.push('--ozone-platform=headless')
  return electron.launch({ executablePath: installedApp || undefined, args, env: { ...process.env, XDG_CONFIG_HOME: profile } })
}

async function install() {
  expect(await runSetup(installer)).toBe(0)
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
  await page.getByRole('button', { name: '导出', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '导出编辑稿' })
  await dialog.getByRole('radio', { name: exportLabels[format] }).check()
  await dialog.getByRole('button', { name: '开始导出' }).click()
  await expect(dialog).toBeHidden()
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
  if (installer) await install()
})

test.afterAll(async () => {
  if (!uninstaller || !await stat(uninstaller).catch(() => false)) return
  expect(await runSetup(uninstaller)).toBe(0)
  await expect(stat(installedApp)).rejects.toHaveProperty('code', 'ENOENT')
  expect((await stat(join(process.env.APPDATA, 'NewWorld', 'IndexedDB'))).isDirectory()).toBe(true)
})

test('桌面离线打开、读写和导出，关闭及重新安装后保留原文和续写', async ({}, testInfo) => {
  const original = file('桌面续写原文.txt', '路旁亮着一盏灯。')
  const savedText = '第一卷正文。Windows desktop export.'
  let app = await launch(testInfo)
  try {
    let page = await app.firstWindow()
    await expect(page.locator('#app-version')).toHaveText(versionTag)
    await expect(page).toHaveURL('new-world://app/')
    await expect(page.locator('#update-banner')).toBeHidden()
    expect(await page.evaluate(() => ({ secure: isSecureContext, node: typeof require }))).toEqual({ secure: true, node: 'undefined' })
    await page.locator('a[href="#/reference"]').first().click()
    await page.locator('input[type=file]').setInputFiles(original)
    await page.getByRole('link', { name: '查看 桌面续写原文', exact: true }).click()
    const projectUrl = page.url()
    await page.getByRole('button', { name: '新建续写' }).click()
    await page.getByRole('textbox', { name: '续写名称' }).fill('到达港口')
    await page.getByRole('button', { name: '开始续写' }).click()
    await editor(page).fill('这段先保存。')
    const draftUrl = page.url()
    await expect(status(page)).toHaveText('已保存')
    const pdfPath = testInfo.outputPath('稿件.pdf')
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, pdfPath)
    await editor(page).fill(savedText)
    await exportTo(page, 'pdf')
    const exportedPdf = await readFile(pdfPath)
    expect(exportedPdf.subarray(0, 5).toString()).toBe('%PDF-')
    await expectCleanPdf(exportedPdf, savedText)
    await expect(page.locator('.print-edition')).toHaveCount(0)

    if (installer) {
      expect(await runSetup(installer)).toBe(2)
      await expect(editor(page)).toHaveText(savedText)
    }

    // No manual save and no wait for the autosave debounce before closing.
    const lastText = `${savedText} 保存后再关窗。`
    await editor(page).fill(lastText)
    const exited = app.waitForEvent('close')
    await app.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 30) })
    await exited
    if (installer) await install()

    app = await launch(testInfo)
    page = await app.firstWindow()
    await page.goto(draftUrl)
    await expect(editor(page)).toHaveText(lastText)
    await page.goto(projectUrl)
    await page.getByRole('link', { name: '查看原文 桌面续写原文' }).click()
    await expect(page.getByRole('article')).toHaveText(original.buffer.toString())

    const originalPath = testInfo.outputPath(original.name)
    await app.evaluate(({ session }, savePath) => {
      session.defaultSession.once('will-download', (_event, item) => item.setSavePath(savePath))
    }, originalPath)
    await page.getByRole('button', { name: '下载原文件' }).click()
    await expect.poll(async () => readFile(originalPath).catch(() => null)).toEqual(original.buffer)

    await page.getByRole('link', { name: 'New World 书库首页' }).click()
    await page.getByRole('link', { name: '进入原创库' }).click()
    await expect(page.getByRole('link', { name: '查看 桌面续写原文', exact: true })).toHaveCount(0)
    await page.locator('input[type=file]').setInputFiles(file('桌面 PDF.pdf', exportedPdf))
    await page.getByRole('link', { name: '查看 桌面 PDF', exact: true }).click()
    const canvas = page.getByRole('img', { name: 'PDF 第 1 页' })
    await expect(canvas).toBeVisible()
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

const mockCdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/new-world-test'

async function mockUpdateDownload(app, release, { filePath, body }) {
  const metadata = releaseTags + release.tag_name
  const download = release.assets[0].browser_download_url
  await app.evaluate(({ session }, fixture) => {
    const { createReadStream } = process.getBuiltinModule('node:fs')
    const { Readable } = process.getBuiltinModule('node:stream')
    const network = session.fromPartition('new-world-update')
    globalThis.testUpdateRequests = []
    const gate = Promise.withResolvers()
    globalThis.testContinueUpdate = gate.resolve
    network.protocol.handle('https', ({ url }) => {
      globalThis.testUpdateRequests.push(url)
      if (url === fixture.metadata) return Response.json(fixture.release)
      if (url === fixture.download) return Response.redirect(fixture.cdn)
      if (url !== fixture.cdn) return new Response(null, { status: 404 })
      if (!fixture.filePath) return new Response(fixture.body)
      const reader = Readable.toWeb(createReadStream(fixture.filePath)).getReader()
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
      }))
    })
  }, { metadata, download, cdn: mockCdn, release, filePath, body })
  return [metadata, download, mockCdn]
}

test('启动检查 Windows 正式安装包，支持失败重试并保护未保存的稿件', async ({}, testInfo) => {
  const app = await launch(testInfo)
  try {
    const page = await app.firstWindow()
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
    await page.getByRole('button', { name: '帮助与更新' }).click()
    const help = page.getByRole('dialog', { name: '帮助与更新' })
    await expect(help).toContainText(`当前运行版本 ${versionTag} · Windows x64`)
    await expect(help).toContainText('改进离线写作。')
    await expect(help.getByRole('link', { name: '查看 GitHub 发布页' })).toHaveAttribute('href', `${releaseBase}/tag/${next}`)
    await expect(help.getByRole('button', { name: '重新加载当前网页' })).toHaveCount(0)
    const check = help.getByRole('button', { name: '检查更新' })
    result = [stable(future, { assets: [] }), stable(versionTag)]
    await check.click()
    await expect(help.getByRole('status')).toHaveText('当前已是最新版本。')
    responseStatus = 0
    await check.click()
    await expect(help.getByRole('status')).toContainText('无法连接 GitHub')
    responseStatus = 429
    await check.click()
    await expect(help.getByRole('status')).toContainText('请求限额')
    responseStatus = 200
    result = { unexpected: true }
    await check.click()
    await expect(help.getByRole('status')).toContainText('版本信息不完整或格式异常')
    result = [stable(future, { assets: [] }), foreign, noDigest]
    await check.click()
    await expect(help.getByRole('status')).toContainText('暂未提供可校验的 Windows x64 正式安装包')
    result = [stable(next)]
    await check.click()
    await expect(help.getByRole('status')).toContainText(next)
    expect(requests).toBe(7)
    await help.getByRole('button', { name: '关闭', exact: true }).click()

    await page.locator('a[href="#/original"]').first().click()
    await page.getByRole('button', { name: '新建小说' }).click()
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
    await page.getByRole('button', { name: '帮助与更新' }).click()
    const download = help.getByRole('button', { name: '更新并重启' })
    await download.click()
    await expect(help.getByRole('alert')).toContainText('当前正文尚未保存')
    expect(await app.evaluate(() => globalThis.testExternalLinks)).toEqual([])
    expect(await app.evaluate(() => globalThis.testUpdateRequests)).toEqual([])
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect(status(page)).toHaveText('未保存 · 失败')
    await page.evaluate(() => { globalThis.desktopTestStorageFull = false })
    await download.click()
    await expect(help.getByRole('alert')).toContainText(installer ? 'SHA-256 校验不匹配' : '适用于已安装的 Windows x64 正式版')
    expect(await app.evaluate(() => globalThis.testUpdateRequests)).toEqual(installer ? expectedRequests : [])
    expect(await app.evaluate(() => globalThis.testExternalLinks)).toEqual([])
    await expect(page).toHaveURL(draftUrl)
    await expect(status(page)).toHaveText('已保存')
    const invalid = await page.evaluate(() => window.newWorldDesktop.downloadUpdate('https://example.invalid/'))
    expect(invalid.ok).toBe(false)
    expect(await app.evaluate(() => globalThis.testUpdateRequests)).toEqual(installer ? expectedRequests : [])
    await page.screenshot({ path: testInfo.outputPath('windows-updates.png') })
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
  const [bundle] = (await readdir(assets)).filter((name) => /^index-[\w-]+\.js$/.test(name))
  const path = join(assets, bundle)
  const renderer = await readFile(path, 'utf-8')
  expect(renderer).toContain(version)
  await writeFile(path, renderer.replaceAll(version, previous))
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

  let app = await launch(testInfo)
  let restarted = 0
  try {
    const priorPid = app.process().pid
    const page = await app.firstWindow()
    expect(await app.evaluate(({ app }) => app.getVersion())).toBe(previous)
    const requests = await mockUpdateDownload(app, release, { filePath: installer })
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
    await page.locator('a[href="#/original"]').first().click()
    await page.getByRole('button', { name: '新建小说' }).click()
    await page.getByRole('textbox', { name: '作品名' }).fill('应用内更新前的稿件')
    await page.getByRole('button', { name: '创建小说' }).click()
    await editor(page).fill('更新前已写好的正文。')
    await expect(status(page)).toHaveText('已保存')
    const draftUrl = page.url()
    await page.getByRole('button', { name: '帮助与更新' }).click()
    const help = page.getByRole('dialog', { name: '帮助与更新' })
    const update = help.getByRole('button', { name: '更新并重启' })
    await update.click()
    const progress = help.getByRole('progressbar', { name: '安装包下载进度' })
    await expect.poll(() => progress.evaluate((bar) => bar.value)).toBeGreaterThan(0)
    await page.screenshot({ path: testInfo.outputPath('windows-update-download.png') })
    await help.getByRole('button', { name: '关闭', exact: true }).click()
    const lastText = '下载期间新增的正文也要保留。'
    await page.evaluate(() => { globalThis.desktopTestStorageFull = true })
    await editor(page).fill(lastText)
    await app.evaluate(() => globalThis.testContinueUpdate())
    await expect(help.getByRole('alert')).toContainText('安装包已下载', { timeout: 30_000 })
    expect(await app.evaluate(() => globalThis.testUpdateRequests)).toEqual(requests)
    await expect(page.locator('.novel-body')).toHaveText(lastText)
    await page.evaluate(() => { globalThis.desktopTestStorageFull = false })
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
    await expect(current.locator('#app-version')).toHaveText(versionTag)
    await current.goto(draftUrl)
    await expect(editor(current)).toHaveText(lastText)
  } finally {
    if (app) await stop(app)
    if (restarted) await closeRestarted(restarted).catch(() => {})
  }
})
