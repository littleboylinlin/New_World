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

test('Web 端显示浏览器托管，隐藏两种关闭方式', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('radiogroup', { name: '关闭窗口时' })).toBeHidden()
  await expect(dialog.locator('.settings-badge')).toHaveText('浏览器托管')
  await expect(dialog.getByRole('status')).toHaveText('关闭窗口由当前浏览器管理')
  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(dialog).toBeHidden()
})

test('桌面端可切换留后台并改回完全退出，设置会被记住', async ({ page }) => {
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
  await expect(dialog.getByRole('status')).toHaveText('已保存')
  await dialog.getByRole('button', { name: '关闭' }).click()

  await page.getByRole('button', { name: '设置' }).click()
  await expect(dialog.getByRole('radio', { name: '留后台' })).toBeChecked()
  await dialog.getByRole('radio', { name: '完全退出' }).check()
  await expect(dialog.getByRole('radio', { name: '完全退出' })).toBeChecked()
  await expect(dialog.getByRole('status')).toHaveText('已保存')
})
