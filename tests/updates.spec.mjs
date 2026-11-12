import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { releaseEndpoint } from './app-test.mjs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
const [major, minor] = version.split('.').map(Number)
const currentTag = `v${version}`
const newerTag = `v${major}.${minor + 10}.0`
const releasePage = `https://github.com/littleboylinlin/New_World/releases/tag/${newerTag}`
const release = (tag, fields = {}) => ({ tag_name: tag, draft: false, prerelease: false, body: '修复示例问题。', ...fields })
const banner = (page) => page.locator('#update-banner')

function reply(route, payload, status = 200, headers = {}) {
  return route.fulfill({
    status,
    headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Retry-After, X-RateLimit-Remaining', ...headers },
    ...(typeof payload === 'string' ? { body: payload, contentType: 'text/html' } : { json: payload }),
  })
}

async function openHelp(page) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  return page.getByRole('dialog', { name: '设置' })
}

test('启动检查异步且只请求一次，手动检查显示进度和最新状态', async ({ page }) => {
  const auto = Promise.withResolvers()
  const manual = Promise.withResolvers()
  let requests = 0
  await page.route(releaseEndpoint, async (route) => {
    requests++
    await (requests === 1 ? auto.promise : manual.promise)
    await reply(route, release(`${currentTag}+ci.1`))
  })

  try {
    await page.goto('/')
    await expect.poll(() => requests).toBe(1)
    await expect(page.getByRole('heading', { name: '我的小说书库' })).toBeVisible()
    await expect(page.locator('#app-version')).toHaveText(currentTag)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('link', { name: '进入原创库' }).click()
    await expect(page.getByRole('heading', { name: '原创库' })).toBeVisible()
    const dialog = await openHelp(page)
    const check = dialog.getByRole('button', { name: '检查更新' })
    await expect(dialog.getByText(`当前运行版本 ${currentTag}`)).toBeVisible()
    await expect(dialog.locator('.update-state')).toHaveText('正在检查更新…')
    await expect(check).toBeDisabled()
    expect(requests).toBe(1)
    auto.resolve()
    await expect(dialog.locator('.update-state')).toHaveText('当前已是最新版本。')
    await check.click()
    await expect(dialog.locator('.update-state')).toHaveText('正在检查更新…')
    await expect.poll(() => requests).toBe(2)
    manual.resolve()
    await expect(dialog.locator('.update-state')).toHaveText('当前已是最新版本。')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(banner(page)).toBeHidden()
  } finally {
    auto.resolve()
    manual.resolve()
  }
})

test('较高的正式版本显示说明和可信入口，忽略后仍可从帮助查看', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const notes = '# 版本说明\n\n新增更新提示。\n<img src="https://example.invalid/remote" onerror="window.notesRan=true">'
  await context.route(releaseEndpoint, (route) => reply(route, release(newerTag, {
    body: notes,
    html_url: 'https://example.invalid/unsafe-release',
    assets: [{ browser_download_url: 'https://example.invalid/unsafe-download' }],
  })))
  await context.route(releasePage, (route) => route.fulfill({ contentType: 'text/html', body: '<title>发布页测试响应</title>' }))
  const unexpected = []
  await context.route('https://example.invalid/**', (route) => { unexpected.push(route.request().url()); return route.abort() })
  await page.goto('/')
  const notice = banner(page)
  await expect(notice).toContainText(`发现新版本 ${newerTag}`)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await notice.getByRole('button', { name: '查看更新' }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog.getByRole('heading', { name: '帮助与更新', exact: true })).toBeFocused()
  await expect(page.locator('dialog[open]')).toHaveCount(1)
  const link = dialog.getByRole('link', { name: '查看 GitHub 发布页' })
  expect(await dialog.locator('.update-notes').textContent()).toBe(notes)
  await expect(dialog.locator('.update-notes img')).toHaveCount(0)
  await expect(link).toHaveAttribute('href', releasePage)
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('home-update-mobile.png') })
  const [popup] = await Promise.all([context.waitForEvent('page'), link.click()])
  await expect(popup).toHaveURL(releasePage)
  await popup.close()
  expect(unexpected).toEqual([])
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await notice.getByRole('button', { name: '本次忽略' }).click()
  await expect(notice).toBeHidden()
  await page.getByRole('link', { name: '进入续写／仿写库' }).click()
  await expect(notice).toBeHidden()
  await openHelp(page)
  const response = page.waitForResponse(releaseEndpoint)
  await dialog.getByRole('button', { name: '检查更新' }).click()
  await response
  await expect(dialog.locator('.update-state')).toHaveText(`发现新版本 ${newerTag}`)
  await expect(notice).toBeHidden()
})

