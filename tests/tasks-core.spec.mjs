import { test, expect } from './app-test.mjs'
import { seedProject, projectFixture } from './project-fixture.mjs'
import { pixel } from './fixtures.mjs'

test.setTimeout(90000)

export async function taskSnapshot(page) {
  return page.evaluate(async () => {
    const db = await new Promise((r, j) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => r(q.result)
      q.onerror = () => j(q.error)
    })
    const names = [...db.objectStoreNames].filter((n) => n.startsWith('task')),
      tx = db.transaction(names)
    const result = await Promise.all(
      names.map(
        (n) =>
          new Promise((r, j) => {
            const q = tx.objectStore(n).getAll()
            q.onsuccess = () => r([n, q.result])
            q.onerror = () => j(q.error)
          }),
      ),
    )
    db.close()
    return Object.fromEntries(result)
  })
}

async function quick(page, title) {
  await page.getByRole('textbox', { name: '快速添加任务', exact: true }).fill(title)
  await page.locator('.task-quick').getByRole('button', { name: '添加任务', exact: true }).click()
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible()
}

const row = (page, id) => page.locator(`[data-task-id="${id}"]`)

async function task(page, title) {
  return (await taskSnapshot(page)).tasks.find((t) => t.title === title)
}

async function openRowMenu(page, id) {
  const target = row(page, id)
  await target.hover()
  await target.getByRole('button', { name: '更多操作', exact: true }).click()
  return page.getByRole('menu', { name: '更多操作', exact: true })
}

// Rows slide in with the page, so wait until they rest, then move in several steps so the drop follows dragover.
async function dragTask(page, sourceId, targetId) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    ),
  )
  await row(page, sourceId).locator('.task-drag-handle').hover()
  await page.mouse.down()
  const target = await row(page, targetId).boundingBox()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 })
  await page.mouse.up()
}

