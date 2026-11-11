import { expect, test } from './app-test.mjs'

const running = (page) => page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length)

test('页面跳转立即切换内容，新页面带进入动画，书库名飞到标题后落位', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: '进入原创库' })).toBeVisible()
  // The new page must be in place as soon as the address changes, before any animation ends.
  const swapped = await page.evaluate(() => new Promise((resolve) => {
    addEventListener('hashchange', () => queueMicrotask(() => resolve({
      heading: document.querySelector('.shelf-page h1')?.textContent,
      home: document.querySelectorAll('.shelf-card').length,
      enter: document.querySelector('#main').dataset.enter,
      ghost: document.querySelector('.name-ghost')?.dataset.text,
    })), { once: true })
    location.hash = '#/original'
  }))
  expect(swapped).toEqual({ heading: '原创库', home: 0, enter: 'forward', ghost: '原创库' })
  await expect(page.locator('.name-ghost')).toHaveCount(0)
  await expect(page.locator('.name-landing')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1, name: '原创库' })).toBeVisible()

  await page.goBack()
  await expect(page.getByRole('heading', { name: '我的小说书库' })).toBeVisible()
  expect(await page.locator('#main').getAttribute('data-enter')).toBe('back')
  await expect(page.locator('.name-ghost')).toHaveCount(0)
  await expect(page.getByRole('link', { name: '进入原创库' }).getByRole('heading', { name: '原创库' })).toBeVisible()
})

test('系统要求减少动态效果时不播放动画', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByRole('link', { name: '进入原创库' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '原创库' })).toBeVisible()
  expect(await page.locator('.name-ghost').count()).toBe(0)
  expect(await page.locator('#main').getAttribute('data-enter')).toBeNull()
  await page.getByRole('button', { name: '新建小说' }).click()
  await expect(page.getByRole('dialog', { name: '新建小说' })).toBeVisible()
  expect(await running(page)).toBe(0)
})
