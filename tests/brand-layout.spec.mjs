import { expect, test } from './app-test.mjs'
import { openDrawer } from './navigation-helpers.mjs'

const desktop = (platform) => {
  window.newWorldDesktop = {
    platform, arch: 'x64', onCloseRequested: () => {}, onUpdateProgress: () => {},
    minimizeWindow: () => {}, toggleMaximizeWindow: () => {}, closeWindow: () => {},
    isMaximized: async () => false, onMaximizeChange: () => {},
    getStorageLocation: async () => ({ path: '/Library/NewWorld', custom: false }),
    getCloseBehavior: async () => 'quit',
  }
}

const rect = (page, selector) => page.locator(selector).first().evaluate((node) => {
  const box = node.getBoundingClientRect(), style = getComputedStyle(node)
  return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, display: style.display, visibility: style.visibility, opacity: Number(style.opacity), text: node.innerText, font: style.fontFamily, weight: style.fontWeight, size: parseFloat(style.fontSize) }
})

async function settle(page) {
  await page.evaluate(() => Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished)))
}

for (const platform of ['win32', 'darwin']) {
  test(`桌面版（${platform}）顶栏只留图标，名字在侧栏收起按钮左边，收起时平滑隐藏 @webkit`, async ({ page }) => {
    await page.addInitScript(desktop, platform)
    await page.route('https://api.github.com/**', (route) => route.fulfill({ json: [] }))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.setViewportSize({ width: 1220, height: 720 })
    await page.goto('/')
    await expect(page.locator('#sidebar-toggle')).toBeEnabled()
    await settle(page)

    // Title bar: the icon alone, clear of the window buttons, and still a drag region.
    const header = await rect(page, '.site-header')
    const brand = await rect(page, '.site-header .brand')
    const icon = await rect(page, '.site-header .brand img')
    expect(await rect(page, '.site-header .brand-name')).toMatchObject({ display: 'none', width: 0 })
    expect(icon.width).toBeCloseTo(28, 0)
    expect(icon.height).toBeCloseTo(28, 0)
    expect(brand.width).toBeLessThan(icon.width + 2)
    expect(await page.locator('.site-header').innerText()).not.toMatch(/new world/i)
    expect(icon.top).toBeGreaterThanOrEqual(header.top)
    expect(icon.bottom).toBeLessThanOrEqual(header.top + 46)
    if (platform === 'darwin') {
      // The traffic lights occupy the first ~70px of the title bar.
      expect(brand.left).toBeGreaterThanOrEqual(80)
    } else {
      const controls = await rect(page, '.window-controls')
      expect(controls.width).toBeCloseTo(3 * 46, 0)
      expect(controls.right).toBeCloseTo(1220, 0)
      expect(brand.right).toBeLessThan(controls.left)
    }
    if (test.info().project.name === 'chromium') {
      expect(await page.locator('.site-header').evaluate((node) => getComputedStyle(node).getPropertyValue('-webkit-app-region'))).toBe('drag')
      expect(await page.locator('.site-header .brand').evaluate((node) => getComputedStyle(node).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
    }

    // Sidebar: the name in the brand font, left of the collapse button, on the same line.
    const sidebar = await rect(page, '#app-sidebar')
    const name = await rect(page, '.sidebar-top .brand-name')
    const toggle = await rect(page, '#sidebar-toggle')
    expect(await rect(page, '.sidebar-top img')).toMatchObject({ display: 'none', width: 0 })
    expect(sidebar.width).toBeCloseTo(210, 0)
    expect(name.text).toBe('NEW WORLD')
    expect(name.font).toContain('Arial Black')
    expect(name.weight).toBe('900')
    expect(name.width).toBeGreaterThan(70)
    expect(name.width).toBeLessThan(toggle.left - sidebar.left)
    expect(name.height).toBeGreaterThan(12)
    expect(name.height).toBeLessThan(32)
    expect(name.left).toBeGreaterThanOrEqual(sidebar.left + 12)
    expect(name.right).toBeLessThanOrEqual(toggle.left)
    expect(Math.abs((name.top + name.bottom) / 2 - (toggle.top + toggle.bottom) / 2)).toBeLessThan(2)
    expect(toggle.width).toBeCloseTo(32, 0)
    expect(toggle.right).toBeCloseTo(sidebar.right - 3 - 12, 0)

    // Collapsing narrows the name to nothing over the rail's 180ms transition, then hides it.
    const transitions = await page.evaluate(() => {
      const node = document.querySelector('.sidebar-top .brand-name')
      document.querySelector('#sidebar-toggle').click()
      return node.getAnimations().map((animation) => ({ property: animation.transitionProperty, duration: animation.effect.getTiming().duration }))
    })
    expect(transitions).toEqual(expect.arrayContaining([{ property: 'max-width', duration: 180 }, { property: 'opacity', duration: 140 }]))
    await settle(page)
    const collapsed = await rect(page, '#app-sidebar')
    const hidden = await rect(page, '.sidebar-top .brand-name')
    const centred = await rect(page, '#sidebar-toggle')
    expect(collapsed.width).toBeCloseTo(72, 0)
    expect(hidden.width).toBeLessThan(.5)
    expect(hidden.visibility).toBe('hidden')
    expect(Math.abs((centred.left + centred.right) / 2 - (collapsed.left + collapsed.right - 3) / 2)).toBeLessThan(1)
    await expect(page.locator('.sidebar-top .brand-name')).toBeHidden()

    await page.locator('#sidebar-toggle').click()
    await settle(page)
    const back = await rect(page, '.sidebar-top .brand-name')
    expect(back.width).toBeCloseTo(name.width, 0)
    expect(back.visibility).toBe('visible')
    expect(back.opacity).toBe(1)

    // A narrow window: the drawer carries the name; the title bar still shows only the icon.
    await page.setViewportSize({ width: 600, height: 640 })
    await openDrawer(page)
    const drawer = await rect(page, '#app-sidebar')
    const drawerName = await rect(page, '.sidebar-top .brand-name')
    expect(await rect(page, '#sidebar-toggle')).toMatchObject({ display: 'none' })
    expect(drawerName.text).toBe('NEW WORLD')
    expect(drawerName.width).toBeGreaterThan(70)
    expect(drawerName.left).toBeGreaterThanOrEqual(drawer.left)
    expect(drawerName.right).toBeLessThanOrEqual(drawer.right)
    expect(await rect(page, '.site-header .brand-name')).toMatchObject({ display: 'none' })
  })
}

test('网页版宽屏侧栏顶部仍是图标加名字，收起时只留按钮 @webkit', async ({ page }) => {
  await page.setViewportSize({ width: 1220, height: 720 })
  await page.goto('/')
  await expect(page.locator('#sidebar-toggle')).toBeEnabled()
  await settle(page)
  expect(await rect(page, '.site-header')).toMatchObject({ display: 'none' })
  const icon = await rect(page, '.sidebar-top img')
  const name = await rect(page, '.sidebar-top .brand-name')
  expect(icon.width).toBeCloseTo(32, 0)
  expect(name.text).toBe('NEW WORLD')
  expect(name.left).toBeGreaterThan(icon.right)
  await page.locator('#sidebar-toggle').click()
  await settle(page)
  expect(await rect(page, '.sidebar-top img')).toMatchObject({ display: 'none' })
  expect(await rect(page, '.sidebar-top .brand-name')).toMatchObject({ display: 'none' })
})

test.describe('iPhone 尺寸 @webkit', () => {
  test.use({
    viewport: { width: 390, height: 664 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true,
  })

  test('手机抽屉撑满顶栏以下的高度，入口都在屏内', async ({ page }) => {
    await page.goto('/')
    const menu = page.getByRole('button', { name: '打开导航' })
    await expect(menu).toBeEnabled()
    await menu.click()
    await expect(page.locator('#settings')).toBeVisible()
    await settle(page)
    const height = await page.evaluate(() => innerHeight)
    const header = await rect(page, '.site-header')
    const drawer = await rect(page, '#app-sidebar')
    expect(drawer.top).toBeCloseTo(52, 0)
    expect(header.bottom).toBeCloseTo(drawer.top, 0)
    expect(drawer.bottom).toBeCloseTo(height, 0)
    expect(drawer.height).toBeCloseTo(height - 52, 0)
    expect(drawer.width).toBeCloseTo(Math.min(264, 390 * .82), 0)
    const settings = await rect(page, '#settings')
    expect(settings.height).toBeGreaterThanOrEqual(43)
    expect(settings.bottom).toBeLessThanOrEqual(height)
    expect(settings.left).toBeGreaterThanOrEqual(drawer.left)
    expect(settings.right).toBeLessThanOrEqual(drawer.right)
  })
})
