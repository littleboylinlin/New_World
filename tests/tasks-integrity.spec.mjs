import { test, expect } from './app-test.mjs'
import { seedProject, projectFixture, databaseSnapshot } from './project-fixture.mjs'
import { pixel } from './fixtures.mjs'
test.setTimeout(90000)
test.use({ timezoneId: 'UTC' })
const state = (page) => page.evaluate(databaseSnapshot)
const row = (page, id) => page.locator(`[data-task-id="${id}"]`)
test('重复树真实完成、双击不重入、删除成员不复活，历史恢复最小状态且拒绝覆盖新修改', async ({
  page,
}) => {
  await page.goto('/#/tasks/all')
  await expect(page.getByLabel('快速添加任务', { exact: true })).toBeVisible()
  const ids = await page.evaluate(async () => {
    const parent = crypto.randomUUID(),
      child = crypto.randomUUID(),
      done = crypto.randomUUID(),
      deleted = crypto.randomUUID(),
      deletionId = crypto.randomUUID(),
      now = Date.now(),
      db = await new Promise((r) => {
        const q = indexedDB.open('new-world-library')
        q.onsuccess = () => r(q.result)
      }),
      tx = db.transaction('tasks', 'readwrite'),
      store = tx.objectStore('tasks'),
      base = {
        description: '',
        notes: '',
        projectId: null,
        sectionId: null,
        parentId: null,
        priority: 4,
        labelIds: [],
        expanded: true,
        planDate: null,
        completedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        revision: 0,
      }
    store.add({
      ...base,
      id: parent,
      title: '月末写作',
      order: 1024,
      planDate: '2099-01-31',
      repeat: { frequency: 'month', interval: 1, anchorDate: '2099-01-31', monthDays: [31] },
    })
    store.add({ ...base, id: child, parentId: parent, title: '本期工作', order: 2048, planDate: '2099-02-01' })
    store.add({ ...base, id: done, parentId: parent, title: '先完成的工作', order: 3072, completedAt: now - 1000 })
    store.add({ ...base, id: deleted, parentId: parent, title: '先删除的工作', order: 4096, deletedAt: now - 1000, deletionId })
    await new Promise((r) => (tx.oncomplete = r))
    db.close()
    return { parent, child, done, deleted }
  })
  await page.reload()
  const before = await state(page)
  await row(page, ids.parent)
    .getByRole('checkbox', { name: '完成任务', exact: true })
    .first()
    .dblclick()
  await expect.poll(async () => (await state(page)).taskCompletions.length).toBe(2)
  let advanced = await state(page)
  expect(advanced.tasks.find((t) => t.id === ids.parent).planDate).toBe('2099-02-28')
  expect(advanced.tasks.find((t) => t.id === ids.child).planDate).toBe('2099-03-01')
  expect(advanced.tasks.find((t) => t.id === ids.deleted)).toEqual(
    before.tasks.find((t) => t.id === ids.deleted),
  )
  expect(advanced.tasks.find((t) => t.id === ids.done).completedAt).toBeNull()
  await page.goto('/#/tasks/completed')
  await page.getByText('完成历史', { exact: true }).click()
  await page
    .locator('details p')
    .filter({ hasText: '月末写作' })
    .getByRole('button', { name: '恢复本次完成', exact: true })
    .click()
  await expect.poll(async () => (await state(page)).taskCompletions.length).toBe(4)
  const restored = await state(page)
  for (const task of before.tasks) {
    const current = restored.tasks.find((t) => t.id === task.id)
    expect({
      date: current.planDate,
      completed: current.completedAt,
      deleted: current.deletedAt,
    }).toEqual({ date: task.planDate, completed: task.completedAt, deleted: task.deletedAt })
  }
  await page.goto('/#/tasks/all')
  await row(page, ids.parent).getByRole('checkbox', { name: '完成任务', exact: true }).first().click()
  await expect.poll(async () => (await state(page)).taskCompletions.length).toBe(6)
  await page.getByRole('button', { name: '月末写作', exact: true }).click()
  const subInput = page.locator(`[data-task-id="${ids.child}"] .task-sub-title`)
  await subInput.fill('本期工作（后续独立修改）')
  await subInput.press('Enter')
  await expect.poll(async () => (await state(page)).tasks.find((t) => t.id === ids.child).title).toBe('本期工作（后续独立修改）')
  const changed = await state(page)
  await page.goto('/#/tasks/completed')
  await page.getByText('完成历史', { exact: true }).click()
  await page
    .locator('details p')
    .filter({ hasText: '月末写作' })
    .getByRole('button', { name: '恢复本次完成', exact: true })
    .click()
  await expect(page.locator('.undo-toast')).toBeVisible()
  expect(await state(page)).toEqual(changed)
})
test('已发布 v8 升级中断原子回滚，再次升级保留元数据、原文、批注、历史、灵感及索引', async ({
  page,
}) => {
  await page.goto('/appearance.js')
  await page.evaluate(async () => {
    const q = indexedDB.open('new-world-library', 8)
    q.onupgradeneeded = () => {
      const db = q.result,
        books = db.createObjectStore('books', { keyPath: ['library', 'id'] })
      books.createIndex('byLibrary', 'library')
      books.createIndex('byLibraryDigest', ['library', 'digest'], { unique: false })
      db.createObjectStore('files', { keyPath: ['library', 'id'] })
      const editions = db.createObjectStore('editions', { keyPath: ['library', 'bookId', 'id'] })
      editions.createIndex('byBook', ['library', 'bookId'])
      editions.createIndex('byName', ['library', 'bookId', 'name'], { unique: true })
      const chapters = db.createObjectStore('chapters', {
        keyPath: ['library', 'bookId', 'editionId', 'id'],
      })
      chapters.createIndex('byBook', ['library', 'bookId'])
      chapters.createIndex('byEdition', ['library', 'bookId', 'editionId'])
      for (const [name, keyPath] of [
        ['trash', 'id'],
        ['ideas', 'id'],
        ['writingDays', 'date'],
        ['revisionBlobs', 'hash'],
      ])
        db.createObjectStore(name, { keyPath })
      const revisions = db.createObjectStore('revisions', { keyPath: 'id' })
      revisions.createIndex('byChapter', ['library', 'bookId', 'editionId', 'chapterId'])
      revisions.createIndex('byEdition', ['library', 'bookId', 'editionId'])
      revisions.createIndex('byBook', ['library', 'bookId'])
      const baselines = db.createObjectStore('aiBaselines', {
        keyPath: ['clientId', 'library', 'bookId', 'editionId', 'chapterId'],
      })
      baselines.createIndex('byEdition', ['library', 'bookId', 'editionId'])
      baselines.createIndex('byBook', ['library', 'bookId'])
      const ideas = db.createObjectStore('ideaRevisions', { keyPath: 'id' })
      ideas.createIndex('byIdea', 'ideaId')
      ideas.createIndex('byBook', ['library', 'bookId'])
    }
    await new Promise((r, j) => {
      q.onsuccess = r
      q.onerror = () => j(q.error)
    })
    q.result.close()
  })
  const work = await page.evaluate(
    seedProject,
    projectFixture('reference', pixel.toString('base64')),
  )
  await page.evaluate(async (id) => {
    const db = await new Promise((r) => {
        const q = indexedDB.open('new-world-library')
        q.onsuccess = () => r(q.result)
      }),
      tx = db.transaction('books', 'readwrite'),
      store = tx.objectStore('books'),
      q = store.get(['reference', id])
    q.onsuccess = () =>
      store.put({
        ...q.result,
        metadata: {
          author: '旧作品作者',
          synopsis: '第一段\r\n\r\n第二段',
          future: { stable: true },
        },
      })
    await new Promise((r) => (tx.oncomplete = r))
    db.close()
  }, work.root)
  const before = await state(page)
  await page.addInitScript(() => {
    if (location.hash !== '#/tasks/abort-upgrade') return
    const open = indexedDB.open.bind(indexedDB)
    indexedDB.open = function (...args) {
      const q = open(...args)
      q.addEventListener('upgradeneeded', (event) => {
        if (event.oldVersion === 8) queueMicrotask(() => q.transaction?.abort())
      })
      return q
    }
  })
  await page.goto('/#/tasks/abort-upgrade')
  await expect(page.locator('.task-content .notice-error')).toBeVisible()
  expect(await state(page)).toEqual(before)
  await page.goto('/appearance.js')
  await page.goto('/#/tasks')
  await expect(page.getByLabel('快速添加任务', { exact: true })).toBeVisible()
  const expected = { ...before }
  for (const name of [
    'tasks',
    'taskProjects',
    'taskSections',
    'taskLabels',
    'taskCompletions',
    'taskSettings',
    'taskFilters',
    'taskTemplates',
    'taskAttachments',
    'writingStyles',
    'storyBoards',
    'bookChats',
    'foreshadowing',
  ])
    expected[name] = []
  expect(await state(page)).toEqual(expected)
  expect(
    await page.evaluate(async () => {
      const q = indexedDB.open('new-world-library')
      await new Promise((r) => (q.onsuccess = r))
      const result = {
        version: q.result.version,
        unique: q.result.transaction('books').objectStore('books').index('byLibraryDigest').unique,
      }
      q.result.close()
      return result
    }),
  ).toEqual({ version: 15, unique: false })
  await page.goto(`/#/reference/${work.root}/${work.firstEdition}`)
  await expect(page.getByRole('textbox', { name: '章节正文', exact: true })).toContainText(
    '灯塔亮了。',
  )
})
test('分批列表不截断数据，连续搜索保留焦点，快捷添加与撤销真实写入', async ({ page }) => {
  await page.goto('/#/tasks/all')
  await expect(page.getByLabel('快速添加任务', { exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const db = await new Promise((r) => {
        const q = indexedDB.open('new-world-library')
        q.onsuccess = () => r(q.result)
      }),
      tx = db.transaction('tasks', 'readwrite')
    for (let i = 0; i < 205; i++)
      tx.objectStore('tasks').add({
        id: crypto.randomUUID(),
        title: '批量任务 ' + i,
        description: '',
        notes: '',
        parentId: null,
        projectId: null,
        sectionId: null,
        priority: 4,
        labelIds: [],
        order: (i + 1) * 1024,
        expanded: true,
        planDate: null,
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
  await expect(page.locator('.task-row')).toHaveCount(200)
  await page.getByRole('button', { name: '继续载入任务或历史记录', exact: true }).click()
  await expect(page.locator('.task-row')).toHaveCount(205)
  const search = page.getByRole('searchbox', { name: '搜索任务', exact: true })
  await search.pressSequentially('批量任务')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('批量任务')
  expect((await state(page)).tasks).toHaveLength(205)
  await search.fill('')
  await page.getByRole('heading', { name: '灵感与任务', exact: true }).click()
  await page.keyboard.press('n')
  const quick = page.getByLabel('快速添加任务', { exact: true })
  await expect(quick).toBeFocused()
  await quick.fill('快捷新任务')
  await quick.press('Enter')
  await expect.poll(async () => (await state(page)).tasks.length).toBe(206)
  await page.getByRole('heading', { name: '灵感与任务', exact: true }).click()
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await state(page)).tasks.length).toBe(205)
})

test('编辑已完成任务只更新编辑字段，保留旧父任务、项目、分区和描述', async ({ page }) => {
  await page.goto('/#/tasks')
  await expect(page.getByLabel('快速添加任务', { exact: true })).toBeVisible()
  const ids = await page.evaluate(async () => {
    const ancestor = crypto.randomUUID(),
      project = crypto.randomUUID(),
      section = crypto.randomUUID(),
      parent = crypto.randomUUID(),
      child = crypto.randomUUID(),
      now = Date.now(),
      db = await new Promise((r) => {
        const q = indexedDB.open('new-world-library')
        q.onsuccess = () => r(q.result)
      }),
      tx = db.transaction(['tasks', 'taskProjects', 'taskSections'], 'readwrite')
    tx.objectStore('taskProjects').add({
      id: project,
      name: '保留归属的项目',
      color: '#123456',
      icon: '',
      parentId: ancestor,
      order: 1024,
      favorite: false,
      archivedAt: null,
      deletedAt: null,
      revision: 0,
    })
    tx.objectStore('taskProjects').add({
      id: ancestor,
      name: '祖项目',
      color: '#654321',
      icon: '',
      parentId: null,
      order: 2048,
      favorite: false,
      archivedAt: null,
      deletedAt: null,
      revision: 0,
    })
    tx.objectStore('taskSections').add({
      id: section,
      projectId: project,
      name: '原分区',
      order: 1024,
      deletedAt: null,
      revision: 0,
    })
    const task = {
      title: '已完成父任务',
      description: '保留旧描述',
      notes: '',
      projectId: project,
      sectionId: section,
      parentId: null,
      priority: 2,
      labelIds: [],
      order: 1024,
      expanded: true,
      planDate: null,
      completedAt: now,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      revision: 0,
    }
    tx.objectStore('tasks').add({ ...task, id: parent })
    tx.objectStore('tasks').add({ ...task, id: child, parentId: parent, title: '保留关系的子任务' })
    await new Promise((r) => (tx.oncomplete = r))
    db.close()
    return { project, section, parent, child, ancestor }
  })
  await page.goto('/#/tasks/item/' + ids.child)
  await page.getByRole('button', { name: '保留关系的子任务', exact: true }).click()
  const card = row(page, ids.child).locator('.task-card')
  await expect(card.locator('.task-legacy-box')).toContainText('保留旧描述')
  await card.getByLabel('任务备注', { exact: true }).fill('完成后编辑')
  await card.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(card).toHaveCount(0)
  const task = (await state(page)).tasks.find((t) => t.id === ids.child)
  expect(task).toMatchObject({
    parentId: ids.parent,
    projectId: ids.project,
    sectionId: ids.section,
    description: '保留旧描述',
    priority: 2,
    notes: '完成后编辑',
    deletedAt: null,
  })
  expect(task.completedAt).not.toBeNull()
})

test('今日和未来视图跨午夜自动更新，不修改计划日期或伪造完成记录', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-17T23:59:50Z') })
  await page.clock.setFixedTime(new Date('2026-11-17T23:59:50Z'))
  await page.goto('/#/tasks/today')
  await expect(page.getByLabel('快速添加任务', { exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const db = await new Promise((r) => {
        const q = indexedDB.open('new-world-library')
        q.onsuccess = () => r(q.result)
      }),
      tx = db.transaction('tasks', 'readwrite'),
      now = Date.now(),
      task = {
        description: '',
        notes: '',
        parentId: null,
        projectId: null,
        sectionId: null,
        priority: 4,
        labelIds: [],
        order: 1024,
        expanded: true,
        completedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        revision: 0,
      }
    for (const [title, planDate] of [
      ['今天计划', '2026-11-17'],
      ['明天计划', '2026-11-18'],
    ])
      tx.objectStore('tasks').add({ ...task, id: crypto.randomUUID(), title, planDate })
    await new Promise((r) => (tx.oncomplete = r))
    db.close()
  })
  await page.reload()
  await expect(page.getByRole('button', { name: '今天计划', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '明天计划', exact: true })).toHaveCount(0)
  const before = await state(page)
  await page.clock.setFixedTime(new Date('2026-11-18T00:00:30Z'))
  await page.clock.fastForward(40000)
  await expect(page.getByRole('button', { name: '明天计划', exact: true })).toBeVisible()
  expect(await state(page)).toEqual(before)
  await page.getByRole('link', { name: '即将到来', exact: true }).click()
  await expect(page.getByRole('button', { name: '明天计划', exact: true })).toHaveCount(0)
})

test('连续完成历史使用真实时间，逆序 UUID 下正确恢复最新周期、取消完成及恢复父任务', async ({
  page,
}) => {
  await page.goto('/#/tasks/completed')
  await expect(page.getByRole('heading', { name: '灵感与任务', exact: true })).toBeVisible()
  const ids = await page.evaluate(async () => {
    const repeat = crypto.randomUUID(),
      plain = crypto.randomUUID(),
      parent = crypto.randomUUID(),
      child = crypto.randomUUID(),
      base = Date.now() - 10000,
      db = await new Promise((r) => {
        const q = indexedDB.open('new-world-library')
        q.onsuccess = () => r(q.result)
      }),
      tx = db.transaction(['tasks', 'taskCompletions'], 'readwrite'),
      store = tx.objectStore('tasks'),
      history = tx.objectStore('taskCompletions')
    const row = {
      description: '',
      notes: '',
      projectId: null,
      sectionId: null,
      parentId: null,
      priority: 4,
      labelIds: [],
      order: 1024,
      expanded: true,
      planDate: null,
      completedAt: base + 3000,
      deletedAt: null,
      createdAt: base,
      updatedAt: base + 3000,
      revision: 6,
    }
    store.add({
      ...row,
      id: repeat,
      title: '连续重复任务',
      completedAt: null,
      planDate: '2099-01-04',
      repeat: { frequency: 'day', interval: 1, anchorDate: '2099-01-01' },
    })
    store.add({ ...row, id: plain, title: '取消最新完成' })
    store.add({ ...row, id: parent, title: '恢复最新父完成' })
    store.add({ ...row, id: child, title: '恢复子完成', parentId: parent })
    const ids = [
      'ffffffff-ffff-4fff-8fff-fffffffffff1',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      '00000000-0000-4000-8000-000000000001',
    ]
    for (let i = 0; i < 3; i++) {
      const date = '2099-01-0' + (i + 1),
        next = '2099-01-0' + (i + 2)
      history.add({
        id: ids[i],
        taskId: repeat,
        title: '连续重复任务',
        at: base + (i + 1) * 1000,
        occurrence: date,
        next,
        cycle: [{ taskId: repeat, planDate: date, completedAt: null, revision: (i + 1) * 2 }],
      })
    }
    const event = (id, taskId, title, at) => ({ id, taskId, title, at, occurrence: null }),
      plainOld = 'ffffffff-ffff-4fff-8fff-fffffffffff2',
      plainLatest = '00000000-0000-4000-8000-000000000002',
      parentOld = 'ffffffff-ffff-4fff-8fff-fffffffffff3',
      parentLatest = '00000000-0000-4000-8000-000000000003'
    history.add(event(plainOld, plain, '取消最新完成', base + 1000))
    history.add(event(plainLatest, plain, '取消最新完成', base + 3000))
    history.add(event(parentOld, parent, '恢复最新父完成', base + 1000))
    history.add(event(parentLatest, parent, '恢复最新父完成', base + 3000))
    history.add(event(crypto.randomUUID(), child, '恢复子完成', base + 3000))
    await new Promise((r) => (tx.oncomplete = r))
    db.close()
    return { repeat, plain, parent, child, latest: ids[2], plainLatest, parentLatest }
  })
  await page.reload()
  await page.getByText('完成历史', { exact: true }).click()
  await page
    .locator('details p')
    .filter({ hasText: '连续重复任务' })
    .getByRole('button', { name: '恢复本次完成', exact: true })
    .first()
    .click()
  await expect
    .poll(async () => (await state(page)).taskCompletions.some((e) => e.reverts === ids.latest))
    .toBe(true)
  expect((await state(page)).tasks.find((t) => t.id === ids.repeat).planDate).toBe('2099-01-03')
  await row(page, ids.plain).getByRole('checkbox', { name: '取消完成', exact: true }).click()
  await expect
    .poll(async () =>
      (await state(page)).taskCompletions.some((e) => e.reverts === ids.plainLatest),
    )
    .toBe(true)
  await expect(
    page.locator('details').filter({ has: page.getByText('完成历史', { exact: true }) }),
  ).toHaveAttribute('open', '')
  await page
    .locator('details p')
    .filter({ hasText: '恢复子完成' })
    .getByRole('button', { name: '恢复本次完成', exact: true })
    .click()
  await expect
    .poll(async () =>
      (await state(page)).taskCompletions.some((e) => e.reverts === ids.parentLatest),
    )
    .toBe(true)
  const after = await state(page)
  expect(after.tasks.find((t) => t.id === ids.parent).completedAt).toBeNull()
  expect(after.tasks.find((t) => t.id === ids.child).parentId).toBe(ids.parent)
})