test('任务 CRUD、行内展开、单层子任务清单与旧多层摊平、完成历史、复制、删除恢复和撤销持久化', async ({ page }) => {
  await page.goto('/#/tasks')
  await quick(page, '写第一章')
  const parent = await task(page, '写第一章')
  const id = parent.id

  // Clicking title expands in-place card (no modal dialog).
  await row(page, id).getByRole('button', { name: '写第一章', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const card = row(page, id).locator('.task-card')
  await expect(card).toBeVisible()

  // Add a 1-level subtask directly inside the inline checklist.
  await card.getByRole('textbox', { name: '添加子任务', exact: true }).fill('整理人物')
  await card.getByRole('textbox', { name: '添加子任务', exact: true }).press('Enter')
  await expect.poll(async () => (await task(page, '整理人物'))?.parentId).toBe(id)
  const child = await task(page, '整理人物')

  // Seed a legacy 3rd-level grandchild with legacy fields to verify flattened display & field preservation.
  const grandchildId = await page.evaluate(async (childId) => {
    const gcId = crypto.randomUUID()
    const now = Date.now()
    const db = await new Promise((r) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => r(q.result)
    })
    const tx = db.transaction('tasks', 'readwrite')
    tx.objectStore('tasks').put({
      id: gcId,
      title: '确定动机',
      description: '多段说明\n第二行',
      notes: '独立备注',
      projectId: null,
      sectionId: null,
      parentId: childId,
      priority: 1,
      labelIds: [],
      order: 2048,
      expanded: true,
      planDate: null,
      completedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    })
    await new Promise((r) => (tx.oncomplete = r))
    db.close()
    return gcId
  }, child.id)

  await page.reload()
  await row(page, id).getByRole('button', { name: '写第一章', exact: true }).click()
  await expect(card.locator('.task-sub-item')).toHaveCount(2)
  await expect(card.locator('.task-sub-item .task-sub-title').nth(0)).toHaveValue('整理人物')
  await expect(card.locator('.task-sub-item .task-sub-title').nth(1)).toHaveValue('确定动机')

  await card.getByLabel('任务备注', { exact: true }).fill('主任务备注')
  await card.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(card).toHaveCount(0)

  // Completing parent cascades to child & grandchild.
  await row(page, id).getByRole('checkbox', { name: '完成任务', exact: true }).click()
  await page.getByRole('link', { name: '已完成', exact: true }).click()
  await expect.poll(async () => (await taskSnapshot(page)).taskCompletions.length).toBe(3)
  await row(page, id).getByRole('checkbox', { name: '取消完成', exact: true }).click()

  // Return to Today, copy via ⋯ menu, delete via ⋯ menu, restore from trash, undo.
  await page.getByRole('link', { name: /^今天/ }).click()
  expect((await task(page, '写第一章')).id).toBe(id)
  let menu = await openRowMenu(page, id)
  await menu.getByRole('menuitem', { name: '复制任务', exact: true }).click()
  await expect.poll(async () => (await taskSnapshot(page)).tasks.length).toBe(6)
  const copy = await task(page, '写第一章 （副本）')
  expect(copy.id).not.toBe(id)

  menu = await openRowMenu(page, copy.id)
  await menu.getByRole('menuitem', { name: '删除任务', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '删除任务', exact: true })
  await dialog.getByRole('button', { name: '删除任务', exact: true }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('link', { name: /^任务回收站/ }).click()
  await row(page, copy.id).getByRole('button', { name: '恢复任务', exact: true }).click()
  await page.getByRole('link', { name: /^今天/ }).click()
  await expect(page.getByRole('button', { name: copy.title, exact: true })).toBeVisible()

  await page.getByRole('button', { name: '撤销任务操作', exact: true }).click()
  await expect
    .poll(async () => (await taskSnapshot(page)).tasks.filter((t) => t.deletedAt !== null).length)
    .toBe(3)

  await page.reload()
  const savedParent = (await taskSnapshot(page)).tasks.find((t) => t.id === id)
  const savedGrandchild = (await taskSnapshot(page)).tasks.find((t) => t.id === grandchildId)
  expect(savedParent.notes).toBe('主任务备注')
  expect(savedGrandchild).toMatchObject({
    description: '多段说明\n第二行',
    notes: '独立备注',
    priority: 1,
    parentId: child.id,
  })
})

test('今天/即将到来/以后分视图、作品完成进度饼图、搜索、右键菜单、拖动与触屏 ⋯ 常驻', async ({ page, browser }) => {
  await page.goto('/#/writing')
  await expect(page.getByRole('button', { name: '导入', exact: true })).toBeVisible()
  const work = await page.evaluate(seedProject, projectFixture('original', pixel.toString('base64')))

  await page.goto('/#/tasks/today')
  await quick(page, '今日写作')
  await quick(page, '第二项今日')

  // Seed work-linked tasks (1 open + 1 done) and an undated task for Later view.
  await page.evaluate(async ({ bookId, title }) => {
    const db = await new Promise((r) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => r(q.result)
    })
    const tx = db.transaction('tasks', 'readwrite')
    const now = Date.now()
    const base = {
      description: '', notes: '', projectId: null, sectionId: null, parentId: null,
      priority: 4, labelIds: [], expanded: true, deletedAt: null, createdAt: now, updatedAt: now, revision: 0,
    }
    tx.objectStore('tasks').put({
      ...base, id: crypto.randomUUID(), title: '远期资料整理', description: '可检索的旧描述',
      order: 4096, planDate: null, completedAt: null,
      link: { library: 'original', bookId, title },
    })
    tx.objectStore('tasks').put({
      ...base, id: crypto.randomUUID(), title: '已完成大纲',
      order: 5120, planDate: null, completedAt: now - 1000,
      link: { library: 'original', bookId, title },
    })
    await new Promise((r) => (tx.oncomplete = r))
    db.close()
  }, { bookId: work.root, title: '雾港' })

  await page.reload()

  // Sidebar displays work link with Things 3 completion pie SVG (1/2 completed).
  const workNav = page.locator('.task-nav-work').filter({ hasText: '雾港' })
  await expect(workNav).toBeVisible()
  await expect(workNav.locator('svg.task-work-pie')).toBeVisible()
  await expect(workNav).toHaveAttribute('aria-label', '雾港 · 原创验收，已完成 1 / 2')

  // Drag reorder in Today view.
  const first = await task(page, '今日写作')
  const second = await task(page, '第二项今日')
  await dragTask(page, second.id, first.id)
  await expect.poll(async () => (await task(page, '第二项今日')).order < (await task(page, '今日写作')).order).toBe(true)

  // Right-click row opens context menu; moving to Tomorrow shifts task to Upcoming.
  await row(page, second.id).click({ button: 'right' })
  const ctxMenu = page.getByRole('menu', { name: '更多操作', exact: true })
  await ctxMenu.getByRole('menuitem', { name: '明天', exact: true }).click()
  await expect(page.getByRole('button', { name: '第二项今日', exact: true })).toHaveCount(0)

  await page.getByRole('link', { name: /^即将到来/ }).click()
  await expect(page.getByRole('button', { name: '第二项今日', exact: true })).toBeVisible()

  // Later view shows undated task, and search matches legacy description.
  await page.getByRole('link', { name: /^以后/ }).click()
  await expect(page.getByRole('button', { name: '远期资料整理', exact: true })).toBeVisible()
  await page.getByRole('searchbox', { name: '搜索任务', exact: true }).fill('可检索的旧描述')
  await expect(page.getByRole('button', { name: '远期资料整理', exact: true })).toBeVisible()

  // Touch screen keeps ⋯ action button always visible without hover.
  const touchCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, locale: 'zh-CN' })
  try {
    const tPage = await touchCtx.newPage()
    await tPage.goto('/#/tasks/today')
    await quick(tPage, '触屏任务')
    const moreBtn = tPage.locator('.task-row .task-more-btn').first()
    await expect(moreBtn).toBeVisible()
    expect(await moreBtn.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  } finally {
    await touchCtx.close()
  }
})

