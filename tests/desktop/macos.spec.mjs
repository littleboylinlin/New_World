import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test } from '@playwright/test'
import { createPackage, extractAll } from '@electron/asar'
import { checkNativeHeader } from '../header-layout.mjs'

const command = promisify(execFile)
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const manifest = JSON.parse(await readFile('public/locales/manifest.json', 'utf8'))
const arch = process.arch
const base = 'https://github.com/littleboylinlin/New_World/releases'
const list = 'https://api.github.com/repos/littleboylinlin/New_World/releases?per_page=100'
const profile = join(homedir(), 'Library', 'Application Support', 'NewWorld')
const languages = join(homedir(), 'Library', 'Application Support', 'NewWorld-languages')
const updateCache = join(homedir(), 'Library', 'Application Support', 'NewWorld-updates', 'macos')
const exists = (path) => stat(path).then(() => true, () => false)
let directory, bundle, executable

test.skip(process.platform !== 'darwin', 'Requires macOS')
test.describe.configure({ mode: 'serial' })

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
  await mkdir(join(languages, 'packs', '0.0.0'), { recursive: true })
  await writeFile(join(languages, 'packs', '0.0.0', 'en.json'), 'old cache')
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
    await expect.poll(() => exists(join(languages, 'packs', '0.0.0'))).toBe(false)
    await expect.poll(() => readFile(join(profile, 'NewWorld-cache-version'), 'utf8').catch(() => '')).toBe(version)
    expect(await page.evaluate(() => ({ platform: window.newWorldDesktop.platform, arch: window.newWorldDesktop.arch }))).toEqual({ platform: 'darwin', arch })
    await expect(page.locator('html')).toHaveClass(/macos/)
    const left = await page.locator('.brand').evaluate((node) => node.getBoundingClientRect().left)
    expect(left).toBeGreaterThanOrEqual(80)
    const status = await page.locator('.local-label').boundingBox()
    const trash = await page.locator('#trash-link').boundingBox()
    expect(status.x + status.width).toBeLessThanOrEqual(trash.x)
    await page.screenshot({ path: info.outputPath('macos-home.png'), animations: 'disabled' })
    await checkNativeHeader(app, page, info, 'macos')
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
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await checkNativeHeader(app, page, info, 'macos')
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

