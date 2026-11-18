import { startWork, openDrawer } from './navigation-helpers.mjs'
import { expect, test } from './app-test.mjs'

const desktopState = () => {
  let mode = 'quit'
  const clients = []
  let aiEnabled = false
  let aiPort = 47291
  const aiSnapshot = () => ({
    enabled: aiEnabled,
    port: aiPort,
    bridge: { running: aiEnabled, port: aiPort, error: null },
    clients: [...clients],
  })
  window.newWorldDesktop = {
    platform: 'win32',
    arch: 'x64',
    downloadUpdate: async () => ({ ok: true }),
    installUpdate: async () => ({ ok: true }),
    onUpdateProgress: () => {},
    savePdf: async () => {},
    onCloseRequested: () => {},
    minimizeWindow: () => {}, toggleMaximizeWindow: () => {}, closeWindow: () => {},
    isMaximized: async () => false, onMaximizeChange: () => {},
    getStorageLocation: async () => ({ path: 'C:\\书库', defaultPath: 'C:\\书库', custom: false }),
    setStorageLocation: async () => null,
    resetStorageLocation: async () => null,
    getCloseBehavior: async () => mode,
    setCloseBehavior: async (next) => { mode = next; return mode },
    getAiState: async () => aiSnapshot(),
    setAiEnabled: async (enabled) => {
      aiEnabled = Boolean(enabled)
      return aiSnapshot()
    },
    setAiPort: async (port) => {
      aiPort = Number(port)
      return aiSnapshot()
    },
    createAiClient: async (input) => {
      const client = {
        id: 'mock-client-1',
        name: typeof input === 'string' ? input : input.name,
        tokenPrefix: 'nw_ai_mock',
        enabled: true,
        permissions: { create: false, read: true, update: false, delete: false },
        scope: { mode: 'none', workIds: [] },
      }
      clients.push(client)
      return { state: aiSnapshot(), client, token: 'nw_ai_mock_token_value' }
    },
    listAiAudit: async () => [],
  }
}

