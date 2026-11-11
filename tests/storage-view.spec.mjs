import { expect, test } from './app-test.mjs'

const desktopState = () => {
  let custom = false
  const defaultPath = 'C:\\Users\\lin\\AppData\\Roaming\\NewWorld'
  const chosen = 'D:\\我的书库\\New World'
  window.newWorldDesktop = {
    downloadUpdate: async () => ({ ok: true }),
    installUpdate: async () => ({ ok: true }),
    onUpdateProgress: () => {},
    savePdf: async () => {},
    onCloseRequested: () => {},
    getStorageLocation: async () => ({ path: custom ? chosen : defaultPath, defaultPath, custom }),
    setStorageLocation: async () => { custom = true; return { path: chosen, custom: true, restart: false } },
    resetStorageLocation: async () => { custom = false; return { path: defaultPath, custom: false, restart: false } },
  }
}

test('Web 端显示由浏览器托管，隐藏更改与恢复按钮', async ({ page }) => {
  await page.goto('/')
  const entry = page.getByRole('button', { name: '小说与原件保存在当前浏览器' })
  await expect(entry).toBeVisible()
  await entry.click()
  const dialog = page.getByRole('dialog', { name: '存储位置' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.storage-badge')).toHaveText('浏览器托管')
  await expect(dialog.locator('.storage-path')).toHaveText('当前浏览器')
  await expect(dialog.getByRole('status')).toHaveText('书库位置由当前浏览器管理')
  await expect(dialog.getByRole('button', { name: '更改位置' })).toBeHidden()
  await expect(dialog.getByRole('button', { name: '恢复默认' })).toBeHidden()
  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(dialog).toBeHidden()
})

test('桌面端可更改位置并恢复默认，按钮状态随自定义状态变化', async ({ page }) => {
  await page.route('**/releases?*', (route) => route.fulfill({ status: 404, json: {} }))
  await page.addInitScript(desktopState)
  await page.goto('/')

  const entry = page.getByRole('button', { name: '小说与原件保存在本机书库' })
  await expect(entry).toBeVisible()
  await entry.click()
  const dialog = page.getByRole('dialog', { name: '存储位置' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.storage-badge')).toHaveText('默认位置')
  await expect(dialog.locator('.storage-path')).toHaveText('C:\\Users\\lin\\AppData\\Roaming\\NewWorld')
  const change = dialog.getByRole('button', { name: '更改位置' })
  const reset = dialog.getByRole('button', { name: '恢复默认' })
  await expect(change).toBeEnabled()
  await expect(reset).toBeDisabled()

  await change.click()
  await expect(dialog.locator('.storage-badge')).toHaveText('自定义位置')
  await expect(dialog.locator('.storage-path')).toHaveText('D:\\我的书库\\New World')
  await expect(dialog.getByRole('status')).toHaveText('已更新存储位置')
  await expect(reset).toBeEnabled()
  await expect(page.getByRole('button', { name: /保存在 D:\\我的书库/ })).toBeVisible()

  await reset.click()
  await expect(dialog.locator('.storage-badge')).toHaveText('默认位置')
  await expect(dialog.locator('.storage-path')).toHaveText('C:\\Users\\lin\\AppData\\Roaming\\NewWorld')
  await expect(reset).toBeDisabled()
})
