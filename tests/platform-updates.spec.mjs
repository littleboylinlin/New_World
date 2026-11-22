import { readFileSync } from 'node:fs'
import { mkdtemp, cp, writeFile, rm, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './app-test.mjs'
import { releasePages, readWindowsInstaller, readMacInstaller, isInstallerUrl, isNewerTag } from '../desktop/release.mjs'
import { releaseAssets, validatePlan } from '../desktop/release-plan.mjs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const current = 'v' + version
const [major, minor] = version.split('.').map(Number)
const newer = `v${major}.${minor + 10}.0`
const newest = `v${major}.${minor + 20}.0`
const endpoint = 'https://api.github.com/repos/littleboylinlin/New_World/releases?per_page=100'

function asset(tag, platform, arch) {
  const name = platform === 'win32' ? `New-World-Setup-${tag.slice(1)}-x64.exe` : `New-World-${tag.slice(1)}-macos-${arch}.dmg`
  return { name, state: 'uploaded', size: 10, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: `${releasePages}download/${tag}/${name}` }
}
const release = (tag, assets) => ({ tag_name: tag, draft: false, prerelease: false, body: '平台独立更新。', assets })

async function desktop(page, platform, arch) {
  await page.addInitScript(({ platform, arch }) => {
    window.newWorldDesktop = {
      platform, arch, onCloseRequested: () => {}, onUpdateProgress: () => {},
      minimizeWindow: () => {}, toggleMaximizeWindow: () => {}, closeWindow: () => {},
      isMaximized: async () => false, onMaximizeChange: () => {},
      getCloseBehavior: async () => 'quit', setCloseBehavior: async (mode) => mode,
      getStorageLocation: async () => ({ path: '/Library/NewWorld', custom: false }),
      downloadUpdate: async () => ({ ok: true, canceled: true }),
    }
  }, { platform, arch })
}

test('较新的 Mac 专用发行版不触发 Windows 更新', async ({ page }) => {
  await desktop(page, 'win32', 'x64')
  await page.route(endpoint, (route) => route.fulfill({ json: [release(newest, [asset(newest, 'darwin', 'arm64'), asset(newest, 'darwin', 'x64')]), release(current, [asset(current, 'win32', 'x64')])] }))
  await page.goto('/')
  await page.getByRole('link', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '更新与关于', exact: true }).click()
  const settings = page.getByRole('region', { name: '更新与关于', exact: true })
  await expect(settings.locator('.update-state')).toHaveText('当前已是最新版本。')
  await expect(page.locator('#update-banner')).toBeHidden()
  await settings.getByRole('button', { name: '检查更新' }).click()
  await expect(settings.locator('.update-state')).toHaveText('当前已是最新版本。')
  await expect(settings.getByRole('button', { name: '更新并重启' })).toBeHidden()
})

test('Mac 仅选本机架构的 DMG，忽略 Windows 和另一架构的新版本', async ({ page }) => {
  await desktop(page, 'darwin', 'arm64')
  await page.route(endpoint, (route) => route.fulfill({ json: [release(newest, [asset(newest, 'win32', 'x64'), asset(newest, 'darwin', 'x64')]), release(newer, [asset(newer, 'darwin', 'arm64')])] }))
  await page.goto('/')
  await expect(page.locator('#update-banner')).toContainText(newer)
  await expect(page.locator('#update-banner')).not.toContainText(newest)
  await page.getByRole('link', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '更新与关于', exact: true }).click()
  const settings = page.getByRole('region', { name: '更新与关于', exact: true })
  await expect(settings).toContainText('macOS Apple Silicon')
  await settings.getByRole('button', { name: '更新并重启' }).click()
  await expect(settings.getByRole('button', { name: '更新并重启' })).toBeEnabled()
  await expect(settings.getByRole('alert')).toHaveCount(0)
  const padding = await page.locator('.header-inner').evaluate((node) => parseFloat(getComputedStyle(node).paddingLeft))
  expect(padding).toBeGreaterThanOrEqual(80)
})