test('草稿、预发布标记、预发布标签和无发行版都不提示升级', async ({ page }) => {
  const replies = [
    [release(newerTag, { draft: true })],
    [release(newerTag, { prerelease: true })],
    [release(`${newerTag}-rc.2`)],
    [{ message: 'Not Found' }, 404],
    [release('v0.2.9')],
  ]
  let requests = 0
  await page.route(releaseEndpoint, (route) => reply(route, ...replies[requests++]))
  await page.goto('/')
  const dialog = await openHelp(page)
  const check = dialog.getByRole('button', { name: '检查更新' })
  await expect(dialog.locator('.update-state')).toHaveText('GitHub 暂未提供可比较的正式发行版。')
  for (let number = 2; number <= 4; number++) {
    const response = page.waitForResponse(releaseEndpoint)
    await check.click()
    await response
    await expect(dialog.locator('.update-state')).toHaveText('GitHub 暂未提供可比较的正式发行版。')
    expect(requests).toBe(number)
    await expect(banner(page)).toBeHidden()
  }
  await check.click()
  await expect(dialog.locator('.update-state')).toHaveText('当前版本高于 GitHub 最新正式发行版 v0.2.9。')
  await expect(dialog.getByRole('link', { name: '查看 GitHub 发布页' })).toBeHidden()
  await expect(banner(page)).toBeHidden()
})

test('离线、连接失败、限流、服务异常和无效版本可手动重试', async ({ page, context }) => {
  const replies = [
    [{ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }],
    [{ message: 'Slow down' }, 429],
    [{ message: 'Unavailable' }, 503],
    ['<html>Gateway error</html>'],
    [{ draft: false, prerelease: false }],
    [release(`v${major}.0${minor}.9`)],
    [release(currentTag)],
  ]
  let requests = 0
  await context.route(releaseEndpoint, (route) => requests++ === 0 ? route.abort('internetdisconnected') : reply(route, ...replies[requests - 2]))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '我的小说书库' })).toBeVisible()
  await expect(banner(page)).toBeHidden()
  const dialog = await openHelp(page)
  const check = dialog.getByRole('button', { name: '检查更新' })
  const state = dialog.locator('.update-state')
  await expect(state).toContainText('无法连接 GitHub')
  await context.setOffline(true)
  await check.click()
  await expect(state).toContainText('当前处于离线状态')
  expect(requests).toBe(1)
  await context.setOffline(false)
  const messages = ['请求限额', '请求限额', 'HTTP 503', '版本信息不完整或格式异常', '版本信息不完整或格式异常', '版本信息不完整或格式异常', '当前已是最新版本']
  for (const message of messages) {
    const response = page.waitForResponse(releaseEndpoint)
    await check.click()
    await response
    await expect(state).toContainText(message)
    await expect(check).toBeEnabled()
  }
  expect(requests).toBe(8)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('link', { name: '进入原创库' }).click()
  await expect(page.getByRole('button', { name: '导入文件' })).toBeEnabled()
  await expect(banner(page)).toBeHidden()
})

test('更新重载复用编辑器保存检查，失败保留正文，成功后恢复已保存稿件', async ({ page, context }) => {
  await context.route(releaseEndpoint, (route) => reply(route, release(newerTag)))
  await context.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'chapters' && window.updateTestStorageFull) throw new DOMException('fixture', 'QuotaExceededError')
      return put.apply(this, args)
    }
  })
  await page.goto('/#/original')
  await expect(banner(page)).toContainText(newerTag)
  await page.getByRole('button', { name: '新建小说' }).click()
  await page.getByRole('textbox', { name: '作品名' }).fill('更新前的稿件')
  await page.getByRole('button', { name: '创建小说' }).click()
  const editor = page.getByRole('textbox', { name: '章节正文' })
  await editor.fill('已保存的段落。')
  await page.getByRole('button', { name: '手动保存' }).click()
  await expect(page.locator('.save-status')).toHaveText('已保存')
  const url = page.url()
  const timeOrigin = await page.evaluate(() => performance.timeOrigin)
  await page.evaluate(() => { window.updateTestStorageFull = true })
  await editor.fill('还没写入存储的段落。')
  await expect(page.locator('.save-status')).toContainText('未保存')

  const dialog = await openHelp(page)
  const reload = dialog.getByRole('button', { name: '重新加载当前网页' })
  await reload.click()
  await expect(dialog.getByRole('alert')).toContainText('当前正文尚未保存')
  await expect(reload).toBeEnabled()
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
  await expect(page).toHaveURL(url)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(editor).toHaveText('还没写入存储的段落。')
  await expect(page.locator('.save-status')).toContainText('失败')

  await page.evaluate(() => { window.updateTestStorageFull = false })
  await openHelp(page)
  await Promise.all([page.waitForEvent('load'), reload.click()])
  await expect(page).toHaveURL(url)
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin)
  await expect(editor).toHaveText('还没写入存储的段落。')
  await expect(page.locator('.save-status')).toHaveText('已保存')
})
