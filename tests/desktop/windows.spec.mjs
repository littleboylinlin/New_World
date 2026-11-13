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
import { checkNativeHeader } from '../header-layout.mjs'

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

async function runSetup(path, directory = '') {
  const { stdout } = await setup('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$params = '/S'; if ($env:NEW_WORLD_SETUP_DIR) { $params += ' /D=' + $env:NEW_WORLD_SETUP_DIR }; $process = Start-Process -FilePath $env:NEW_WORLD_SETUP_FILE -ArgumentList $params -PassThru -Wait; Write-Output $process.ExitCode"], {
    env: { ...process.env, NEW_WORLD_SETUP_FILE: resolve(path), NEW_WORLD_SETUP_DIR: directory }, timeout: 90_000,
  })
  return Number(stdout.trim())
}

async function launch(testInfo) {
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
  args.push('--proxy-server=http://127.0.0.1:1', '--disable-gpu')
  if (process.platform === 'linux' && !process.env.DISPLAY) args.push('--ozone-platform=headless')
  return electron.launch({ executablePath: installedApp || undefined, args, env: { ...process.env, XDG_CONFIG_HOME: profile } })
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
    if (installer) {
      await expect.poll(() => stat(join(process.env.APPDATA, 'NewWorld-languages', 'packs', '0.0.0')).then(() => true, () => false)).toBe(false)
      await expect.poll(() => readFile(join(process.env.APPDATA, 'NewWorld', 'NewWorld-cache-version'), 'utf8').catch(() => '')).toBe(version)
      await expect.poll(() => stat(join(tmpdir(), 'New World Updates', 'download-aB123C')).then(() => true, () => false)).toBe(false)
    }
    await expect(page).toHaveURL('new-world://app/')
    await expect(page.locator('#update-banner')).toBeHidden()
    expect(await page.evaluate(() => ({ secure: isSecureContext, node: typeof require }))).toEqual({ secure: true, node: 'undefined' })
    // The app header replaces the system title bar and leaves room for the window buttons.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible())).toBe(false)
    const header = await page.evaluate(() => {
      const inner = document.querySelector('.header-inner')
      const settings = document.querySelector('#settings').getBoundingClientRect()
      return { top: inner.getBoundingClientRect().top, reserved: parseFloat(getComputedStyle(inner).paddingRight), gap: innerWidth - settings.right }
    })
    expect(header.top).toBe(0)
    expect(header.reserved).toBeGreaterThan(90)
    expect(header.gap).toBeGreaterThan(90)
    await page.screenshot({ path: testInfo.outputPath('windows-home.png') })
    await checkNativeHeader(app, page, testInfo, 'windows')
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
    network.fetch = async (url) => {
      globalThis.testUpdateRequests.push(url)
      if (url === fixture.metadata) return Response.json(fixture.release)
      if (url !== fixture.download) return new Response(null, { status: 404 })
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
    }
  }, { metadata, download, release, filePath, body })
  return [metadata, download]
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
    await page.getByRole('button', { name: '设置' }).click()
    const help = page.getByRole('dialog', { name: '设置' })
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
    await expect(help.locator('.update-state')).toContainText('请求限额')
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
    await page.getByRole('button', { name: '设置' }).click()
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
    await page.getByRole('button', { name: '设置' }).click()
    const help = page.getByRole('dialog', { name: '设置' })
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
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
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
    await page.getByRole('button', { name: '设置', exact: true }).click()
    let settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('combobox', { name: '语言', exact: true }).selectOption('en')
    await settings.getByRole('button', { name: '应用语言' }).click()
    await expect.poll(() => app.evaluate(({ app }) => {
      const { readFileSync } = process.getBuiltinModule('node:fs')
      const { join } = process.getBuiltinModule('node:path')
      return JSON.parse(readFileSync(join(app.getPath('appData'), 'NewWorld-languages', 'language.json'), 'utf8')).locale
    })).toBe('en')
    settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((item) => item.label))).toEqual(['Edit', 'View'])
    if (installer) {
      expect(await app.evaluate(() => globalThis.testLanguageRequests)).toEqual([
        `${releaseBase}/download/v${version}/New-World-lang-en.json`,
      ])
    }
    await page.screenshot({ path: testInfo.outputPath('windows-english-settings.png') })
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await checkNativeHeader(app, page, testInfo, 'windows')
    await stop(app)
    app = await launch(testInfo)
    page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'My novel library' })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('en')
    await settings.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN')
    await settings.getByRole('button', { name: 'Apply language' }).click()
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()
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
    await page.getByRole('button', { name: '设置', exact: true }).click()
    let section = page.getByRole('dialog', { name: '设置' }).getByRole('region', { name: '外观', exact: true })
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
    await page.getByRole('button', { name: '设置', exact: true }).click()
    section = page.getByRole('dialog', { name: '设置' }).getByRole('region', { name: '外观', exact: true })
    await section.getByRole('radio', { name: /跟随系统/ }).check()
    await expect.poll(() => app.evaluate(themeFile)).toBe('system')
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
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

    await page.locator('a[href="#/original"]').first().click()
    await page.getByRole('button', { name: '新建小说' }).click()
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
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const section = page.getByRole('dialog', { name: '设置' }).getByRole('region', { name: '外观', exact: true })
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

    await page.locator('a[href="#/original"]').first().click()
    await page.getByRole('button', { name: '新建小说' }).click()
    await page.getByRole('textbox', { name: '作品名' }).fill('备份的灯塔')
    await page.getByRole('button', { name: '创建小说' }).click()
    await editor(page).fill('守夜人把灯点亮。')
    await page.getByRole('button', { name: '手动保存' }).click()
    await expect(page.locator('.save-status')).toHaveText('已保存')

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const section = page.getByRole('dialog', { name: '设置' }).getByRole('region', { name: '备份', exact: true })
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
    await expect(section.locator('.backup-state')).toContainText('已备份 1 部作品到')
    const manual = (await backups()).find((name) => name.startsWith('New-World-backup-'))
    expect(manual).toBeTruthy()
    expect((await readFile(join(folder, manual)))[6] & 1).toBe(1)

    // The first automatic backup is due right away and runs shortly after the start.
    await expect(section.locator('.backup-last')).toContainText('上次自动备份', { timeout: 60_000 })

    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    await editor(page).fill('恢复前改过的正文。')
    await page.getByRole('button', { name: '手动保存' }).click()
    await expect(page.locator('.save-status')).toHaveText('已保存')

    await app.evaluate((_electron, path) => { globalThis.testRestorePath = path }, join(folder, manual))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await section.getByRole('button', { name: '从备份恢复…' }).click()
    const password = page.getByRole('dialog', { name: '输入备份密码' })
    await password.getByLabel('密码', { exact: true }).fill('harbour')
    await password.getByRole('button', { name: '打开' }).click()
    await page.getByRole('dialog', { name: '从备份恢复' }).getByRole('button', { name: '替换当前书库' }).click()
    await expect(page.getByText('已从备份恢复 1 部作品。')).toBeVisible()
    expect((await backups()).some((name) => name.startsWith('New-World-before-restore-'))).toBe(true)
    await page.locator('a[href="#/original"]').first().click()
    await page.getByRole('link', { name: '查看 备份的灯塔', exact: true }).click()
    await expect(editor(page)).toHaveText('守夜人把灯点亮。')

    // Leave the shared profile as it was for the other desktop tests.
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await section.getByRole('radio', { name: '不加密' }).check()
    await expect(section.locator('.backup-state')).toHaveText('之后的备份不加密。')
    await section.getByRole('button', { name: '恢复默认位置' }).click()
    await expect(section.locator('.backup-location')).toContainText('默认位置')
  } finally { await stop(app) }
})
