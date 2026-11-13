import { expect, test } from './app-test.mjs'

test.use({ locale: 'en-US' })

const languageRequests = (page) => {
  const requests = []
  page.on('request', (request) => {
    const match = request.url().match(/New-World-lang-(en|zh-CN)\.json$/)
    if (match) requests.push(match[1])
  })
  return requests
}

test('英语系统只获取英语，首页、导入错误和设置均为英文，缓存可离线重用', async ({ page }, testInfo) => {
  const requests = languageRequests(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'My novel library' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  expect(requests).toEqual(['en'])
  await page.screenshot({ path: testInfo.outputPath('home-english-mobile.png') })
  await page.getByRole('link', { name: 'Open Original library', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) })
  await expect(page.locator('.import-notice')).toContainText('The file is empty.')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('heading', { level: 3 })).toHaveText(['Language', 'Appearance', 'Quick notes', 'When closing the window', 'Storage location', 'Backups', 'Help and updates'])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('home-english-settings.png') })
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await page.route('**/locales/New-World-lang-*.json', (route) => route.abort())
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Original library', exact: true })).toBeVisible()
  expect(requests).toEqual(['en'])
})

test('切换失败保留原语言，成功后保存正文、保留章节名称并记住选择', async ({ page }) => {
  const requests = languageRequests(page)
  await page.goto('/#/original')
  await page.getByRole('button', { name: 'New novel', exact: true }).click()
  await page.getByRole('textbox', { name: 'Work title' }).fill('My unchanged novel')
  await page.getByRole('button', { name: 'Create novel' }).click()
  const editor = page.getByRole('textbox', { name: 'Chapter text', exact: true })
  await editor.fill('Text saved before switching. 原文不翻译。')
  const url = page.url()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  let settings = page.getByRole('dialog', { name: 'Settings' })
  await page.route('**/New-World-lang-zh-CN.json', (route) => route.fulfill({ status: 503, body: 'offline' }))
  await settings.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN')
  await settings.getByRole('button', { name: 'Apply language' }).click()
  await expect(settings.getByRole('alert')).toContainText('Your current language has been kept.')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(settings.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('en')
  await page.unroute('**/New-World-lang-zh-CN.json')
  await settings.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN')
  await Promise.all([page.waitForEvent('load'), settings.getByRole('button', { name: 'Apply language' }).click()])
  settings = page.getByRole('dialog', { name: '设置' })
  await expect(settings).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page).toHaveURL(url)
  await expect(page.getByRole('textbox', { name: '章节正文', exact: true })).toHaveText('Text saved before switching. 原文不翻译。')
  await expect(page.locator('.chapter-jump').first()).toContainText('Chapter 1')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await settings.getByRole('combobox', { name: '语言', exact: true }).selectOption('en')
  await page.route('**/New-World-lang-en.json', (route) => route.abort())
  await Promise.all([page.waitForEvent('load'), settings.getByRole('button', { name: '应用语言' }).click()])
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  expect(requests).toEqual(['en', 'zh-CN', 'zh-CN'])
})

test('语言切换前保存失败时保留当前正文，且不请求另一种语言', async ({ page }) => {
  const requests = languageRequests(page)
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'chapters' && window.storageFull) throw new DOMException('test', 'QuotaExceededError')
      return put.apply(this, args)
    }
  })
  await page.goto('/#/original')
  await page.getByRole('button', { name: 'New novel', exact: true }).click()
  await page.getByRole('textbox', { name: 'Work title' }).fill('A protected draft')
  await page.getByRole('button', { name: 'Create novel' }).click()
  const editor = page.getByRole('textbox', { name: 'Chapter text', exact: true })
  await editor.fill('Saved text.')
  await page.getByRole('button', { name: 'Save now' }).click()
  await expect(page.locator('.save-status')).toHaveText('Saved')
  await page.evaluate(() => { window.storageFull = true })
  await editor.fill('Unsaved text must remain.')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN')
  await settings.getByRole('button', { name: 'Apply language' }).click()
  await expect(settings.getByRole('alert')).toHaveText('Save the current text or a separate copy before changing languages.')
  expect(requests).toEqual(['en'])
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(editor).toHaveText('Unsaved text must remain.')
})

test.describe('中文系统', () => {
  test.use({ locale: 'zh-TW' })
  test('匹配简体中文语言包而不获取英语', async ({ page }) => {
    const requests = languageRequests(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '我的小说书库' })).toBeVisible()
    expect(requests).toEqual(['zh-CN'])
  })
})
