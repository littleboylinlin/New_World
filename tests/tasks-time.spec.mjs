import { test, expect } from './app-test.mjs'

test.setTimeout(90000)

async function state(page) {
  return page.evaluate(async () => {
    const db = await new Promise((r) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => r(q.result)
    })
    const names = [...db.objectStoreNames].filter((n) => n.startsWith('task')),
      tx = db.transaction(names)
    const values = await Promise.all(
      names.map(
        (n) =>
          new Promise((r) => {
            const q = tx.objectStore(n).getAll()
            q.onsuccess = () => r([n, q.result])
          }),
      ),
    )
    db.close()
    return Object.fromEntries(values)
  })
}

test('简单重复（每天/每周几）完成保留 ID 和历史，完成历史可恢复', async ({ page }) => {
  await page.goto('/#/tasks/today')
  await page.getByRole('textbox', { name: '快速添加任务', exact: true }).fill('每日写作')
  await page.locator('.task-quick').getByRole('button', { name: '添加任务', exact: true }).click()
  await expect(page.getByRole('button', { name: '每日写作', exact: true })).toBeVisible()

  await page.getByRole('button', { name: '每日写作', exact: true }).click()
  const card = page.locator('.task-card')
  await card.getByLabel('重复规则', { exact: true }).selectOption('day')
  await card.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(card).toHaveCount(0)

  const before = (await state(page)).tasks[0]
  expect(before.repeat).toMatchObject({ frequency: 'day', interval: 1 })

  await page.getByRole('checkbox', { name: '完成任务', exact: true }).click()
  await expect.poll(async () => (await state(page)).taskCompletions.length).toBe(1)
  const after = (await state(page)).tasks[0]
  expect(after.id).toBe(before.id)
  expect(after.completedAt).toBeNull()
  expect(after.planDate > before.planDate).toBe(true)

  await page.getByRole('link', { name: '已完成', exact: true }).click()
  await page.getByText('完成历史', { exact: true }).click()
  await page.getByRole('button', { name: '恢复本次完成', exact: true }).click()
  await expect.poll(async () => (await state(page)).taskCompletions.length).toBe(2)
  expect((await state(page)).tasks[0].planDate).toBe(before.planDate)

  // Switch to weekly repeat with chosen weekdays.
  await page.getByRole('link', { name: /^今天/ }).click()
  await page.getByRole('button', { name: '每日写作', exact: true }).click()
  await card.getByLabel('重复规则', { exact: true }).selectOption('week')
  await card.locator('.task-weekday-pill').filter({ hasText: '周一' }).click()
  await card.locator('.task-weekday-pill').filter({ hasText: '周三' }).click()
  await card.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(card).toHaveCount(0)

  const weekly = (await state(page)).tasks[0]
  expect(weekly.repeat.frequency).toBe('week')
  expect(weekly.repeat.interval).toBe(1)
  expect(weekly.repeat.weekdays.length).toBeGreaterThanOrEqual(1)
})

test('旧复杂重复规则（按月/间隔/结束日）行内编辑时不丢失，完成仍按原规则推进', async ({ page }) => {
  await page.goto('/#/tasks/all')
  await expect(page.getByLabel('快速添加任务', { exact: true })).toBeVisible()

  const id = await page.evaluate(async () => {
    const taskId = crypto.randomUUID()
    const now = Date.now()
    const db = await new Promise((r) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => r(q.result)
    })
    const tx = db.transaction('tasks', 'readwrite')
    tx.objectStore('tasks').add({
      id: taskId,
      title: '双月结算审稿',
      description: '',
      notes: '',
      projectId: null,
      sectionId: null,
      parentId: null,
      priority: 4,
      labelIds: [],
      order: 1024,
      expanded: true,
      planDate: '2099-01-31',
      deadline: '2099-12-31',
      repeat: {
        frequency: 'month',
        interval: 2,
        anchorDate: '2099-01-31',
        monthDays: [31],
        until: '2099-12-31',
      },
      completedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    })
    await new Promise((r) => (tx.oncomplete = r))
    db.close()
    return taskId
  })

  await page.reload()
  await page.getByRole('button', { name: '双月结算审稿', exact: true }).click()
  const card = page.locator(`[data-task-id="${id}"] .task-card`)
  await expect(card.getByLabel('重复规则', { exact: true })).toHaveValue('__legacy__')

  // Editing notes preserves the legacy complex repeat rule and deadline untouched.
  await card.getByLabel('任务备注', { exact: true }).fill('编辑备注不影响旧重复')
  await card.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(card).toHaveCount(0)

  const edited = (await state(page)).tasks.find((t) => t.id === id)
  expect(edited.notes).toBe('编辑备注不影响旧重复')
  expect(edited.deadline).toBe('2099-12-31')
  expect(edited.repeat).toEqual({
    frequency: 'month',
    interval: 2,
    anchorDate: '2099-01-31',
    monthDays: [31],
    until: '2099-12-31',
  })

  // Completing advances using the original bi-monthly rule: 2099-01-31 -> 2099-03-31.
  await page.locator(`[data-task-id="${id}"]`).getByRole('checkbox', { name: '完成任务', exact: true }).click()
  await expect.poll(async () => (await state(page)).taskCompletions.length).toBe(1)
  const next = (await state(page)).tasks.find((t) => t.id === id)
  expect(next.completedAt).toBeNull()
  expect(next.planDate).toBe('2099-03-31')
  expect(next.repeat).toEqual(edited.repeat)
})

test('通知需要明确启用，运行中提醒持久去重，关闭提醒后停止发送', async ({ page }) => {
  await page.addInitScript(() => {
    window.__notifications = []
    class LocalNotification {
      static permission = 'granted'
      static async requestPermission() {
        return this.permission
      }
      constructor(title, options) {
        window.__notifications.push({ title, ...options })
      }
      close() {}
    }
    window.Notification = LocalNotification
  })
  await page.goto('/#/tasks/all')
  await expect(page.getByLabel('快速添加任务', { exact: true })).toBeVisible()

  await page.evaluate(async () => {
    const now = new Date(Date.now() - 120000)
    const db = await new Promise((r) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => r(q.result)
    })
    const tx = db.transaction('tasks', 'readwrite')
    tx.objectStore('tasks').add({
      id: crypto.randomUUID(),
      title: '本地提醒',
      description: '',
      notes: '',
      projectId: null,
      sectionId: null,
      parentId: null,
      priority: 4,
      labelIds: [],
      order: 1024,
      expanded: true,
      planDate: now.toISOString().slice(0, 10),
      planTime: now.toISOString().slice(11, 16),
      zone: 'UTC',
      reminderMinutes: 0,
      completedAt: null,
      deletedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 0,
    })
    await new Promise((r) => (tx.oncomplete = r))
    db.close()
  })

  await page.reload()
  expect(await page.evaluate(() => window.__notifications.length)).toBe(0)
  await page.getByText('本地提醒与快捷键', { exact: true }).click()
  await page.getByRole('button', { name: '启用本地提醒', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__notifications.length)).toBe(1)
  await page.reload()
  await page.getByText('本地提醒与快捷键', { exact: true }).click()
  await page.getByRole('button', { name: '停用本地提醒', exact: true }).click()
  expect(await page.evaluate(() => window.__notifications.length)).toBe(0)
  expect((await state(page)).taskSettings.find((s) => s.id === 'reminders:enabled').value).toBe('false')
})
