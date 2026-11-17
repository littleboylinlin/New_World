import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import worker from '../worker.js'

const latest = JSON.parse(readFileSync(new URL('./fixtures/latest.json', import.meta.url), 'utf-8'))

const AGENTS = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
}

async function openAs(browser, userAgent, hints) {
  const context = await browser.newContext({ userAgent, locale: 'zh-CN' })
  await context.addInitScript((value) => {
    const data = value && {
      platform: value.platform,
      getHighEntropyValues: async () => ({ architecture: value.architecture ?? '' }),
    }
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => data, configurable: true })
  }, hints ?? null)
  const page = await context.newPage()
  await page.goto('/')
  return page
}

const downloads = (page) => page.locator('#downloads a')

test.describe('download button', () => {
  test('Windows gets the x64 installer', async ({ browser }) => {
    const page = await openAs(browser, AGENTS.windows, { platform: 'Windows' })
    await expect(downloads(page)).toHaveCount(1)
    await expect(downloads(page)).toHaveAttribute('href', latest.assets['windows-x64'].url)
    await expect(downloads(page)).toHaveAttribute('data-sha256', latest.assets['windows-x64'].sha256)
  })

  test('Apple silicon gets the arm64 DMG', async ({ browser }) => {
    const page = await openAs(browser, AGENTS.macChrome, { platform: 'macOS', architecture: 'arm' })
    await expect(downloads(page)).toHaveCount(1)
    await expect(downloads(page)).toHaveAttribute('href', latest.assets['macos-arm64'].url)
  })

  test('Intel Macs get the x64 DMG', async ({ browser }) => {
    const page = await openAs(browser, AGENTS.macChrome, { platform: 'macOS', architecture: 'x86' })
    await expect(downloads(page)).toHaveCount(1)
    await expect(downloads(page)).toHaveAttribute('href', latest.assets['macos-x64'].url)
  })

  test('a Mac with an unknown chip sees both DMGs', async ({ browser }) => {
    const page = await openAs(browser, AGENTS.macSafari)
    await expect(downloads(page)).toHaveCount(2)
    await expect(downloads(page).nth(0)).toHaveAttribute('href', latest.assets['macos-arm64'].url)
    await expect(downloads(page).nth(1)).toHaveAttribute('href', latest.assets['macos-x64'].url)
    await expect(downloads(page).nth(0)).toContainText('Apple 芯片', { useInnerText: true })
    await expect(downloads(page).nth(1)).toContainText('Intel 芯片', { useInnerText: true })
  })

  test('other systems go to the release page', async ({ browser }) => {
    const page = await openAs(browser, AGENTS.linux, { platform: 'Linux' })
    await expect(downloads(page)).toHaveCount(1)
    await expect(downloads(page)).toHaveAttribute('href', latest.releaseUrl)
  })

  test('shows the version and release links', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-version]')).toHaveText(`v${latest.version}`)
    await expect(page.locator('[data-other]')).toHaveAttribute('href', latest.releaseUrl)
    await expect(page.locator('[data-all]')).toHaveAttribute('href', 'https://github.com/littleboylinlin/New_World/releases')
    await expect(page.locator('[data-online]')).toHaveAttribute('href', '/app/')
    const published = await (await page.request.get('/latest.json')).json()
    expect(published).toEqual(latest)
  })
})

test.describe('language', () => {
  test('follows the browser and can be switched', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'en-US' })
    const page = await context.newPage()
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('.lede')).toHaveText('A local novel manager and writing workbench', { useInnerText: true })
    await expect(page).toHaveTitle(/writing workbench/)

    await page.getByRole('button', { name: '中文' }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expect(page.locator('.lede')).toHaveText('本地小说管理器与写作工作台', { useInnerText: true })
    await expect(page).toHaveTitle(/写作工作台/)

    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await context.close()
  })

  test('Chinese browsers start in Chinese', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expect(page.getByRole('button', { name: 'English' })).toBeVisible()
    await expect(page.locator('.sheet-tag')).toContainText('第', { useInnerText: true })
  })
})

test.describe('motion', () => {
  test('the writing demo types and moves the caret', async ({ page }) => {
    await page.goto('/')
    const caret = page.locator('#demo-caret')
    const first = await caret.evaluate((node) => node.style.transform)
    await expect(page.locator('#demo-text .ch.on').first()).toBeAttached()
    await expect.poll(() => caret.evaluate((node) => node.style.transform)).not.toBe(first)
    expect(await page.evaluate(() => document.getAnimations().length)).toBeGreaterThan(0)
  })

  test('feature sheets stack one by one while scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    const panels = page.locator('.panel')
    await expect(panels).toHaveCount(4)
    await expect(panels.nth(0)).not.toHaveClass(/\bin\b/)

    await panels.nth(0).scrollIntoViewIfNeeded()
    await expect(panels.nth(0)).toHaveClass(/\bin\b/)
    await expect(panels.nth(0).locator('.pop').first()).toHaveCSS('opacity', '1')

    await page.evaluate(() => scrollTo(0, document.querySelector('.panel:nth-child(2)').offsetTop - 40))
    await expect(panels.nth(1)).toHaveClass(/\bin\b/)
    const scale = () => panels.nth(0).locator('.panel-card').evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).a)
    await expect.poll(scale).toBeLessThan(0.99)
  })

  test('reduced motion shows the final state without animations', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce', locale: 'zh-CN' })
    const page = await context.newPage()
    await page.goto('/')
    const total = await page.locator('#demo-text .ch').count()
    expect(total).toBeGreaterThan(20)
    await expect(page.locator('#demo-text .ch.on')).toHaveCount(total)
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
    await page.locator('.first-run').scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
    for (const selector of ['.title-word', '.lede', '.actions', '.demo', '.panel-card', '.panel .pop']) {
      await expect(page.locator(selector).first()).toHaveCSS('opacity', '1')
    }
    await context.close()
  })
})

test.describe('notice page', () => {
  test('is reachable and needs nothing else from the site', async ({ page }) => {
    const requests = []
    page.on('request', (request) => { if (!request.url().startsWith('data:')) requests.push(new URL(request.url()).pathname) })
    const response = await page.goto('/notice')
    expect(response.status()).toBe(200)
    await expect(page.locator('h1')).toHaveText('网络提示', { useInnerText: true })
    await expect(page.locator('p')).toContainText('切换网络节点', { useInnerText: true })
    expect(requests).toEqual(['/notice'])

    await page.getByRole('button', { name: 'English' }).click()
    await expect(page.locator('p')).toContainText('switch to another network node', { useInnerText: true })
  })
})

test.describe('worker', () => {
  const env = { ASSETS: { fetch: async () => new Response('ok', { headers: { 'Content-Type': 'text/plain' } }) } }

  test('redirects www to the main domain', async () => {
    const response = await worker.fetch(new Request('https://www.writenewworld.com/notice?x=1'), env)
    expect(response.status).toBe(301)
    expect(response.headers.get('Location')).toBe('https://writenewworld.com/notice?x=1')
  })

  test('serves assets on the main domain', async () => {
    const response = await worker.fetch(new Request('https://writenewworld.com/'), env)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})
