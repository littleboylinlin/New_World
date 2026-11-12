import { expect, test } from './app-test.mjs'

const desktopState = () => {
  let mode = 'quit'
  window.newWorldDesktop = {
    downloadUpdate: async () => ({ ok: true }),
    installUpdate: async () => ({ ok: true }),
    onUpdateProgress: () => {},
    savePdf: async () => {},
    onCloseRequested: () => {},
    getStorageLocation: async () => ({ path: 'C:\\书库', defaultPath: 'C:\\书库', custom: false }),
    setStorageLocation: async () => null,
    resetStorageLocation: async () => null,
    getCloseBehavior: async () => mode,
    setCloseBehavior: async (next) => { mode = next; return mode },
  }
}

test('主要设置集中在同一列表，Web 端说明浏览器管理的项目', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 640 })
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  const list = dialog.getByRole('list', { name: '主要设置' })
  await expect(list.getByRole('listitem')).toHaveCount(3)
  await expect(list.getByRole('heading', { level: 3 })).toHaveText(['关闭窗口时', '存储位置', '帮助与更新'])
  await expect(page.locator('dialog[open]')).toHaveCount(1)
  await expect(page.locator('.site-header').getByRole('button')).toHaveText(['设置'])
  await expect(page.locator('.site-footer').getByRole('button')).toHaveCount(0)
  await expect(dialog.getByRole('radiogroup', { name: '关闭窗口时' })).toBeHidden()
  await expect(dialog.locator('.settings-badge')).toHaveText('浏览器托管')
  await expect(dialog.locator('.settings-state')).toHaveText('关闭窗口由当前浏览器管理')
  await dialog.getByRole('button', { name: '检查更新' }).scrollIntoViewIfNeeded()
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('home-settings-mobile.png') })
  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused()
})

test('桌面端可切换留后台并改回完全退出，设置会被记住', async ({ page }, testInfo) => {
  await page.route('**/releases?*', (route) => route.fulfill({ status: 404, json: {} }))
  await page.addInitScript(desktopState)
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  const quit = dialog.getByRole('radio', { name: '完全退出' })
  const background = dialog.getByRole('radio', { name: '留后台' })
  await expect(quit).toBeChecked()
  await expect(background).not.toBeChecked()

  await background.check()
  await expect(background).toBeChecked()
  await expect(dialog.locator('.settings-state')).toHaveText('已保存')
  await dialog.getByRole('button', { name: '关闭' }).click()

  await page.getByRole('button', { name: '设置' }).click()
  await expect(dialog.getByRole('radio', { name: '留后台' })).toBeChecked()
  await dialog.getByRole('radio', { name: '完全退出' }).check()
  await expect(dialog.getByRole('radio', { name: '完全退出' })).toBeChecked()
  await expect(dialog.locator('.settings-state')).toHaveText('已保存')
  await page.screenshot({ path: testInfo.outputPath('home-settings-desktop.png') })
})

test('关闭方式保存失败时保留原选项，其他设置仍可操作', async ({ page }) => {
  await page.route('**/releases?*', (route) => route.fulfill({ status: 404, json: {} }))
  await page.addInitScript(desktopState)
  await page.goto('/')
  await page.evaluate(() => {
    window.newWorldDesktop.setCloseBehavior = async () => { throw new Error('设置未能保存，请重试。') }
  })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.getByRole('radio', { name: '留后台' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('设置未能保存，请重试。')
  await expect(dialog.getByRole('radio', { name: '完全退出' })).toBeChecked()
  await expect(dialog.getByRole('button', { name: '更改位置' })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: '检查更新' })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})