test('Mac 校验实际 DMG，完整替换并重启，清理旧文件且保留下载期间的正文', async ({}, info) => {
  const [major, minor] = version.split('.').map(Number)
  const previous = `${major}.${minor - 1}.99`
  const archive = join(bundle, 'Contents', 'Resources', 'app.asar')
  const fixture = info.outputPath('previous-app')
  extractAll(archive, fixture)
  const metadata = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'))
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ ...metadata, version: previous }))
  const oldManifest = { ...manifest, version: previous }
  await writeFile(join(fixture, 'desktop', 'language-manifest.json'), JSON.stringify(oldManifest))
  const { readdir, rename } = await import('node:fs/promises')
  const assets = join(fixture, 'dist', 'assets')
  for (const file of (await readdir(assets)).filter((name) => name.endsWith('.js'))) {
    const path = join(assets, file)
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll(version, previous))
  }
  const staged = info.outputPath('previous.asar')
  await createPackage(fixture, staged)
  await rename(staged, archive)
  const obsolete = join(bundle, 'Contents', 'Resources', 'obsolete-version.txt')
  await writeFile(obsolete, 'must disappear')
  await command('/usr/bin/plutil', ['-replace', 'CFBundleShortVersionString', '-string', previous, join(bundle, 'Contents', 'Info.plist')])
  await command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle])
  await mkdir(join(languages, 'packs', previous), { recursive: true })
  await cp('public/locales/New-World-lang-zh-CN.json', join(languages, 'packs', previous, 'zh-CN.json'))
  let app = await electron.launch({ executablePath: executable, args: ['--proxy-server=http://127.0.0.1:1', '--disable-gpu'] })
  app.on('console', (message) => console.log('Mac application:', message.text()))
  let exited = false
  let restarted
  try {
    const page = await app.firstWindow()
    await expect(page.locator('#app-version')).toHaveText('v' + previous)
    await page.waitForLoadState('load')
    const tag = 'v' + version
    const name = `New-World-${version}-macos-${arch}.dmg`
    const url = `${base}/download/${tag}/${name}`
    const dmg = resolve('dist-macos', name)
    const bytes = await readFile(dmg)
    const release = { tag_name: tag, draft: false, prerelease: false, body: 'Mac 专用更新。', assets: [{ name, browser_download_url: url, size: bytes.length, state: 'uploaded', digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }] }
    await page.route(list, (route) => route.fulfill({ json: [release] }))
    await app.evaluate(({ session }, data) => {
      globalThis.corruptMacDownload = true
      const gate = Promise.withResolvers()
      globalThis.continueMacDownload = gate.resolve
      session.fromPartition('new-world-update').fetch = async (url) => {
        if (url.endsWith('/tags/' + data.release.tag_name)) return Response.json(data.release)
        if (globalThis.corruptMacDownload) return new Response('x')
        const stream = process.getBuiltinModule('node:fs').createReadStream(data.dmg)
        const reader = process.getBuiltinModule('node:stream').Readable.toWeb(stream).getReader()
        let sent = false
        return new Response(new ReadableStream({
          async pull(controller) {
            if (sent) await gate.promise
            const { value, done } = await reader.read()
            if (done) controller.close()
            else { controller.enqueue(value); sent = true }
          }, cancel: () => reader.cancel(),
        }))
      }
    }, { release, dmg })
    await page.reload()
    await expect(page.locator('#update-banner')).toContainText(tag)
    await page.locator('a[href="#/original"]').first().click()
    await page.getByRole('button', { name: '新建小说', exact: true }).click()
    await page.getByRole('textbox', { name: '作品名' }).fill('整包更新前的小说')
    await page.getByRole('button', { name: '创建小说' }).click()
    await editor(page).fill('整包更新必须保留正文。')
    await page.keyboard.press('Meta+s')
    await expect(page.locator('.save-status')).toHaveText('已保存')
    const draftUrl = page.url()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    const update = settings.getByRole('button', { name: '更新并重启', exact: true })
    await update.click()
    await expect(settings.getByRole('alert')).toContainText('SHA-256')
    expect(await exists(obsolete)).toBe(true)
    await app.evaluate(() => { globalThis.corruptMacDownload = false })
    const closed = app.waitForEvent('close', { timeout: 90_000 })
    await update.click()
    await expect.poll(() => settings.getByRole('progressbar').evaluate((node) => node.value)).toBeGreaterThan(0)
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await editor(page).fill('下载期间新增的正文也必须保留。')
    await app.evaluate(() => globalThis.continueMacDownload())
    await closed
    exited = true
    let result
    await expect.poll(async () => {
      result = await readFile(join(updateCache, 'last-update.json'), 'utf8').then(JSON.parse).catch(() => undefined)
      return result?.version === version && ['installed', 'rolled-back', 'failed'].includes(result?.state)
    }, { timeout: 90_000 }).toBe(true)
    restarted = result.pid
    expect(result, JSON.stringify(result)).toMatchObject({ state: 'installed' })
    expect(await exists(obsolete)).toBe(false)
    expect((await readdir(updateCache)).filter((name) => /^(download-|job-)/.test(name))).toEqual([])
    expect((await readdir(dirname(bundle))).filter((name) => name.startsWith('.NewWorld-update-'))).toEqual([])
    process.kill(restarted, 'SIGTERM')
    await expect.poll(() => { try { process.kill(restarted, 0); return true } catch { return false } }, { timeout: 10_000 }).toBe(false)
    restarted = undefined
    app = await launch()
    exited = false
    const current = await app.firstWindow()
    await current.goto(draftUrl)
    await expect(editor(current)).toHaveText('下载期间新增的正文也必须保留。')
    expect(await exists(join(languages, 'packs', previous))).toBe(false)
  } catch (error) {
    for (const name of (await readdir(updateCache).catch(() => [])).filter((name) => name.startsWith('job-'))) {
      const job = join(updateCache, name)
      for (const file of ['plan.json', 'worker.json', 'worker-ready.json', 'phase.json', 'boot.json', 'worker.log']) {
        console.log('Mac update diagnostic:', name, file, await readFile(join(job, file), 'utf8').catch(() => 'missing'))
      }
    }
    throw error
  } finally {
    if (restarted) { try { process.kill(restarted, 'SIGKILL') } catch {} }
    if (!exited) await stop(app)
  }
})

