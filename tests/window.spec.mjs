import { expect, test } from './app-test.mjs'

test('桌面版页眉固定在窗口顶部，页面在页眉下方滚动', async ({ page }) => {
  await page.addInitScript(() => {
    window.newWorldDesktop = {
      downloadUpdate: async () => ({ ok: true }),
      installUpdate: async () => ({ ok: true }),
      onUpdateProgress: () => {},
      savePdf: async () => {},
      onCloseRequested: () => {},
      getStorageLocation: async () => ({ path: 'C:\\书库', defaultPath: 'C:\\书库', custom: false }),
      setStorageLocation: async () => null,
      resetStorageLocation: async () => null,
    }
  })
  await page.goto('/#/original')
  await page.getByRole('button', { name: '新建小说' }).click()
  await page.getByRole('textbox', { name: '作品名' }).fill('长卷')
  await page.getByRole('button', { name: '创建小说' }).click()
  await page.getByRole('textbox', { name: '章节正文' }).fill(Array.from({ length: 80 }, (_, line) => `第 ${line + 1} 行。`).join('\n'))
  await page.locator('.site-footer').scrollIntoViewIfNeeded()

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
  await expect(page.getByRole('heading', { name: '我的小说书库' })).toBeVisible()
  expect((await position()).page).toBe(0)
})

test('Web 端页眉随页面滚动', async ({ page }) => {
  await page.goto('/#/original')
  await page.getByRole('button', { name: '新建小说' }).click()
  await page.getByRole('textbox', { name: '作品名' }).fill('长卷')
  await page.getByRole('button', { name: '创建小说' }).click()
  await page.getByRole('textbox', { name: '章节正文' }).fill(Array.from({ length: 80 }, (_, line) => `第 ${line + 1} 行。`).join('\n'))
  await page.locator('.site-footer').scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.querySelector('.site-header').getBoundingClientRect().top)).toBeLessThan(0)
})
