import { test, expect } from './app-test.mjs'

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

test('任务 CRUD、三层子任务、完成历史、复制、删除恢复和撤销持久化', async ({ page }) => {
  await page.goto('/#/tasks')
  await quick(page, '写第一章')
  let parent = await task(page, '写第一章')
  const id = parent.id
  await row(page, id).getByRole('button', { name: '添加子任务', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '添加任务', exact: true })
  await dialog.getByLabel('任务标题', { exact: true }).fill('整理人物')
  await dialog.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(dialog).toBeHidden()
  const child = await task(page, '整理人物')
  await row(page, child.id).getByRole('button', { name: '添加子任务', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '添加任务', exact: true })
  await dialog.getByLabel('任务标题', { exact: true }).fill('确定动机')
  await dialog.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(dialog).toBeHidden()
  const grandchild = await task(page, '确定动机')
  expect(grandchild.parentId).toBe(child.id)
  await row(page, id).getByRole('button', { name: '收起子任务', exact: true }).first().click()
  await expect(page.getByRole('button', { name: '确定动机', exact: true })).toBeHidden()
  await page.reload()
  await row(page, id).getByRole('button', { name: '展开子任务', exact: true }).click()
  await row(page, grandchild.id).getByRole('button', { name: '确定动机', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '编辑任务', exact: true })
  await dialog.getByLabel('任务描述', { exact: true }).fill('多段说明\n第二行')
  await dialog.getByLabel('任务备注', { exact: true }).fill('独立备注')
  await dialog.getByLabel('优先级', { exact: true }).selectOption('1')
  await dialog.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(dialog).toBeHidden()
  await row(page, id).getByRole('button', { name: '完成任务', exact: true }).first().click()
  await page.getByRole('link', { name: '已完成', exact: true }).click()
  await expect.poll(async () => (await taskSnapshot(page)).taskCompletions.length).toBe(3)
  await row(page, id).getByRole('button', { name: '取消完成', exact: true }).first().click()
  await page.getByRole('link', { name: '收件箱', exact: true }).click()
  expect((await task(page, '写第一章')).id).toBe(id)
  await row(page, id).getByRole('button', { name: '复制任务', exact: true }).first().click()
  await expect.poll(async () => (await taskSnapshot(page)).tasks.length).toBe(6)
  const copy = await task(page, '写第一章 （副本）')
  expect(copy.id).not.toBe(id)
  await row(page, copy.id).getByRole('button', { name: '删除任务', exact: true }).first().click()
  dialog = page.getByRole('dialog', { name: '删除任务', exact: true })
  await dialog.getByRole('button', { name: '删除任务', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('link', { name: '任务回收站', exact: true }).click()
  await row(page, copy.id).getByRole('button', { name: '恢复任务', exact: true }).first().click()
  await page.getByRole('link', { name: '全部任务', exact: true }).click()
  await expect(page.getByRole('button', { name: copy.title, exact: true })).toBeVisible()
  await page
    .locator('.task-toolbar')
    .getByRole('button', { name: '撤销任务操作', exact: true })
    .click()
  await expect
    .poll(async () => (await taskSnapshot(page)).tasks.filter((t) => t.deletedAt !== null).length)
    .toBe(3)
  await page.reload()
  const saved = (await taskSnapshot(page)).tasks.find((t) => t.id === grandchild.id)
  expect(saved).toMatchObject({
    description: '多段说明\n第二行',
    notes: '独立备注',
    priority: 1,
    parentId: child.id,
  })
})

for (const copy of Array.from({ length: 10 }, (_, i) => i)) test('项目、分区、标签、今日/未来搜索、批量移动和拖动使用同一数据' + (copy ? ' #' + copy : ''), async ({ page }) => {
  await page.goto('/#/tasks')
  await quick(page, '日常任务')
  await quick(page, '第二项')
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '新建项目', exact: true })
  await dialog.getByLabel('项目名称', { exact: true }).fill('小说计划')
  await dialog.getByLabel('自定义图标（文字或表情）', { exact: true }).fill('📚')
  await dialog.getByRole('button', { name: '保存项目', exact: true }).click()
  await expect(dialog).toBeHidden()
  const state = await taskSnapshot(page),
    project = state.taskProjects[0]
  await page.getByRole('checkbox', { name: '选择任务 日常任务', exact: true }).check()
  await page.getByRole('checkbox', { name: '选择任务 第二项', exact: true }).check()
  await page.locator('.task-bulk').getByRole('button', { name: '移动任务', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '移动任务', exact: true })
  await dialog.getByLabel('任务项目', { exact: true }).selectOption(project.id)
  await dialog.getByRole('button', { name: '移动任务', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.goto('/#/tasks/project/' + project.id)
  await expect(page.getByRole('button', { name: '日常任务', exact: true })).toBeVisible()
  const first = await task(page, '日常任务'),
    second = await task(page, '第二项')
  await page.evaluate(() => {
    window.dragLog = []
    for (const type of ['mousedown', 'dragstart', 'dragenter', 'dragover', 'drop', 'dragend', 'mouseup'])
      document.addEventListener(type, (e) => {
        if (type === 'dragover' && window.dragLog.at(-1)?.startsWith('dragover')) return
        const r = e.target.closest?.('[data-task-id]')
        window.dragLog.push(`${type}@${Math.round(performance.now())} ${r ? r.dataset.taskId.slice(0, 6) : e.target.className || e.target.tagName}`)
      }, { capture: true })
    new MutationObserver(() => window.dragLog.push('mutation@' + Math.round(performance.now()))).observe(document.querySelector('.task-content'), { childList: true, subtree: true })
  })
  const errors = []
  page.on('console', (m) => errors.push(m.type() + ': ' + m.text()))
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  const boxes = { first: await row(page, first.id).boundingBox(), second: await row(page, second.id).boundingBox(), handle: await row(page, second.id).locator('.task-drag-handle').boundingBox() }
  await row(page, second.id).locator('.task-drag-handle').dragTo(row(page, first.id))
  try {
    await expect
      .poll(async () => (await task(page, '第二项')).order < (await task(page, '日常任务')).order)
      .toBe(true)
  } catch (error) {
    console.log('DRAG-DIAG', JSON.stringify({ ids: [first.id.slice(0, 6), second.id.slice(0, 6)], boxes, after: { first: await row(page, first.id).boundingBox(), second: await row(page, second.id).boundingBox() }, log: await page.evaluate(() => window.dragLog), errors, toast: await page.locator('.undo-toast').allTextContents(), tasks: (await taskSnapshot(page)).tasks.map((t) => [t.title, t.projectId?.slice(0, 6), t.sectionId, t.parentId, t.order]) }))
    throw error
  }
  await page.getByRole('button', { name: '管理分区', exact: true }).click()
  await page.getByRole('button', { name: '新建分区', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '新建分区', exact: true })
  await dialog.getByLabel('分区名称', { exact: true }).fill('大纲')
  await dialog.getByRole('button', { name: '保存分区', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page
    .getByRole('dialog', { name: '管理分区' })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await page.getByRole('button', { name: '标签管理', exact: true }).click()
  await page.getByRole('button', { name: '新建标签', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '新建标签', exact: true })
  await dialog.getByLabel('标签名称', { exact: true }).fill('重要')
  await dialog.getByRole('button', { name: '保存标签', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page
    .getByRole('dialog', { name: '标签管理' })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  const data = await taskSnapshot(page)
  await page.getByRole('button', { name: '日常任务', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '编辑任务', exact: true })
  await dialog.getByLabel('任务分区', { exact: true }).selectOption(data.taskSections[0].id)
  await dialog.getByRole('checkbox', { name: '重要', exact: true }).check()
  await dialog.getByLabel('计划日期', { exact: true }).fill('2000-01-01')
  await dialog.getByLabel('任务描述', { exact: true }).fill('可以搜索的描述')
  await dialog.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('link', { name: '今日', exact: true }).click()
  await expect(page.getByRole('button', { name: '日常任务', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '第二项', exact: true })).toHaveCount(0)
  await page.getByRole('searchbox', { name: '搜索任务', exact: true }).fill('搜索的描述')
  await expect(page.getByRole('button', { name: '日常任务', exact: true })).toBeVisible()
  expect((await task(page, '日常任务')).labelIds).toEqual([data.taskLabels[0].id])
  await page.goto('/#/tasks/project/' + project.id)
  await page.getByRole('button', { name: '删除项目', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '删除项目', exact: true })
  await dialog.getByRole('button', { name: '删除项目', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: '恢复项目', exact: true }).click()
  expect((await task(page, '日常任务')).projectId).toBe(project.id)
})

test('并发编辑拒绝覆盖，任务写入中断整体回滚', async ({ page }) => {
  await page.goto('/#/tasks')
  await quick(page, '受保护任务')
  const original = await task(page, '受保护任务')
  await page.getByRole('button', { name: original.title, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑任务', exact: true })
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
  await dialog.getByLabel('任务标题', { exact: true }).fill('过期表单')
  await dialog.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('其他窗口')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
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
  await page.getByRole('button', { name: '完成任务', exact: true }).click()
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
