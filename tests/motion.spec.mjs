import { expect, test } from './app-test.mjs'
import { newWritingNovel } from './writing-motion-helpers.mjs'

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

test('快速从首页进入作品时清理上一页的动画，返回后首页标题始终可见', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  await newWritingNovel(page, '切换测试')
  const workHash = new URL(page.url()).hash
  await page.locator('.brand').click()
  await expect(page.getByRole('heading', { name: '我的小说书库' })).toBeVisible()

  const inWork = await page.evaluate(async (hash) => {
    function navigate(target) {
      return new Promise((resolve) => {
        addEventListener('hashchange', () => queueMicrotask(resolve), { once: true })
        location.hash = target
      })
    }
    const home = document.querySelector('.home-head')
    await navigate('#/original')
    const flying = document.querySelector('.name-ghost')
    flying.getAnimations()[0].pause()
    const shelf = document.querySelector('.shelf-page')
    await navigate(hash)
    return {
      home: home.isConnected,
      shelf: shelf.isConnected,
      flying: flying.isConnected,
      reader: Boolean(document.querySelector('.reader-page')),
    }
  }, workHash)
  expect(inWork).toEqual({ home: false, shelf: false, flying: false, reader: true })
  await expect(page.getByRole('textbox', { name: '章节正文' })).toBeVisible()

  const back = await page.evaluate(async () => {
    const main = document.querySelector('#main')
    await new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!main.querySelector('.home-intro h1')) return
        observer.disconnect()
        resolve()
      })
      observer.observe(main, { childList: true })
      location.hash = '#/'
    })
    const title = main.querySelector('.home-intro h1')
    const frames = []
    for (let i = 0; i < 3; i++) {
      await new Promise(requestAnimationFrame)
      const bounds = title.getBoundingClientRect()
      frames.push({
        titleOpacity: Number(getComputedStyle(title).opacity),
        pageOpacity: Number(getComputedStyle(title.closest('.home')).opacity),
        titleOnTop: document.elementFromPoint(bounds.left + 5, bounds.top + bounds.height / 2) === title,
        oldView: Boolean(main.querySelector('.reader-page') || document.querySelector('.name-ghost')),
      })
    }
    return frames
  })
  for (const frame of back) expect(frame).toEqual({ titleOpacity: 1, pageOpacity: 1, titleOnTop: true, oldView: false })
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
  await page.keyboard.press('Escape')
  await page.goBack()
  await expect(page.getByRole('heading', { name: '我的小说书库' })).toBeVisible()
  await expect(page.locator('.shelf-page, .name-ghost')).toHaveCount(0)
  expect(await running(page)).toBe(0)
})
