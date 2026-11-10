import { execFile } from 'node:child_process'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test } from '@playwright/test'
import { file, pdf } from '../fixtures.mjs'

const { version } = JSON.parse(await readFile('package.json', 'utf-8'))
const versionTag = `v${version}`
const releaseBase = 'https://github.com/littleboylinlin/New_World/releases'
const releaseList = 'https://api.github.com/repos/littleboylinlin/New_World/releases?per_page=100'
const installer = process.env.NEW_WORLD_INSTALLER
const installDir = installer && join(process.env.LOCALAPPDATA, 'Programs', 'new-world')
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
  await app.evaluate(({ app }) => { setTimeout(() => app.exit(), 0) }).catch(() => {})
  await app.close().catch(() => {})
}

async function exportTo(page, format) {
  await page.getByRole('button', { name: '导出编辑稿' }).click()
  const dialog = page.getByRole('dialog', { name: '导出编辑稿' })
  await dialog.getByRole('combobox', { name: '导出格式' }).selectOption(format)
  await dialog.getByRole('button', { name: '开始导出' }).click()
  await expect(dialog).toBeHidden()
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
    expect((await readFile(pdfPath)).subarray(0, 5).toString()).toBe('%PDF-')
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

    await page.locator('a[href="#/original"]').first().click()
    await expect(page.getByRole('link', { name: '查看 桌面续写原文', exact: true })).toHaveCount(0)
    await page.locator('input[type=file]').setInputFiles(file('桌面 PDF.pdf', pdf()))
    await page.getByRole('link', { name: '查看 桌面 PDF', exact: true }).click()
    await expect(page.getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('windows-reader.png') })
  } finally {
    await stop(app)
  }
})

function stable(tag, fields = {}) {
  const name = `New-World-Setup-${tag.slice(1)}-x64.exe`
  return {
    tag_name: tag, draft: false, prerelease: false, body: '改进离线写作。',
    assets: [{ name, size: 1, state: 'uploaded', browser_download_url: `${releaseBase}/download/${tag}/${name}` }],
    ...fields,
  }
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
    let result = [stable(older), stable(next), stable(future, { assets: [] }), stable(`${future}-rc.1`, { prerelease: true }), stable(future, { draft: true }), foreign]
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
    result = [stable(future, { assets: [] }), foreign]
    await check.click()
    await expect(help.getByRole('status')).toContainText('暂未提供 Windows x64 正式安装包')
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
    await page.evaluate(() => { globalThis.desktopTestStorageFull = true })
    await editor(page).fill('这段正文必须留在桌面端。')
    await page.getByRole('button', { name: '帮助与更新' }).click()
    const download = help.getByRole('button', { name: '下载 Windows x64 安装包' })
    await download.click()
    await expect(help.getByRole('alert')).toContainText('当前正文尚未保存')
    expect(await app.evaluate(() => globalThis.testExternalLinks)).toEqual([])
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect(status(page)).toHaveText('未保存 · 失败')
    await page.evaluate(() => { globalThis.desktopTestStorageFull = false })
    await download.click()
    await expect.poll(() => app.evaluate(() => globalThis.testExternalLinks)).toEqual([
      `${releaseBase}/download/${next}/New-World-Setup-${next.slice(1)}-x64.exe`,
    ])
    await expect(page).toHaveURL(draftUrl)
    await expect(status(page)).toHaveText('已保存')
    await expect(page.evaluate(() => window.newWorldDesktop.openInstaller('https://example.invalid/'))).rejects.toThrow('无效的 Windows 安装包地址')
    await page.screenshot({ path: testInfo.outputPath('windows-updates.png') })
  } finally {
    await stop(app)
  }
})
