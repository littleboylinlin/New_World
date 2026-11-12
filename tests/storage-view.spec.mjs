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
    getCloseBehavior: async () => 'quit',
    setCloseBehavior: async (mode) => mode,
    getStorageLocation: async () => ({ path: custom ? chosen : defaultPath, defaultPath, custom }),
    setStorageLocation: async () => { custom = true; return { path: chosen, custom: true, restart: false } },
    resetStorageLocation: async () => { custom = false; return { path: defaultPath, custom: false, restart: false } },
  }
}

test('Web 端显示由浏览器托管，隐藏更改与恢复按钮', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#storage-location')).toHaveText('小说与原件保存在当前浏览器')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.storage-badge')).toHaveText('浏览器托管')
  await expect(dialog.locator('.storage-path')).toHaveText('当前浏览器')
  await expect(dialog.locator('.storage-state')).toHaveText('书库位置由当前浏览器管理')
  await expect(dialog.getByRole('button', { name: '更改位置' })).toBeHidden()
  await expect(dialog.getByRole('button', { name: '恢复默认' })).toBeHidden()
  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(dialog).toBeHidden()
})

test('桌面端可更改位置并恢复默认，按钮状态随自定义状态变化', async ({ page }) => {
  await page.route('**/releases?*', (route) => route.fulfill({ status: 404, json: {} }))
  await page.addInitScript(desktopState)
  await page.goto('/')

  await expect(page.locator('#storage-location')).toHaveText('小说与原件保存在本机书库')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
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
  await expect(dialog.locator('.storage-state')).toHaveText('已更新存储位置')
  await expect(reset).toBeEnabled()
  await expect(page.locator('#storage-location')).toHaveText('小说与原件保存在 D:\\我的书库\\New World')

  await reset.click()
  await expect(dialog.locator('.storage-badge')).toHaveText('默认位置')
  await expect(dialog.locator('.storage-path')).toHaveText('C:\\Users\\lin\\AppData\\Roaming\\NewWorld')
  await expect(reset).toBeDisabled()
})

test('取消或更改失败后可继续操作，重启时锁住设置和关闭操作', async ({ page }) => {
  await page.route('**/releases?*', (route) => route.fulfill({ status: 404, json: {} }))
  await page.addInitScript(desktopState)
  await page.goto('/')
  await page.evaluate(() => {
    window.newWorldDesktop.setStorageLocation = () => new Promise((resolve) => { window.resolveLocation = resolve })
  })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  const change = dialog.getByRole('button', { name: '更改位置' })
  const close = dialog.getByRole('button', { name: '关闭', exact: true })
  await change.click()
  await expect(change).toBeDisabled()
  await expect(close).toBeDisabled()
  await expect(dialog.getByRole('radio', { name: '留后台' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '检查更新' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()

  await page.evaluate(() => window.resolveLocation(null))
  await expect(change).toBeEnabled()
  await expect(close).toBeEnabled()
  await expect(dialog.locator('.storage-badge')).toHaveText('默认位置')
  await expect(dialog.getByRole('button', { name: '恢复默认' })).toBeDisabled()

  await page.evaluate(() => {
    window.newWorldDesktop.setStorageLocation = async () => { throw new Error('目标文件夹不是空目录。') }
  })
  await change.click()
  await expect(dialog.getByRole('alert')).toHaveText('目标文件夹不是空目录。')
  await expect(change).toBeEnabled()
  await expect(close).toBeEnabled()

  await page.evaluate(() => {
    window.newWorldDesktop.setStorageLocation = async () => ({ path: 'D:\\书库', custom: true, restart: true })
  })
  await change.click()
  await expect(dialog.locator('.storage-state')).toHaveText('正在重启 New World…')
  await expect(change).toBeDisabled()
  await expect(close).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '检查更新' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
})

test('更改路径前检查正文保存，失败不调用目录选择且保留正文', async ({ page }) => {
  await page.route('**/releases?*', (route) => route.fulfill({ status: 404, json: {} }))
  await page.addInitScript(desktopState)
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'chapters' && window.storageFull) throw new DOMException('fixture', 'QuotaExceededError')
      return put.apply(this, args)
    }
  })
  await page.goto('/#/original')
  await page.getByRole('button', { name: '新建小说' }).click()
  await page.getByRole('textbox', { name: '作品名' }).fill('更改路径前的稿件')
  await page.getByRole('button', { name: '创建小说' }).click()
  const editor = page.getByRole('textbox', { name: '章节正文' })
  await editor.fill('已保存的正文。')
  await page.getByRole('button', { name: '手动保存' }).click()
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await page.evaluate(() => {
    window.storageFull = true
    window.locationChanges = 0
    window.newWorldDesktop.setStorageLocation = async () => { window.locationChanges++; return null }
  })
  await editor.fill('需要保留的未保存正文。')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.getByRole('button', { name: '更改位置' }).click()
  await expect(dialog.getByRole('alert')).toContainText('当前正文尚未保存')
  expect(await page.evaluate(() => window.locationChanges)).toBe(0)
  await expect(dialog.getByRole('button', { name: '更改位置' })).toBeEnabled()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(editor).toHaveText('需要保留的未保存正文。')

  await page.evaluate(() => { window.storageFull = false })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await dialog.getByRole('button', { name: '更改位置' }).click()
  await expect.poll(() => page.evaluate(() => window.locationChanges)).toBe(1)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await expect(editor).toHaveText('需要保留的未保存正文。')
})
