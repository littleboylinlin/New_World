import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test } from '@playwright/test'

const command = promisify(execFile)
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const manifest = JSON.parse(await readFile('public/locales/manifest.json', 'utf8'))
const arch = process.arch
const base = 'https://github.com/littleboylinlin/New_World/releases'
const list = 'https://api.github.com/repos/littleboylinlin/New_World/releases?per_page=100'
const profile = join(homedir(), 'Library', 'Application Support', 'NewWorld')
const languages = join(homedir(), 'Library', 'Application Support', 'NewWorld-languages')
let directory, bundle, executable

test.skip(process.platform !== 'darwin', 'Requires macOS')

async function installDmg() {
  const mount = join(directory, 'mounted')
  await mkdir(mount, { recursive: true })
  const dmg = resolve(`dist-macos/New-World-${version}-macos-${arch}.dmg`)
  await command('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg])
  try {
    await command('ditto', [join(mount, 'New World.app'), bundle])
  } finally { await command('hdiutil', ['detach', mount]) }
}

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'new-world-macos-'))
  bundle = join(directory, 'installed', 'New World.app')
  await installDmg()
  await command('codesign', ['--verify', '--deep', '--strict', bundle])
  executable = join(bundle, 'Contents', 'MacOS', 'New World')
  expect((await stat(executable)).isFile()).toBe(true)
  const cache = join(languages, 'packs', manifest.version)
  await mkdir(cache, { recursive: true })
  await cp('public/locales/New-World-lang-zh-CN.json', join(cache, 'zh-CN.json'))
  await writeFile(join(languages, 'language.json'), JSON.stringify({ locale: 'zh-CN' }))
})

test.afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

async function launch() {
  const app = await electron.launch({ executablePath: executable, args: ['--proxy-server=http://127.0.0.1:1', '--disable-gpu'] })
  const page = await app.firstWindow()
  page.setDefaultNavigationTimeout(30_000)
  await page.waitForLoadState('load')
  await expect(page.locator('#app-version')).toHaveText('v' + version)
  return app
}

async function stop(app) {
  if (!app) return
  const exited = app.waitForEvent('close', { timeout: 10_000 })
  void app.evaluate(({ app }) => { setTimeout(() => app.exit(), 0) }).catch(() => {})
  await exited.catch(() => app.process().kill('SIGKILL'))
  await app.close().catch(() => {})
}

const editor = (page) => page.getByRole('textbox', { name: '章节正文', exact: true })

test('从 DMG 安装后原生打开，标题栏、Command 保存、PDF 导出和重开恢复正常', async ({}, info) => {
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await expect(page.locator('#app-version')).toHaveText('v' + version)
    expect(await page.evaluate(() => ({ platform: window.newWorldDesktop.platform, arch: window.newWorldDesktop.arch }))).toEqual({ platform: 'darwin', arch })
    await expect(page.locator('html')).toHaveClass(/macos/)
    const left = await page.locator('.brand').evaluate((node) => node.getBoundingClientRect().left)
    expect(left).toBeGreaterThanOrEqual(80)
    const status = await page.locator('.local-label').boundingBox()
    const trash = await page.locator('#trash-link').boundingBox()
    expect(status.x + status.width).toBeLessThanOrEqual(trash.x)
    await page.screenshot({ path: info.outputPath('macos-home.png'), animations: 'disabled' })
    await page.getByRole('link', { name: '进入原创库', exact: true }).click()
    await page.getByRole('button', { name: '新建小说', exact: true }).click()
    await page.getByRole('textbox', { name: '作品名' }).fill('Mac 上的小说')
    await page.getByRole('button', { name: '创建小说' }).click()
    await editor(page).fill('A manuscript saved on macOS. 中文正文。')
    await page.keyboard.press('Meta+s')
    await expect(page.locator('.save-status')).toHaveText('已保存')
    const url = page.url()
    const pdf = info.outputPath('macos-manuscript.pdf')
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, pdf)
    await page.getByRole('button', { name: '导出', exact: true }).click()
    const exportDialog = page.getByRole('dialog', { name: '导出编辑稿' })
    await exportDialog.getByRole('radio', { name: 'PDF', exact: true }).check()
    await exportDialog.getByRole('button', { name: '开始导出' }).click()
    await expect(exportDialog).toBeHidden({ timeout: 30_000 })
    expect((await readFile(pdf)).subarray(0, 5).toString()).toBe('%PDF-')
    await stop(app)
    await installDmg()
    app = await launch()
    page = await app.firstWindow()
    await page.goto(url)
    await expect(editor(page)).toHaveText('A manuscript saved on macOS. 中文正文。')
    expect((await stat(join(profile, 'IndexedDB'))).isDirectory()).toBe(true)
  } finally { await stop(app) }
})

