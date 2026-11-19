import { startWork } from './navigation-helpers.mjs'
import { expect, test } from './app-test.mjs'

test('桌面版页眉固定在窗口顶部，编辑器页面不滚动、只有正文区在页眉下方滚动', async ({ page }) => {
  await page.addInitScript(() => {
    window.newWorldDesktop = {
      downloadUpdate: async () => ({ ok: true }),
      installUpdate: async () => ({ ok: true }),
      onUpdateProgress: () => {},
      savePdf: async () => {},
      onCloseRequested: () => {},
      minimizeWindow: () => {}, toggleMaximizeWindow: () => {}, closeWindow: () => {},
      isMaximized: async () => false, onMaximizeChange: () => {},
      getStorageLocation: async () => ({ path: 'C:\\书库', defaultPath: 'C:\\书库', custom: false }),
      setStorageLocation: async () => null,
      resetStorageLocation: async () => null,
    }
  })
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill('长卷')
  await page.getByRole('button', { name: '创建小说' }).click()
  await page.getByRole('textbox', { name: '章节正文' }).fill(Array.from({ length: 80 }, (_, line) => `第 ${line + 1} 行。`).join('\n'))
  await page.evaluate(() => {
    for (const node of [document.querySelector('#page'), document.querySelector('.editor-scroll')]) node.scrollTop = node.scrollHeight
  })

  const position = () => page.evaluate(() => ({
    header: document.querySelector('.site-header').getBoundingClientRect().top,
    page: document.querySelector('#page').scrollTop,
    text: document.querySelector('.editor-scroll')?.scrollTop ?? 0,
    window: scrollY,
  }))
  const scrolled = await position()
  expect(scrolled.header).toBe(0)
  expect(scrolled.window).toBe(0)
  expect(scrolled.page).toBe(0)
  expect(scrolled.text).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await page.getByRole('link', { name: 'New World 书库首页' }).click()
  await expect(page.getByRole('heading', { name: '写作统计' })).toBeVisible()
  expect((await position()).page).toBe(0)
})

test('Web 端编辑器页面本身不滚动，正文区滚动，侧栏和页脚留在视口内', async ({ page }) => {
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill('长卷')
  await page.getByRole('button', { name: '创建小说' }).click()
  await page.getByRole('textbox', { name: '章节正文' }).fill(Array.from({ length: 80 }, (_, line) => `第 ${line + 1} 行。`).join('\n'))
  await page.evaluate(() => window.scrollBy(0, innerHeight))
  expect(await page.evaluate(() => scrollY)).toBe(0)
  await page.locator('.editor-scroll').evaluate((node) => node.scrollBy(0, innerHeight))
  expect(await page.locator('.editor-scroll').evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.querySelector('#app-sidebar').getBoundingClientRect().top)).toBe(0)
  await expect(page.locator('.site-footer')).toBeInViewport()
  await expect(page.locator('.editor-toolbar')).toBeInViewport()
})