test('并发编辑拒绝覆盖，任务写入中断整体回滚', async ({ page }) => {
  await page.goto('/#/tasks')
  await quick(page, '受保护任务')
  const original = await task(page, '受保护任务')
  await page.getByRole('button', { name: original.title, exact: true }).click()
  const card = row(page, original.id).locator('.task-card')
  await expect(card).toBeVisible()

  await page.evaluate(async (id) => {
    const db = await new Promise((r) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => r(q.result)
    })
    const tx = db.transaction('tasks', 'readwrite'),
      store = tx.objectStore('tasks'),
      q = store.get(id)
    q.onsuccess = () =>
      store.put({ ...q.result, title: '其他窗口的修改', revision: q.result.revision + 1 })
    await new Promise((r) => (tx.oncomplete = r))
    db.close()
  }, original.id)

  await card.getByLabel('任务标题', { exact: true }).fill('过期表单')
  await card.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(card.getByRole('alert')).toContainText('其他窗口')
  await card.getByRole('button', { name: '收起', exact: true }).first().click()

  await page.reload()
  const before = await taskSnapshot(page)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'taskCompletions') {
        this.transaction.abort()
        throw new DOMException('test abort', 'AbortError')
      }
      return put.apply(this, args)
    }
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'taskCompletions') {
        this.transaction.abort()
        throw new DOMException('test abort', 'AbortError')
      }
      return add.apply(this, args)
    }
  })
  await page.getByRole('checkbox', { name: '完成任务', exact: true }).click()
  await expect(page.locator('.undo-toast')).toBeVisible()
  expect(await taskSnapshot(page)).toEqual(before)
  await page.reload()
  expect((await task(page, '其他窗口的修改')).completedAt).toBeNull()
})

test('拖动途中后台刷新任务列表，松手后排序仍然生效', async ({ page }) => {
  await page.goto('/#/tasks')
  await quick(page, '日常任务')
  await quick(page, '第二项')
  const first = await task(page, '日常任务'),
    second = await task(page, '第二项')
  await page.evaluate(() => {
    window.rowSwaps = 0
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes)
          if (node.nodeType === 1 && (node.matches('.task-row') || node.querySelector('.task-row'))) window.rowSwaps++
    }).observe(document.body, { childList: true, subtree: true })
  })
  await row(page, second.id).locator('.task-drag-handle').hover()
  await page.mouse.down()
  const target = await row(page, first.id).boundingBox()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 })
  // Focus refreshes the list in the background, as switching back to the window does.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => window.rowSwaps)).toBe(0)
  await page.mouse.up()
  await expect
    .poll(async () => (await task(page, '第二项')).order < (await task(page, '日常任务')).order)
    .toBe(true)
  await expect(page.locator('.task-row .task-title').first()).toHaveText('第二项')
})