test('Mac 新版进程启动失败后原子恢复旧应用，保留书库并清理失败包', async () => {
  const id = randomUUID()
  const job = join(updateCache, 'job-' + id)
  const stageRoot = join(dirname(bundle), '.NewWorld-update-' + id)
  const stage = join(stageRoot, 'New World.app')
  await mkdir(join(stage, 'Contents', 'MacOS'), { recursive: true })
  await mkdir(job, { recursive: true })
  await writeFile(join(stage, 'Contents', 'MacOS', 'New World'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const plan = { id, directory: job, stageRoot, stage, target: bundle, version: '1.0.0', parentPid: 999999 }
  await writeFile(join(job, 'plan.json'), JSON.stringify(plan))
  for (const file of ['macos-replace.cjs', 'macos-swap.js']) await cp(join('desktop', file), join(job, file))
  const archive = join(bundle, 'Contents', 'Resources', 'app.asar')
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex')
  let restarted
  try {
    await command(executable, [join(job, 'macos-replace.cjs'), join(job, 'plan.json')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 })
    const result = JSON.parse(await readFile(join(updateCache, 'last-update.json'), 'utf8'))
    expect(result.id).toBe(id)
    expect(result.state).toBe('rolled-back')
    restarted = result.pid
    expect(createHash('sha256').update(await readFile(archive)).digest('hex')).toBe(hash)
    expect(await exists(stageRoot)).toBe(false)
    expect(await exists(job)).toBe(false)
    expect(await exists(join(profile, 'IndexedDB'))).toBe(true)
    process.kill(restarted, 'SIGTERM')
    await expect.poll(() => { try { process.kill(restarted, 0); return true } catch { return false } }, { timeout: 10_000 }).toBe(false)
    restarted = undefined
    const app = await launch()
    try { await expect((await app.firstWindow()).getByRole('heading', { name: '我的小说书库' })).toBeVisible() } finally { await stop(app) }
  } finally { if (restarted) { try { process.kill(restarted, 'SIGKILL') } catch {} } }
})

test('AI 接入与权限：macOS 桌面端可启用本地接口，创建作品并在人工二次确认后才允许删除', async () => {
  const app = await launch()
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settingsDialog = page.getByRole('dialog', { name: '设置' })
    const section = settingsDialog.getByRole('region', { name: 'AI 接入与权限', exact: true })
    await section.scrollIntoViewIfNeeded()

    await expect(section.locator('.ai-badge').first()).toHaveText('已停用')
    await section.locator('input[data-ai-global-enable="true"]').check()
    await expect(section.locator('.ai-badge').first()).toContainText('本地监听 127.0.0.1:')
    const endpointText = await section.locator('.ai-endpoint-line').innerText()
    const portMatch = endpointText.match(/http:\/\/127\.0\.0\.1:(\d+)\/v1/)
    expect(portMatch).toBeTruthy()
    const baseUrl = `http://127.0.0.1:${portMatch[1]}/v1`

    await section.getByLabel('AI 配置名称').fill('MacDesktopAgent')
    await section.getByRole('button', { name: '添加 AI 配置' }).click()
    await expect(section.locator('.ai-token-banner')).toBeVisible()
    const token = (await section.locator('.ai-token-value').innerText()).trim()
    expect(token.startsWith('nw_ai_')).toBe(true)
    await section.getByRole('button', { name: '我已保存' }).click()

    const card = section.locator('.ai-client-card').filter({ hasText: 'MacDesktopAgent' })
    for (const perm of ['create', 'read', 'update', 'delete']) {
      await card.locator(`input[data-ai-perm="${perm}"]`).check()
    }
    await card.getByRole('radio', { name: '允许访问整个小说库' }).check()
    await settingsDialog.getByRole('button', { name: '关闭', exact: true }).click()

    const createRes = await fetch(`${baseUrl}/works`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        library: 'original',
        title: 'macOS AI 联调作品',
        initialChapters: [{ title: '第一章', format: 'text', content: 'macOS 主进程本地调用写入的正文。' }],
      }),
    })
    expect(createRes.status).toBe(201)
    const createdJson = await createRes.json()
    const workId = createdJson.data.work.id

    const confirmDialog = page.getByRole('dialog', { name: '确认 AI 请求的操作' })
    const delPromise = fetch(`${baseUrl}/works/original/${workId}?wait=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    await expect(confirmDialog).toBeVisible()
    await expect(confirmDialog).toContainText('macOS AI 联调作品')
    await confirmDialog.getByRole('button', { name: '本人确认执行' }).click()
    expect((await delPromise).status).toBe(200)

    await page.getByRole('button', { name: '设置', exact: true }).click()
    await section.scrollIntoViewIfNeeded()
    await section.locator('.ai-client-card').filter({ hasText: 'MacDesktopAgent' }).getByRole('button', { name: '撤销配置' }).click()
    await section.locator('input[data-ai-global-enable="true"]').uncheck()
    await expect(section.locator('.ai-badge').first()).toHaveText('已停用')
  } finally { await stop(app) }
})

test('10. AI 历史版本与回收站保护：macOS 桌面端重启后仍可预览恢复历史正文与被删对象', async () => {
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settingsDialog = page.getByRole('dialog', { name: '设置' })
    const section = settingsDialog.getByRole('region', { name: 'AI 接入与权限', exact: true })
    await section.scrollIntoViewIfNeeded()
    await section.locator('input[data-ai-global-enable="true"]').check()
    const portMatch = (await section.locator('.ai-endpoint-line').innerText()).match(/http:\/\/127\.0\.0\.1:(\d+)\/v1/)
    expect(portMatch).toBeTruthy()
    const baseUrl = `http://127.0.0.1:${portMatch[1]}/v1`

    await section.getByLabel('AI 配置名称').fill('MacRecoveryAI')
    await section.getByRole('button', { name: '添加 AI 配置' }).click()
    const token = (await section.locator('.ai-token-value').innerText()).trim()
    await section.getByRole('button', { name: '我已保存' }).click()

    const card = section.locator('.ai-client-card').filter({ hasText: 'MacRecoveryAI' })
    for (const perm of ['create', 'read', 'update', 'delete']) {
      await card.locator(`input[data-ai-perm="${perm}"]`).check()
    }
    await card.getByRole('radio', { name: '允许访问整个小说库' }).check()
    await settingsDialog.getByRole('button', { name: '关闭', exact: true }).click()

    const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    const v0 = 'Mac 初版正文：寒夜里的书房灯光始终亮着。'
    const v1 = 'Mac 一版正文：寒夜里的书房灯光微弱地闪烁。'
    const v2 = 'Mac 二版正文：寒夜里的书房灯光照亮整张书桌。'

    const createRes = await fetch(`${baseUrl}/works`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        library: 'original',
        title: 'Mac 历史与回收站恢复作品',
        initialChapters: [
          { title: '第一章', format: 'text', content: v0 },
          { title: 'Mac 待删章', format: 'text', content: 'Mac 重启后仍需从回收站恢复的章节。' },
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

    const ideaRes = await fetch(`${baseUrl}/ideas`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ text: 'Mac 重启恢复灵感', work: { library: 'original', bookId: workId } }),
    })
    expect(ideaRes.status).toBe(201)
    const ideaId = (await ideaRes.json()).data.idea.id

    expect((await fetch(`${baseUrl}/works/original/${workId}/editions/${editionId}/chapters/${ch1Id}`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ content: v1 }),
    })).status).toBe(200)
    expect((await fetch(`${baseUrl}/works/original/${workId}/editions/${editionId}/chapters/${ch1Id}`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ content: v2 }),
    })).status).toBe(200)

    const trashRes = await fetch(`${baseUrl}/trash`, { headers: { Authorization: `Bearer ${token}` } })
    expect(trashRes.status).toBe(403)
    expect((await trashRes.json()).error.code).toBe('recovery_data_forbidden')

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

    await stop(app)
    app = await launch()
    page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()

    await page.evaluate((u) => { location.hash = u }, `#/original/${workId}/${editionId}`)
    await expect(editor(page)).toHaveText(v2)
    await expect(page.locator('button.history-toggle .history-count')).toHaveText('2')
    await page.locator('button.history-toggle').click()
    const revDialog = page.getByRole('dialog', { name: /历史版本/ })
    await expect(revDialog).toBeVisible()
    await revDialog.locator('button.revision-item').nth(1).click()
    await expect(revDialog.locator('.revision-preview-text')).toHaveText(v0)
    await revDialog.getByRole('button', { name: '恢复此版本' }).click()
    await expect(editor(page)).toHaveText(v0)
    await expect(page.locator('button.history-toggle .history-count')).toHaveText('3')

    await page.evaluate(() => { location.hash = '#/trash' })
    const trashList = page.getByRole('list', { name: '回收站内容' })
    await expect(trashList).toContainText('Mac 待删章')
    await expect(trashList).toContainText('Mac 重启恢复灵感')
    const chRow = trashList.locator('.trash-row').filter({ has: page.locator('.book-title', { hasText: 'Mac 待删章' }) })
    await chRow.getByRole('button', { name: '恢复' }).click()
    await expect(chRow).toHaveCount(0)
    const ideaRow = trashList.locator('.trash-row').filter({ has: page.locator('.book-title', { hasText: 'Mac 重启恢复灵感' }) })
    await ideaRow.getByRole('button', { name: '恢复' }).click()
    await expect(ideaRow).toHaveCount(0)

    await page.evaluate((u) => { location.hash = u }, `#/original/${workId}/${editionId}`)
    await expect(page.locator('.chapter-list')).toContainText('Mac 待删章')
    await page.evaluate(() => { location.hash = '#/ideas' })
    await expect(page.getByRole('list', { name: '灵感列表' })).toContainText('Mac 重启恢复灵感')

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const resetSection = page.getByRole('dialog', { name: '设置' }).getByRole('region', { name: 'AI 接入与权限', exact: true })
    await resetSection.scrollIntoViewIfNeeded()
    await resetSection.locator('.ai-client-card').filter({ hasText: 'MacRecoveryAI' }).getByRole('button', { name: '撤销配置' }).click()
    await resetSection.locator('input[data-ai-global-enable="true"]').uncheck()
    await expect(resetSection.locator('.ai-badge').first()).toHaveText('已停用')
  } finally { await stop(app) }
})
