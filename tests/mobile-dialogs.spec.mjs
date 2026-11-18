import { expect, test } from './app-test.mjs'
import { newWritingNovel } from './writing-motion-helpers.mjs'

test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })

async function expectReachable(control) {
  await control.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }))
  await expect.poll(() => control.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const viewport = window.visualViewport
    const { offsetTop, offsetLeft, width, height } = viewport
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return rect.width > 0 && rect.height > 0 && rect.top >= offsetTop && rect.left >= offsetLeft
      && rect.bottom <= offsetTop + height && rect.right <= offsetLeft + width && node.contains(hit)
  })).toBe(true)
}

test('iPhone 作品信息弹窗缩高后仍能通过内部滚动点到保存 @webkit', async ({ page }) => {
  await page.goto('/')
  await newWritingNovel(page, '潮汐')
  await page.getByRole('button', { name: '编辑作品信息', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑作品信息', exact: true })
  await dialog.getByLabel('作者', { exact: true }).fill('海边写作者')
  await page.setViewportSize({ width: 390, height: 430 })
  await expect.poll(() => dialog.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(0)
  const save = dialog.getByRole('button', { name: '保存作品信息', exact: true })
  await expectReachable(save)
  await save.tap()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('region', { name: '作品信息', exact: true })).toContainText('海边写作者')
})

test('iPhone 速记弹窗缩高后仍能点到保存 @webkit', async ({ page }) => {
  await page.goto('/#/ideas')
  await page.getByRole('textbox', { name: '灵感', exact: true }).waitFor()
  await page.keyboard.press('Control+Alt+n')
  const dialog = page.getByRole('dialog', { name: '记灵感' })
  await dialog.getByRole('textbox', { name: '灵感', exact: true }).fill('从海边寄来的信')
  await page.setViewportSize({ width: 390, height: 300 })
  const save = dialog.locator('button[type=submit]')
  await expectReachable(save)
  await save.tap()
  await expect(dialog).toBeHidden()
  await expect(page.locator('.idea-row').filter({ hasText: '从海边寄来的信' })).toHaveCount(1)
})

test('iPhone 设置页可以滚动到外观设置底部并切换开关 @webkit', async ({ page }) => {
  await page.goto('/#/settings/appearance')
  const radio = page.getByRole('radiogroup', { name: '拼写检查' }).getByRole('radio', { name: '开启', exact: true })
  const option = radio.locator('..')
  await expect(radio).not.toBeChecked()
  await expectReachable(option)
  await option.tap()
  await expect(radio).toBeChecked()
})
