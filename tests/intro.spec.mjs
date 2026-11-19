import { expect, test } from './app-test.mjs'

// The desktop app opens its first window at ?intro; the web build serves the same page, so the
// intro can be exercised here. Other windows and later loads never carry the flag.
const intro = (page) => page.locator('.nw-intro')

test('冷启动开场动画打出名字、播完后移除自己并清掉启动标记', async ({ page }) => {
  await page.goto('/?intro')
  await expect(intro(page)).toBeAttached()
  await expect(intro(page)).toContainText('New World')
  await expect(page).toHaveURL(/\/$/)
  await expect(intro(page)).toHaveCount(0, { timeout: 8000 })
  await expect(page.locator('main')).toBeVisible()
  await page.reload()
  await expect(intro(page)).toHaveCount(0)
})

test('按任意键可跳过开场动画', async ({ page }) => {
  await page.goto('/?intro')
  await expect(intro(page)).toBeAttached()
  await page.waitForFunction(() => document.querySelector('.app-column main')?.children.length > 0)
  await page.keyboard.press('Space')
  await expect(intro(page)).toHaveCount(0, { timeout: 1000 })
})

test('点击可跳过开场动画', async ({ page }) => {
  await page.goto('/?intro')
  await page.waitForFunction(() => document.querySelector('.app-column main')?.children.length > 0)
  await page.mouse.click(40, 40)
  await expect(intro(page)).toHaveCount(0, { timeout: 1000 })
})

test('系统减少动态效果时不播放开场动画', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?intro')
  await expect(page.locator('main')).toBeVisible()
  await expect(intro(page)).toHaveCount(0)
})

test('设置里关掉开场动画后不再播放', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('new-world:appearance', JSON.stringify({ intro: false })))
  await page.goto('/?intro')
  await expect(page.locator('main')).toBeVisible()
  await expect(intro(page)).toHaveCount(0)
})

test('没有启动标记时不播放开场动画', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('main')).toBeVisible()
  await expect(intro(page)).toHaveCount(0)
})