test('Mac 不接受仅带 Windows 或另一芯片安装包的发行版', async ({ page }) => {
  await desktop(page, 'darwin', 'x64')
  await page.route(endpoint, (route) => route.fulfill({ json: [release(newest, [asset(newest, 'win32', 'x64'), asset(newest, 'darwin', 'arm64')])] }))
  await page.goto('/')
  await page.getByRole('link', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '更新与关于', exact: true }).click()
  await expect(page.locator('.update-state')).toContainText('macOS Intel')
  await expect(page.locator('#update-banner')).toBeHidden()
})

test('平台安装包要求名称、可信地址、架构和校验值全部匹配', () => {
  const mac = asset(newer, 'darwin', 'arm64')
  const win = asset(current, 'win32', 'x64')
  expect(readWindowsInstaller(newer, [mac])).toBeUndefined()
  expect(readMacInstaller(current, [win], 'arm64')).toBeUndefined()
  expect(readMacInstaller(newer, [mac], 'x64')).toBeUndefined()
  expect(readMacInstaller(newer, [mac], 'arm64').name).toBe(mac.name)
  expect(readMacInstaller(newer, [{ ...mac, digest: undefined }], 'arm64')).toBeUndefined()
  expect(readMacInstaller(newer, [{ ...mac, browser_download_url: 'https://example.invalid/app.dmg' }], 'arm64')).toBeUndefined()
  expect(isInstallerUrl(win.browser_download_url, 'darwin', 'arm64')).toBe(false)
  expect(isInstallerUrl(mac.browser_download_url, 'win32', 'x64')).toBe(false)
  expect(isInstallerUrl(mac.browser_download_url, 'darwin', 'arm64')).toBe(true)
  const windowsReleases = [release('v0.9.0', [asset('v0.9.0', 'darwin', 'arm64')]), release('v0.8.0', [asset('v0.8.0', 'win32', 'x64')])]
  const compatible = windowsReleases.map((item) => readWindowsInstaller(item.tag_name, item.assets)).filter(Boolean)
  expect(compatible.map((item) => item.tag)).toEqual(['v0.8.0'])
  expect(isNewerTag(compatible[0].tag, '0.8.0')).toBe(false)
})

test('发布计划区分 Mac 专用和 Windows、Mac 共同发行版', () => {
  const mac = validatePlan({ version, platforms: ['macos'] }, version)
  expect(releaseAssets(mac).filter((name) => name.endsWith('.exe'))).toHaveLength(0)
  expect(releaseAssets(mac).filter((name) => name.endsWith('.dmg'))).toHaveLength(2)
  const plan = validatePlan(JSON.parse(readFileSync('release.json', 'utf8')), version)
  expect(plan.platforms).toEqual(['windows', 'macos'])
  // The full installer (offline installs and in-app updates) and the online one with its app package.
  expect(releaseAssets(plan).filter((name) => name.endsWith('.exe'))).toEqual([`New-World-Setup-${version}-x64.exe`, `New-World-Online-Setup-${version}-x64.exe`])
  expect(releaseAssets(plan).filter((name) => name.endsWith('.nsis.7z'))).toEqual([`New-World-${version}-x64.nsis.7z`])
  expect(releaseAssets(mac).filter((name) => name.endsWith('.nsis.7z'))).toHaveLength(0)
  expect(releaseAssets(plan).filter((name) => name.endsWith('.dmg'))).toHaveLength(2)
  expect(() => validatePlan({ version, platforms: ['unknown'] }, version)).toThrow()
  expect(() => validatePlan({ version: '0.8.0', platforms: ['windows'] }, version)).toThrow()
})

