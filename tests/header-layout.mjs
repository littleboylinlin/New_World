import { expect } from '@playwright/test'

export function headerProblems(page) {
  return page.evaluate(() => {
    const header = document.querySelector('.header-inner')
    const bounds = header.getBoundingClientRect()
    const style = getComputedStyle(header)
    const left = bounds.left + parseFloat(style.paddingLeft)
    const right = bounds.right - parseFloat(style.paddingRight)
    const problems = []
    let previousRight = left
    for (const selector of ['.brand', '.local-label', '#trash-link']) {
      const node = header.querySelector(selector)
      if (!node.getClientRects().length) continue
      const box = node.getBoundingClientRect()
      if (box.left < previousRight - 1 || box.right > right + 1) problems.push(`${selector} overlaps an item or window controls`)
      const text = document.createRange()
      text.selectNodeContents(node)
      const textBox = text.getBoundingClientRect()
      if (textBox.width && (textBox.left < box.left - 1 || textBox.right > box.right + 1)) problems.push(`${selector} text overflows`)
      previousRight = box.right
    }
    const footer = document.querySelector('.footer-inner')
    const settings = footer.querySelector('#settings')
    const meta = footer.querySelector('.footer-meta')
    if (!settings) problems.push('#settings missing in footer')
    else {
      const sBox = settings.getBoundingClientRect()
      const fBox = footer.getBoundingClientRect()
      if (sBox.left < fBox.left - 1 || sBox.top < 0 || sBox.bottom > innerHeight + 1) problems.push('#settings out of footer bounds')
      if (meta && sBox.right > meta.getBoundingClientRect().left + 1) problems.push('#settings overlaps footer metadata')
    }
    if (document.documentElement.classList.contains('desktop') && bounds.height > 47) problems.push('The title bar wraps')
    if (document.documentElement.scrollWidth > innerWidth) problems.push('The page overflows horizontally')
    return problems
  })
}

export async function expectHeaderLayout(page) {
  await expect.poll(() => headerProblems(page)).toEqual([])
}

export async function checkSettingsLayout(page) {
  const english = await page.locator('html').getAttribute('lang') === 'en'
  await page.getByRole('link', { name: english ? 'Settings' : '设置', exact: true }).click()
  const settingsPage = page.locator('.settings-page')
  await expect(settingsPage).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await settingsPage.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await settingsPage.locator('.settings-back').click()
  await expect(settingsPage).toBeHidden()
}

export async function checkNativeHeader(app, page, info, prefix) {
  const original = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
  const locale = await page.locator('html').getAttribute('lang')
  try {
    for (const width of [1024, 820, 720, 641, 640, 480]) {
      const [contentWidth, contentHeight] = await app.evaluate(({ BrowserWindow, screen }, width) => {
        const window = BrowserWindow.getAllWindows()[0]
        const available = screen.getDisplayMatching(window.getBounds()).workAreaSize
        window.setSize(Math.min(width, available.width), Math.min(width === 480 ? 420 : 650, available.height))
        return window.getContentSize()
      }, width)
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([contentWidth, contentHeight])
      await expectHeaderLayout(page)
      await expect(page.getByRole('link', { name: locale === 'en' ? 'Trash' : '回收站', exact: true })).toBeVisible()
      if ([1024, 641, 480].includes(width)) {
        await page.screenshot({ path: info.outputPath(`${prefix}-header-${locale}-${width}.png`), animations: 'disabled' })
      }
      if (width === 480) await checkSettingsLayout(page)
    }
  } finally {
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), original)
  }
}
