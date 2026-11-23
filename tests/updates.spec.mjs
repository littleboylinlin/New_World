import { startWork } from './navigation-helpers.mjs'
import { readFileSync } from 'node:fs'
import { expect, test } from './app-test.mjs'
import { saveNow } from './editor-helpers.mjs'

const deployed = JSON.parse(readFileSync(new URL('../dist/version.json', import.meta.url), 'utf-8'))
const tip = (page) => page.locator('.corner-tip[data-tip="version"]')

function serveVersion(context, build) {
  const seen = { count: 0 }
  return context.route('**/version.json', (route) => {
    seen.count++
    return route.fulfill({ json: { version: deployed.version, build: build() } })
  }).then(() => seen)
}

test('网页版不请求 GitHub，也没有手动检查更新按钮', async ({ page, context }) => {
  const github = []
  context.on('request', (request) => { if (request.url().includes('api.github.com')) github.push(request.url()) })
  await page.goto('/#/settings/updates')
  const section = page.getByRole('region', { name: '更新与关于', exact: true })
  await expect(section).toContainText('无需手动检查')
  await expect(section.getByRole('button', { name: '检查更新' })).toHaveCount(0)
  await expect(page.locator('#update-banner')).toBeHidden()
  expect(github).toEqual([])
})

test('打开页面和切回标签页时静默比对 version.json，同一构建不提示', async ({ page, context }) => {
  const seen = await serveVersion(context, () => deployed.build)
  const firstCheck = page.waitForResponse((response) => new URL(response.url()).pathname === '/version.json')
  await page.goto('/')
  await (await firstCheck).finished()
  await expect.poll(() => seen.count).toBe(1)
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => {
    document.dispatchEvent(new Event('visibilitychange'))
    done()
  })))
  await expect.poll(() => seen.count).toBe(2)
  await page.waitForTimeout(200)
  await expect(tip(page)).toHaveCount(0)
})

test('网站部署新版后在角落提示，关闭后同一构建不再出现，更新的构建再次提示', async ({ page, context }) => {
  let build = 'next-build'
  await serveVersion(context, () => build)
  await page.goto('/')
  await expect(tip(page)).toContainText('新版本已就绪')
  await expect(tip(page)).toBeInViewport()
  await tip(page).getByRole('button', { name: '关闭提示' }).click()
  await expect(tip(page)).toHaveCount(0)
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.waitForTimeout(300)
  await expect(tip(page)).toHaveCount(0)
  build = 'later-build'
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(tip(page)).toContainText('新版本已就绪')
})

test('刷新前先确认正文已保存：保存失败不刷新，保存后刷新页面', async ({ page, context }) => {
  await serveVersion(context, () => 'next-build')
  await context.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'chapters' && window.updateTestStorageFull) throw new DOMException('fixture', 'QuotaExceededError')
      return put.apply(this, args)
    }
  })
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill('更新前的稿件')
  await page.getByRole('button', { name: '创建小说' }).click()
  const editor = page.getByRole('textbox', { name: '章节正文' })
  await editor.fill('已保存的段落。')
  await saveNow(page)
  await expect(page.locator('.save-status')).toHaveText('已保存')
  const url = page.url()
  const timeOrigin = await page.evaluate(() => performance.timeOrigin)
  await page.evaluate(() => { window.updateTestStorageFull = true })
  await editor.fill('还没写入存储的段落。')
  await expect(page.locator('.save-status')).toContainText('未保存')

  await tip(page).getByRole('button', { name: '刷新使用新版' }).click()
  await expect(tip(page)).toContainText('正文还没保存')
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
  await expect(editor).toHaveText('还没写入存储的段落。')

  await page.evaluate(() => { window.updateTestStorageFull = false })
  await Promise.all([page.waitForEvent('load'), tip(page).getByRole('button', { name: '刷新使用新版' }).click()])
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin)
  await expect(page).toHaveURL(url)
  await expect(editor).toHaveText('还没写入存储的段落。')
  await expect(page.locator('.save-status')).toHaveText('已保存')
})

test('底部更新提示为所有页面留出空间，新建作品按钮的底部可以点击', async ({ page, context }) => {
  await serveVersion(context, () => 'next-build')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 740 })
  await page.goto('/')
  const banner = tip(page)
  await expect(banner).toBeVisible()

  async function checkPageEnd() {
    await expect.poll(async () => {
      const bannerBox = await banner.boundingBox()
      const contentBox = await page.locator('#page').boundingBox()
      return contentBox.y + contentBox.height <= bannerBox.y + 1
    }).toBe(true)
  }

  const create = page.getByRole('button', { name: '新建作品', exact: true })
  await expect(create).toBeVisible()
  await checkPageEnd()
  await create.scrollIntoViewIfNeeded()
  await expect(create).toBeInViewport({ ratio: 1 })
  const box = await create.boundingBox()
  const bannerBox = await banner.boundingBox()
  expect(box.y + box.height).toBeLessThanOrEqual(bannerBox.y)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 2)
  await expect(page.getByRole('dialog', { name: '选择作品类型' })).toBeVisible()
  await page.locator('.type-options button.mode-original').click()
  await page.getByRole('textbox', { name: '作品名' }).fill('底部提示回归测试')
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(page.getByRole('textbox', { name: '章节正文' })).toBeVisible()
  await checkPageEnd()

  for (const [route, selector] of [
    ['writing', '.writing-toolbar'], ['notes/ideas', '.ideas-page'], ['notes/tasks', '.task-layout'],
    ['archive', '.archive-page'], ['trash', '.trash-page'], ['settings/storage', '.settings-content'],
  ]) {
    await page.goto(`/#/${route}`)
    await expect(page.locator(selector)).toBeVisible()
    await checkPageEnd()
  }

  await page.setViewportSize({ width: 804, height: 740 })
  await checkPageEnd()
  const pageBefore = await page.locator('#page').boundingBox()
  const footer = await page.locator('.site-footer').boundingBox()
  const tipSpace = footer.y - pageBefore.y - pageBefore.height
  expect(tipSpace).toBeGreaterThanOrEqual((await banner.boundingBox()).height)
  await banner.getByRole('button', { name: '关闭提示' }).click()
  await expect(banner).toHaveCount(0)
  await expect.poll(async () => {
    const pageAfter = await page.locator('#page').boundingBox()
    return pageAfter.height - pageBefore.height
  }).toBeCloseTo(tipSpace, 0)
})