test('发布前拒绝夹带其他平台文件或不匹配的语言包', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nw-release-plan-'))
  const run = promisify(execFile)
  try {
    const plan = validatePlan(JSON.parse(readFileSync('release.json', 'utf8')), version)
    for (const name of releaseAssets(plan)) {
      if (name.endsWith('.json')) await cp(join('public/locales', name), join(directory, name))
      else await writeFile(join(directory, name), 'disk image fixture')
    }
    await run(process.execPath, ['desktop/release-plan.mjs', '--verify-artifacts', directory])
    const sums = await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8')
    expect(sums.trim().split('\n').map((line) => line.split('  ')[1]).sort()).toEqual(releaseAssets(plan).sort())
    const unexpected = join(directory, `New-World-${version}-linux-x64.AppImage`)
    await writeFile(unexpected, 'unexpected')
    await expect(run(process.execPath, ['desktop/release-plan.mjs', '--verify-artifacts', directory])).rejects.toThrow('selected platforms')
    await rm(unexpected)
    await writeFile(join(directory, 'New-World-lang-en.json'), 'corrupt')
    await expect(run(process.execPath, ['desktop/release-plan.mjs', '--verify-artifacts', directory])).rejects.toThrow('language packs')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

const mirror = 'https://dl.writenewworld.com/latest.json'
const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Retry-After, X-RateLimit-Remaining' }
function latestJson(tag, keys) {
  const names = { 'windows-x64': `New-World-Setup-${tag.slice(1)}-x64.exe`, 'macos-arm64': `New-World-${tag.slice(1)}-macos-arm64.dmg`, 'macos-x64': `New-World-${tag.slice(1)}-macos-x64.dmg` }
  return {
    schema: 1, version: tag.slice(1), tag, publishedAt: '2026-11-18T00:00:00Z', notes: '镜像里的发行说明。',
    assets: Object.fromEntries(keys.map((key) => [key, { name: names[key], size: 10, sha256: 'a'.repeat(64), url: `https://dl.writenewworld.com/${tag}/${names[key]}` }])),
  }
}
async function openUpdates(page) {
  await page.getByRole('link', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '更新与关于', exact: true }).click()
  return page.getByRole('region', { name: '更新与关于', exact: true })
}

test('桌面版优先读取 dl.writenewworld.com 的 latest.json，不请求 GitHub', async ({ page }) => {
  await desktop(page, 'win32', 'x64')
  const github = []
  await page.route(mirror, (route) => route.fulfill({ json: latestJson(newer, ['windows-x64', 'macos-arm64']), headers: cors }))
  await page.route('https://api.github.com/**', (route) => { github.push(route.request().url()); return route.fulfill({ json: [], headers: cors }) })
  await page.goto('/')
  await expect(page.locator('#update-banner')).toContainText(newer)
  const settings = await openUpdates(page)
  await expect(settings.locator('.update-notes')).toHaveText('镜像里的发行说明。')
  await expect(settings.getByRole('link', { name: '查看 GitHub 发布页' })).toHaveAttribute('href', `${releasePages}tag/${newer}`)
  await settings.getByRole('button', { name: '检查更新' }).click()
  await expect(settings.locator('.update-state')).toContainText(newer)
  expect(github).toEqual([])
})

test('镜像出错或没有本平台安装包时回退到 GitHub API', async ({ page }) => {
  await desktop(page, 'darwin', 'arm64')
  let mirrorReply = (route) => route.fulfill({ status: 503, body: 'busy', headers: cors })
  let github = 0
  await page.route(mirror, (route) => mirrorReply(route))
  await page.route(endpoint, (route) => { github++; return route.fulfill({ json: [release(newer, [asset(newer, 'darwin', 'arm64')])], headers: cors }) })
  await page.goto('/')
  await expect(page.locator('#update-banner')).toContainText(newer)
  expect(github).toBe(1)

  mirrorReply = (route) => route.fulfill({ json: latestJson(newest, ['windows-x64']), headers: cors })
  const settings = await openUpdates(page)
  await settings.getByRole('button', { name: '检查更新' }).click()
  await expect(settings.locator('.update-state')).toContainText(newer)
  expect(github).toBe(2)

  mirrorReply = (route) => route.fulfill({ body: '{"schema":1,"tag":"v1.0.0"', headers: { ...cors, 'content-type': 'application/json' } })
  await settings.getByRole('button', { name: '检查更新' }).click()
  await expect(settings.locator('.update-state')).toContainText(newer)
  expect(github).toBe(3)
})

test('镜像不可用且 GitHub 达到请求限额时，提示更新服务器繁忙而不是只说限额', async ({ page }) => {
  await desktop(page, 'win32', 'x64')
  await page.route(mirror, (route) => route.abort('connectionrefused'))
  await page.route(endpoint, (route) => route.fulfill({ status: 403, json: { message: 'API rate limit exceeded' }, headers: { ...cors, 'x-ratelimit-remaining': '0' } }))
  await page.goto('/')
  const settings = await openUpdates(page)
  await expect(settings.locator('.update-state')).toHaveText('更新服务器暂时繁忙，请稍后重试或切换网络。')
  await expect(settings.locator('.update-state')).not.toContainText('限额')
})