test('Mac 应用菜单可打开设置，语言切换和后台关闭后可恢复', async ({}, info) => {
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    const prefs = await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu().items[0].submenu.items.find((item) => item.label === '设置')
      item.click()
      return item.accelerator
    })
    expect(prefs).toBe('Cmd+,')
    let settings = page.getByRole('dialog', { name: '设置' })
    await expect(settings).toBeVisible()
    await settings.getByRole('radio', { name: '留后台', exact: true }).check()
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
    await app.evaluate(({ app }) => app.emit('activate'))
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await settings.getByRole('radio', { name: '完全退出', exact: true }).check()
    const english = await readFile('public/locales/New-World-lang-en.json', 'utf8')
    await app.evaluate(({ session }, body) => {
      session.fromPartition('new-world-language-packs').fetch = async () => new Response(body)
    }, english)
    await settings.getByRole('combobox', { name: '语言', exact: true }).selectOption('en')
    await settings.getByRole('button', { name: '应用语言', exact: true }).click()
    settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings).toBeVisible()
    await expect(settings).toContainText('macOS ' + (arch === 'arm64' ? 'Apple Silicon' : 'Intel'))
    await page.screenshot({ path: info.outputPath('macos-english-settings.png'), animations: 'disabled' })
    await stop(app)
    app = await launch()
    page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'My novel library' })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN')
    await settings.getByRole('button', { name: 'Apply language', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()
  } finally { await stop(app) }
})

test('Mac 更新下载只用本机 DMG，校验失败不覆盖文件，校验成功后保存并打开安装包', async ({}, info) => {
  const app = await launch()
  let exited = false
  try {
    const page = await app.firstWindow()
    const [major, minor] = version.split('.').map(Number)
    const tag = `v${major}.${minor + 10}.0`
    const name = `New-World-${tag.slice(1)}-macos-${arch}.dmg`
    const url = `${base}/download/${tag}/${name}`
    const bytes = Buffer.from('verified disk image fixture')
    const release = { tag_name: tag, draft: false, prerelease: false, body: 'Mac 专用更新。', assets: [{ name, browser_download_url: url, size: bytes.length, state: 'uploaded', digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }] }
    const target = info.outputPath(name)
    await writeFile(target, 'keep')
    await page.route(list, (route) => route.fulfill({ json: [release] }))
    await app.evaluate(({ session, dialog, shell }, data) => {
      globalThis.macInstallerBody = 'x'
      globalThis.macOpenedInstaller = undefined
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: data.target })
      session.fromPartition('new-world-update').fetch = async (url) => url.endsWith('/tags/' + data.release.tag_name)
        ? Response.json(data.release) : new Response(globalThis.macInstallerBody)
      shell.openPath = async (path) => { globalThis.macOpenedInstaller = path; return '' }
    }, { release, target })
    await page.reload()
    await expect(page.locator('#update-banner')).toContainText(tag)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    const update = settings.getByRole('button', { name: '下载安装包', exact: true })
    await update.click()
    await expect(settings.getByRole('alert')).toContainText('SHA-256')
    expect(await readFile(target, 'utf8')).toBe('keep')
    expect(await app.evaluate(() => globalThis.macOpenedInstaller)).toBeUndefined()
    await app.evaluate(({}, data) => { globalThis.macInstallerBody = data }, bytes.toString())
    const closed = app.waitForEvent('close')
    await update.click()
    await closed
    exited = true
    expect(await readFile(target)).toEqual(bytes)
  } finally { if (!exited) await stop(app) }
})
