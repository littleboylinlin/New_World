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

const downloads = (page) => page.locator('#downloads a.btn')

test.describe('download button', () => {
  test('Windows gets the x64 installer', async ({ browser }) => {
    const page = await openAs(browser, AGENTS.windows, { platform: 'Windows' })
    await expect(downloads(page)).toHaveCount(1)
    await expect(downloads(page)).toHaveAttribute('href', '/download/windows')
    await expect(downloads(page)).toHaveAttribute('data-sha256', latest.assets['windows-x64'].sha256)
  })

  test('Apple silicon gets the arm64 DMG', async ({ browser }) => {
    const page = await openAs(browser, AGENTS.macChrome, { platform: 'macOS', architecture: 'arm' })
    await expect(downloads(page)).toHaveCount(1)
    await expect(downloads(page)).toHaveAttribute('href', '/download/macos-arm64')
  })

  test('Intel Macs get the x64 DMG', async ({ browser }) => {
    const page = await openAs(browser, AGENTS.macChrome, { platform: 'macOS', architecture: 'x86' })
    await expect(downloads(page)).toHaveCount(1)
    await expect(downloads(page)).toHaveAttribute('href', '/download/macos-x64')
  })

  test('a Mac with an unknown chip sees both DMGs', async ({ browser }) => {
    const page = await openAs(browser, AGENTS.macSafari)
    await expect(downloads(page)).toHaveCount(2)
    await expect(downloads(page).nth(0)).toHaveAttribute('href', '/download/macos-arm64')
    await expect(downloads(page).nth(1)).toHaveAttribute('href', '/download/macos-x64')
    await expect(downloads(page).nth(0)).toContainText('Apple 芯片', { useInnerText: true })
    await expect(downloads(page).nth(1)).toContainText('Intel 芯片', { useInnerText: true })
  })

  test('each button names both sources in a small line under it', async ({ browser }) => {
    const page = await openAs(browser, AGENTS.macSafari)
    const sources = page.locator('#downloads .download-source')
    await expect(sources).toHaveCount(2)
    await expect(sources.nth(0)).toHaveText('从 国内镜像 · GitHub 下载', { useInnerText: true })
    await expect(sources.nth(0).getByRole('link', { name: '国内镜像' })).toHaveAttribute('href', '/download/macos-arm64?from=mirror')
    await expect(sources.nth(0).getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', '/download/macos-arm64?from=github')
    await expect(sources.nth(1).getByRole('link', { name: '国内镜像' })).toHaveAttribute('href', '/download/macos-x64?from=mirror')
  })

  test('a platform missing from the release keeps the release page button', async ({ browser }) => {
    const context = await browser.newContext({ userAgent: AGENTS.windows, locale: 'zh-CN' })
    await context.route('**/', async (route) => {
      const response = await route.fetch()
      const body = (await response.text()).replace(/"windows-x64":\{[^}]*\},?/, '')
      await route.fulfill({ response, body })
    })
    const page = await context.newPage()
    await page.goto('/')
    await expect(downloads(page)).toHaveCount(1)
    await expect(downloads(page)).toHaveAttribute('href', latest.releaseUrl)
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

test.describe('download routes', () => {
  const MIRROR = 'https://dl.writenewworld.com/v9.8.7/'
  const GITHUB = 'https://github.com/littleboylinlin/New_World/releases/download/v9.8.7/'
  const envWith = (manifest) => ({
    ASSETS: {
      fetch: async (request) => new URL(request.url ?? request).pathname === '/latest.json'
        ? new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } })
        : new Response('not found', { status: 404 }),
    },
  })
  const env = envWith(latest)
  const visit = (path, country) => {
    const request = new Request(`https://writenewworld.com${path}`)
    if (country !== undefined) Object.defineProperty(request, 'cf', { value: { country } })
    return worker.fetch(request, env)
  }

  const files = {
    windows: 'New-World-Setup-9.8.7-x64.exe',
    'macos-arm64': 'New-World-9.8.7-macos-arm64.dmg',
    'macos-x64': 'New-World-9.8.7-macos-x64.dmg',
    'lang-zh-CN': 'New-World-lang-zh-CN.json',
    'lang-en': 'New-World-lang-en.json',
  }

  for (const [platform, name] of Object.entries(files)) {
    test(`/download/${platform}: mainland China gets the mirror, elsewhere GitHub`, async () => {
      const china = await visit(`/download/${platform}`, 'CN')
      expect(china.status).toBe(302)
      expect(china.headers.get('Location')).toBe(MIRROR + name)
      expect(china.headers.get('Cache-Control')).toBe('no-store')
      for (const country of ['US', 'HK', 'TW', 'JP', 'DE']) {
        const other = await visit(`/download/${platform}`, country)
        expect(other.status, country).toBe(302)
        expect(other.headers.get('Location'), country).toBe(GITHUB + name)
      }
      // Without Cloudflare's country (a local preview), GitHub.
      expect((await visit(`/download/${platform}`)).headers.get('Location')).toBe(GITHUB + name)
    })
  }

  test('?from= picks the source whatever the region; other values are ignored', async () => {
    expect((await visit('/download/windows?from=github', 'CN')).headers.get('Location')).toBe(GITHUB + files.windows)
    expect((await visit('/download/windows?from=mirror', 'US')).headers.get('Location')).toBe(MIRROR + files.windows)
    expect((await visit('/download/windows?from=elsewhere', 'CN')).headers.get('Location')).toBe(MIRROR + files.windows)
    expect((await visit('/download/windows?from=elsewhere', 'US')).headers.get('Location')).toBe(GITHUB + files.windows)
    expect((await visit('/download/windows/', 'US')).headers.get('Location')).toBe(GITHUB + files.windows)
  })

  test('a platform missing from latest.json gets a friendly 404', async () => {
    const { ['macos-x64']: _missing, ...assets } = latest.assets
    const response = await worker.fetch(Object.defineProperty(new Request('https://writenewworld.com/download/macos-x64'), 'cf', { value: { country: 'CN' } }), envWith({ ...latest, assets }))
    expect(response.status).toBe(404)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(response.headers.get('Location')).toBeNull()
    const page = await response.text()
    expect(page).toContain('当前版本没有这个下载')
    expect(page).toContain('https://github.com/littleboylinlin/New_World/releases')
    expect(page).toContain('href="/"')
  })

  test('unknown platforms, a bare /download and a broken latest.json also get the 404', async () => {
    for (const path of ['/download', '/download/', '/download/linux', '/download/windows-x64', '/download/windows/extra']) {
      expect((await visit(path, 'US')).status, path).toBe(404)
    }
    const broken = { ...latest, tag: 'not-a-tag' }
    expect((await worker.fetch(new Request('https://writenewworld.com/download/windows'), envWith(broken))).status).toBe(404)
    const failing = { ASSETS: { fetch: async () => new Response('gone', { status: 500 }) } }
    expect((await worker.fetch(new Request('https://writenewworld.com/download/windows'), failing)).status).toBe(404)
  })

  test('the local preview redirects too', async ({ request }) => {
    const response = await request.get('/download/windows', { maxRedirects: 0 })
    expect(response.status()).toBe(302)
    expect(response.headers().location).toMatch(/^https:\/\/(github\.com\/littleboylinlin\/New_World\/releases\/download|dl\.writenewworld\.com)\/v9\.8\.7\/New-World-Setup-9\.8\.7-x64\.exe$/)
    const missing = await request.get('/download/linux', { maxRedirects: 0 })
    expect(missing.status()).toBe(404)
  })
})
