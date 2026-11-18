import { expect, test } from './app-test.mjs'
import loginModule from '../desktop/login-item.cjs'

test.use({ timezoneId: 'America/New_York' })

test('桌面小窗默认记灵感，Tab 切换提醒，无日期的时间预览及保存一致', async ({ page, context }) => {
  const now = new Date('2026-11-18T20:00:00Z')
  await page.clock.setFixedTime(now)
  await page.addInitScript(() => {
    window.notifiedTasks = []
    window.Notification = class {
      static permission = 'granted'
      constructor(_title, options) { window.notifiedTasks.push(options.body) }
    }
  })
  await page.goto('/#/notes/tasks')
  await expect(page.locator('.task-quick')).toBeVisible()
  const capture = await context.newPage()
  await capture.addInitScript(() => {
    window.closeCount = 0
    window.newWorldDesktop = {
      hideCapture: () => { window.closeCount++ },
      onCaptureShown: (shown) => { window.showCapture = shown },
    }
  })
  await capture.clock.setFixedTime(now)
  await capture.goto('/#/capture')
  const idea = capture.getByRole('textbox', { name: '灵感', exact: true })
  await expect(idea).toBeFocused()
  await idea.fill('钟楼的回声')
  await idea.press('Enter')
  await expect.poll(() => capture.evaluate(() => window.closeCount)).toBe(1)

  const title = capture.getByRole('textbox', { name: '想提醒自己做什么？' })
  for (const [index, [name, date, time, preview]] of [
    ['明早核对时间线', '', '09:00', '明天 09:00'],
    ['今晚校稿', '', '19:00', '今天 19:00'],
    ['周五交稿', '2026-11-20', '16:00', '2026年11月20日 16:00'],
    ['只定日期', '2026-11-21', '', ''],
    ['查看来信', '', '', ''],
  ].entries()) {
    await capture.evaluate(() => window.showCapture())
    await expect(idea).toBeFocused()
    await capture.keyboard.press('Tab')
    await expect(title).toBeFocused()
    await title.fill(name)
    if (date) await capture.getByLabel('计划日期').fill(date)
    if (time) await capture.getByLabel('计划时间').fill(time)
    if (preview) await expect(capture.locator('#reminder-date-preview')).toContainText(preview)
    await title.press('Enter')
    await expect.poll(() => capture.evaluate(() => window.closeCount)).toBe(index + 2)
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  }
  const tasks = await page.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open('new-world-library'); q.onsuccess = () => r(q.result) })
    const rows = await new Promise((r) => { const q = db.transaction('tasks').objectStore('tasks').getAll(); q.onsuccess = () => r(q.result) })
    db.close()
    return Object.fromEntries(rows.map((task) => [task.title, task]))
  })
  expect(tasks['明早核对时间线']).toMatchObject({ projectId: null, planDate: '2026-11-19', planTime: '09:00', zone: 'America/New_York', reminderMinutes: 0 })
  expect(tasks['今晚校稿']).toMatchObject({ planDate: '2026-11-18', planTime: '19:00', reminderMinutes: 0 })
  expect(tasks['周五交稿']).toMatchObject({ planDate: '2026-11-20', planTime: '16:00', reminderMinutes: 0 })
  expect(tasks['只定日期'].planDate).toBe('2026-11-21')
  expect(tasks['只定日期'].reminderMinutes).toBeUndefined()
  expect(tasks['查看来信']).toMatchObject({ projectId: null, planDate: null })
  expect(tasks['查看来信'].reminderMinutes).toBeUndefined()
  expect(await page.evaluate(() => window.notifiedTasks)).toEqual([])
  await page.clock.setFixedTime(new Date('2026-11-19T00:00:01Z'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => page.evaluate(() => window.notifiedTasks)).toEqual(['今晚校稿'])
  await page.getByRole('link', { name: '灵感', exact: true }).click()
  await expect(page.locator('.idea-text')).toHaveText(['钟楼的回声'])
  await page.locator('.capture-text').focus()
  await page.keyboard.press('Tab')
  await expect(page.locator('.capture-work select')).toBeFocused()
})

for (const platform of ['win32', 'darwin']) test(platform + ' 系统登录项注册、后台启动识别和注销', async ({ page }) => {
  const calls = []
  let enabled = false
  const app = {
    isPackaged: true,
    getLoginItemSettings: () => ({
      openAtLogin: platform === 'darwin' && enabled, wasOpenedAtLogin: enabled,
      launchItems: [
        { name: 'Another login entry', enabled: true, scope: 'user' },
        { name: 'NewWorldBackground', enabled: true, scope: 'machine' },
        { name: 'NewWorldBackground', enabled, scope: 'user' },
      ],
    }),
    setLoginItemSettings: (options) => { calls.push(options); enabled = options.openAtLogin },
  }
  const service = loginModule.loginItems(app, platform, [])
  await page.exposeFunction('getLogin', service.get)
  await page.exposeFunction('setLogin', service.set)
  await page.addInitScript((platform) => {
    window.newWorldDesktop = {
      platform, onCloseRequested() {}, onUpdateProgress() {}, isMaximized: async () => false, onMaximizeChange() {},
      getCloseBehavior: async () => 'quit', getLoginItem: window.getLogin, setLoginItem: window.setLogin,
    }
  }, platform)
  await page.goto('/#/settings/general')
  const toggle = page.getByRole('switch', { name: '开机时在后台启动' })
  await expect(toggle).toBeEnabled()
  await expect(toggle).not.toBeChecked()
  expect(service.backgroundLaunch()).toBe(false)
  await toggle.check()
  const options = platform === 'win32' ? { name: 'NewWorldBackground', path: process.execPath, args: ['--background-login'] } : { type: 'mainAppService' }
  await expect.poll(() => calls).toEqual([{ ...options, openAtLogin: true }])
  expect(loginModule.loginItems(app, platform, ['--background-login']).backgroundLaunch()).toBe(true)
  await page.reload()
  await expect(toggle).toBeChecked()
  await toggle.uncheck()
  await expect.poll(() => calls).toEqual([{ ...options, openAtLogin: true }, { ...options, openAtLogin: false }])
})

test('网页隐藏登录项与全局快捷键设置', async ({ page }) => {
  await page.goto('/#/settings/general')
  await expect(page.locator('#settings-page-title')).toBeVisible()
  await expect(page.getByRole('switch', { name: '开机时在后台启动' })).toHaveCount(0)
  await page.goto('/#/settings/capture')
  await expect(page.locator('#capture-settings-title')).toBeVisible()
  await expect(page.locator('#capture-shortcut-value')).toHaveCount(0)
  await page.goto('/#/capture')
  await page.reload()
  await expect(page.locator('.home')).toBeVisible()
})