test('设置入口位于左下角独立位置，点击进入独立设置页，侧栏固定且分类互斥展示', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '写作统计' })).toBeVisible()

  // Settings entry must no longer live inside the top header; it lives on the bottom of the primary sidebar.
  await expect(page.locator('.site-header').getByRole('link', { name: '设置' })).toHaveCount(0)
  await expect(page.locator('.site-header').getByRole('button', { name: '设置' })).toHaveCount(0)

  const entry = page.locator('#app-sidebar #settings')
  await expect(entry).toBeVisible()
  await expect(entry).toHaveText('设置')
  await expect(entry.locator('svg')).toHaveCount(1)

  const dockLayout = await page.evaluate(() => {
    const sidebar = document.querySelector('#app-sidebar').getBoundingClientRect()
    const settings = document.querySelector('#settings').getBoundingClientRect()
    const meta = document.querySelector('.footer-meta').getBoundingClientRect()
    const trash = document.querySelector('#trash-link').getBoundingClientRect()
    return {
      settingsLeft: settings.left,
      sidebarLeft: sidebar.left,
      settingsRight: settings.right,
      metaLeft: meta.left,
      settingsTop: settings.top,
      trashBottom: trash.bottom,
      viewportHeight: innerHeight,
    }
  })
  expect(dockLayout.settingsLeft).toBeLessThanOrEqual(dockLayout.sidebarLeft + 24)
  expect(dockLayout.settingsRight).toBeLessThanOrEqual(dockLayout.metaLeft + 1)
  expect(dockLayout.settingsTop).toBeGreaterThanOrEqual(dockLayout.trashBottom - 1)
  expect(dockLayout.settingsTop).toBeLessThan(dockLayout.viewportHeight)

  // Enter Settings: default category is General, full page (zero dialogs).
  await entry.click()
  await expect(page).toHaveURL(/#\/settings\/general$/)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await expect(page.locator('html')).toHaveClass(/settings-open/)
  await expect(entry).toHaveAttribute('aria-current', 'page')

  const settingsPage = page.locator('.settings-page')
  await expect(settingsPage).toBeVisible()

  const navItems = settingsPage.getByRole('navigation', { name: '设置分类' }).getByRole('link')
  await expect(navItems).toHaveText(['常规', '外观', '快捷记录', '存储', '备份与恢复', 'AI 接入', '更新与关于'])
  await expect(navItems.nth(0)).toHaveAttribute('aria-current', 'page')
  await expect(settingsPage.locator('.settings-panel:not([hidden])')).toHaveCount(1)
  await expect(settingsPage.locator('.settings-panel[data-category="general"]')).toBeVisible()
  await expect(settingsPage.locator('.settings-panel[data-category="appearance"]')).toBeHidden()
  await expect(settingsPage.locator('.settings-badge')).toHaveText('浏览器托管')
  await expect(settingsPage.locator('.settings-back')).toContainText('返回书库')

  // Switching to AI shows Web notice while hiding other panels.
  await navItems.filter({ hasText: 'AI 接入' }).click()
  await expect(page).toHaveURL(/#\/settings\/ai$/)
  await expect(settingsPage.locator('.settings-panel:not([hidden])')).toHaveCount(1)
  await expect(settingsPage.locator('.settings-panel[data-category="ai"] .ai-badge')).toHaveText('仅桌面端可用')

  // Scrolling right pane in Appearance must keep left sidebar stationary.
  await navItems.filter({ hasText: '外观' }).click()
  await expect(page).toHaveURL(/#\/settings\/appearance$/)
  await expect(settingsPage.locator('.settings-panel:not([hidden])')).toHaveCount(1)
  const sidebarBefore = await settingsPage.locator('.settings-sidebar').boundingBox()
  await settingsPage.locator('.settings-content').evaluate((node) => { node.scrollTop = 260 })
  const sidebarAfter = await settingsPage.locator('.settings-sidebar').boundingBox()
  expect(Math.abs(sidebarBefore.y - sidebarAfter.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(sidebarBefore.x - sidebarAfter.x)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('settings-desktop-appearance.png'), animations: 'disabled' })

  await navItems.filter({ hasText: '常规' }).click()
  await expect(page).toHaveURL(/#\/settings\/general$/)
  await expect(settingsPage.locator('.settings-panel[data-category="general"]')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('settings-desktop-general.png'), animations: 'disabled' })

  // Return button goes back cleanly and clears aria-current / html.settings-open.
  await settingsPage.locator('.settings-back').click()
  await expect(page).toHaveURL(/#\/?$/)
  await expect(settingsPage).toBeHidden()
  await expect(page.locator('html')).not.toHaveClass(/settings-open/)
  await expect(entry).not.toHaveAttribute('aria-current', 'page')
})

test('设置页支持直接 hash 路由、刷新、浏览器前进后退、返回来源页以及无障碍键盘导航', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  // Direct navigation to a specific category
  await page.goto('/#/settings/updates')
  const settingsPage = page.locator('.settings-page')
  await expect(settingsPage).toBeVisible()
  await expect(settingsPage.locator('.settings-panel[data-category="updates"]')).toBeVisible()
  await expect(settingsPage.locator('.settings-nav-item[data-category="updates"]')).toHaveAttribute('aria-current', 'page')

  // Reloading preserves active settings category
  await page.reload()
  await expect(page).toHaveURL(/#\/settings\/updates$/)
  await expect(settingsPage.locator('.settings-panel[data-category="updates"]')).toBeVisible()

  // Unknown category falls back cleanly to general
  await page.goto('/#/settings/does-not-exist')
  await expect(page).toHaveURL(/#\/settings\/general$/)
  await expect(settingsPage.locator('.settings-panel[data-category="general"]')).toBeVisible()

  // Origin memory: enter from #/original, switch categories, reload, Back returns straight to #/original
  await page.goto('/#/original')
  await expect(page.getByRole('heading', { name: '写作' })).toBeVisible()
  await page.locator('#settings').click()
  await expect(page).toHaveURL(/#\/settings\/general$/)
  await expect(settingsPage.locator('.settings-back')).toContainText('返回上一页')

  await settingsPage.locator('.settings-nav-item[data-category="backup"]').click()
  await expect(page).toHaveURL(/#\/settings\/backup$/)
  await settingsPage.locator('.settings-nav-item[data-category="storage"]').click()
  await expect(page).toHaveURL(/#\/settings\/storage$/)

  // Browser back & forward step through settings categories
  await page.goBack()
  await expect(page).toHaveURL(/#\/settings\/backup$/)
  await expect(settingsPage.locator('.settings-panel[data-category="backup"]')).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL(/#\/settings\/storage$/)

  // Page reload preserves the remembered non-settings return hash
  await page.reload()
  await expect(settingsPage.locator('.settings-back')).toContainText('返回上一页')
  await settingsPage.locator('.settings-back').click()
  await expect(page).toHaveURL(/#\/writing$/)
  await expect(page.getByRole('heading', { name: '写作' })).toBeVisible()

  // ArrowUp / ArrowDown / Home / End keyboard navigation in left category sidebar
  await page.locator('#settings').click()
  const firstNav = settingsPage.locator('.settings-nav-item').first()
  await firstNav.focus()
  await page.keyboard.press('ArrowDown')
  await expect(settingsPage.locator('.settings-nav-item[data-category="appearance"]')).toBeFocused()
  await page.keyboard.press('End')
  await expect(settingsPage.locator('.settings-nav-item[data-category="updates"]')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(firstNav).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(settingsPage.locator('.settings-nav-item[data-category="updates"]')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(firstNav).toBeFocused()

  // Appearance custom event navigates directly to Appearance and focuses its heading
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('new-world:open-appearance-settings')))
  await expect(page).toHaveURL(/#\/settings\/appearance$/)
  await expect(settingsPage.locator('#settings-panel-heading-appearance')).toBeFocused()
})

test('切换设置分类保留异步任务状态、已显露 AI 令牌与进行中锁保护', async ({ page }, testInfo) => {
  await page.route('**/releases?*', (route) => route.fulfill({ status: 404, json: {} }))
  await page.addInitScript(desktopState)
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/#/settings/ai')

  const settingsPage = page.locator('.settings-page')
  const aiPanel = settingsPage.locator('.settings-panel[data-category="ai"]')
  await aiPanel.getByLabel('AI 配置名称').fill('TokenPersistAgent')
  await aiPanel.getByRole('button', { name: '添加 AI 配置' }).click()
  await expect(aiPanel.locator('.ai-token-banner')).toBeVisible()
  await expect(aiPanel.locator('.ai-token-value')).toHaveText('nw_ai_mock_token_value')

  // Switch away to Appearance (also toggle dark theme for visual coverage) and return to AI
  await settingsPage.locator('.settings-nav-item[data-category="appearance"]').click()
  await expect(settingsPage.locator('.settings-panel[data-category="appearance"]')).toBeVisible()
  await settingsPage.locator('.settings-nav-item[data-category="ai"]').click()
  await expect(aiPanel.locator('.ai-token-banner')).toBeVisible()
  await expect(aiPanel.locator('.ai-token-value')).toHaveText('nw_ai_mock_token_value')
  await page.screenshot({ path: testInfo.outputPath('settings-desktop-ai.png'), animations: 'disabled' })

  // Busy lock prevents leaving Settings or switching categories during storage change
  await page.evaluate(() => {
    window.newWorldDesktop.setStorageLocation = () => new Promise((resolve) => {
      window.finishStoragePick = () => resolve(null)
    })
  })
  await settingsPage.locator('.settings-nav-item[data-category="storage"]').click()
  await settingsPage.getByRole('button', { name: '更改位置' }).click()
  await expect(settingsPage.locator('.settings-back')).toBeDisabled()
  await expect(settingsPage.locator('.settings-nav-item[data-category="general"]')).toHaveAttribute('aria-disabled', 'true')
  await settingsPage.locator('.settings-nav-item[data-category="general"]').click({ force: true })
  await expect(page).toHaveURL(/#\/settings\/storage$/)

  await page.evaluate(() => window.finishStoragePick())
  await expect(settingsPage.locator('.settings-back')).toBeEnabled()
  await expect(settingsPage.locator('.settings-nav-item[data-category="general"]')).not.toHaveAttribute('aria-disabled', 'true')
})

test('移动端与窄窗设置布局不横向溢出，专注写作模式隐藏底部设置入口', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await openDrawer(page)
  await page.locator('#settings').click()
  const settingsPage = page.locator('.settings-page')
  await expect(settingsPage).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await settingsPage.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await expect(settingsPage.locator('.settings-back')).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('settings-mobile-general.png'), animations: 'disabled' })

  await page.locator('.settings-nav-item[data-category="updates"]').click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await settingsPage.locator('.settings-back').click()

  // Focus writing mode in editor must keep bottom dock hidden
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill('专注模式设置检查')
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(page.getByRole('textbox', { name: '章节正文' })).toBeVisible()
  await page.getByRole('button', { name: '专注写作', exact: true }).click()
  await expect(page.locator('#settings')).toBeHidden()
})

test('桌面端可切换留后台并改回完全退出，设置会被记住', async ({ page }, testInfo) => {
  await page.route('**/releases?*', (route) => route.fulfill({ status: 404, json: {} }))
  await page.addInitScript(desktopState)
  await page.goto('/#/settings/general')
  const general = page.locator('.settings-panel[data-category="general"]')
  const quit = general.getByRole('radio', { name: '完全退出' })
  const background = general.getByRole('radio', { name: '留后台' })
  await expect(quit).toBeChecked()
  await expect(background).not.toBeChecked()

  await background.check()
  await expect(background).toBeChecked()
  await expect(general.locator('.settings-state').last()).toHaveText('已保存')
  await page.locator('.settings-back').click()

  await page.locator('#settings').click()
  await expect(general.getByRole('radio', { name: '留后台' })).toBeChecked()
  await general.getByRole('radio', { name: '完全退出' }).check()
  await expect(general.getByRole('radio', { name: '完全退出' })).toBeChecked()
  await expect(general.locator('.settings-state').last()).toHaveText('已保存')
  await page.screenshot({ path: testInfo.outputPath('home-settings-desktop.png'), animations: 'disabled' })
})

test('关闭方式保存失败时保留原选项，其他设置仍可操作', async ({ page }) => {
  await page.route('**/releases?*', (route) => route.fulfill({ status: 404, json: {} }))
  await page.addInitScript(desktopState)
  await page.goto('/#/settings/general')
  await page.evaluate(() => {
    window.newWorldDesktop.setCloseBehavior = async () => { throw new Error('设置未能保存，请重试。') }
  })
  const general = page.locator('.settings-panel[data-category="general"]')
  await general.getByRole('radio', { name: '留后台' }).click()
  await expect(general.getByRole('alert')).toHaveText('设置未能保存，请重试。')
  await expect(general.getByRole('radio', { name: '完全退出' })).toBeChecked()
  await page.locator('.settings-nav-item[data-category="storage"]').click()
  await expect(page.getByRole('button', { name: '更改位置' })).toBeEnabled()
  await page.locator('.settings-nav-item[data-category="updates"]').click()
  await expect(page.getByRole('button', { name: '检查更新' })).toBeEnabled()
  await page.locator('.settings-back').click()
  await expect(page.locator('.settings-page')).toBeHidden()
})
