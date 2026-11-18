import { startWork } from './navigation-helpers.mjs'
import { expect, test } from './app-test.mjs'

test('桌面版页眉固定在窗口顶部，页面在页眉下方滚动', async ({ page }) => {
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
    const pageEl = document.querySelector('#page')
    pageEl.scrollTop = pageEl.scrollHeight
  })

  const position = () => page.evaluate(() => ({
    header: document.querySelector('.site-header').getBoundingClientRect().top,
    page: document.querySelector('#page').scrollTop,
    window: scrollY,
  }))
  const scrolled = await position()
  expect(scrolled.header).toBe(0)
  expect(scrolled.window).toBe(0)
  expect(scrolled.page).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await page.getByRole('link', { name: 'New World 书库首页' }).click()
  await expect(page.getByRole('heading', { name: '写作统计' })).toBeVisible()
  expect((await position()).page).toBe(0)
})

test('Web 端长页面可滚动，侧栏留在视口内', async ({ page }) => {
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill('长卷')
  await page.getByRole('button', { name: '创建小说' }).click()
  await page.getByRole('textbox', { name: '章节正文' }).fill(Array.from({ length: 80 }, (_, line) => `第 ${line + 1} 行。`).join('\n'))
  await page.evaluate(() => window.scrollBy(0, innerHeight))
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.querySelector('#app-sidebar').getBoundingClientRect().top)).toBe(0)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await expect(page.locator('.site-footer')).toBeInViewport()
})
