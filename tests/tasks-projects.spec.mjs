import { test, expect, withoutRelease } from './app-test.mjs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js'
import { pixel } from './fixtures.mjs'
import { databaseSnapshot, projectFixture, seedProject } from './project-fixture.mjs'
import { seedOwnedTasks } from './task-fixture.mjs'
test.setTimeout(90000)
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.showSaveFilePicker = undefined
  })
})
const projectImport = '导入',
  projectExport = '导出 New_World 工程（.newworld）'
const taskNames = [
  'tasks',
  'taskProjects',
  'taskSections',
  'taskLabels',
  'taskCompletions',
  'taskAttachments',
]
async function choose(page, label, path) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: label, exact: true }).click()
  await (await chooser).setFiles(path)
}
async function fresh(browser) {
  const context = await withoutRelease(await browser.newContext({ locale: 'zh-CN' })),
    page = await context.newPage()
  await page.addInitScript(() => {
    window.showSaveFilePicker = undefined
  })
  await page.goto('/#/writing')
  await expect(page.getByRole('button', { name: projectImport, exact: true })).toBeVisible()
  return { context, page }
}
async function unpack(path) {
  const zip = new ZipReader(new Uint8ArrayReader(await readFile(path)), { useWebWorkers: false }),
    entries = new Map()
  for (const e of await zip.getEntries())
    entries.set(e.filename, await e.getData(new Uint8ArrayWriter()))
  await zip.close()
  return entries
}
async function pack(entries, path) {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const [name, bytes] of entries)
    await zip.add(name, new Uint8ArrayReader(bytes), { level: 0 })
  await writeFile(path, await zip.close())
}
function modify(entries, path, change) {
  const value = JSON.parse(Buffer.from(entries.get(path)).toString())
  change(value)
  const bytes = Buffer.from(JSON.stringify(value))
  entries.set(path, bytes)
  if (path !== 'manifest.json') {
    const manifest = JSON.parse(Buffer.from(entries.get('manifest.json')).toString()),
      r = manifest.resources.find((r) => r.path === path)
    r.bytes = bytes.length
    r.sha256 = createHash('sha256').update(bytes).digest('hex')
    entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  }
}
async function exportWork(page, work, path) {
  await page.goto('/#/' + work.library)
  const card = page
    .locator('.book-card')
    .filter({ has: page.locator(`a[href="#/${work.library}/${work.root}"]`) })
  await card.locator('.book-menu-toggle').click()
  await page.getByRole('menuitem', { name: projectExport, exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存工程', exact: true }).click()
  await (await download).saveAs(path)
  await expect(page.getByRole('dialog', { name: projectExport })).toBeHidden()
}
async function seed(page, library = 'original') {
  await page.goto('/#/writing')
  await expect(page.getByRole('button', { name: projectImport })).toBeVisible()
  const fixture = projectFixture(library, pixel.toString('base64')),
    work = await page.evaluate(seedProject, fixture),
    tasks = await page.evaluate(seedOwnedTasks, { ...work, content: fixture.content })
  return { ...work, ...tasks }
}
for (const library of ['original', 'reference'])
  test(`${library} Schema 3 任务、附件、回收记录跨书库无损往返，个人数据不泄露，副本引用重映射`, async ({
    page,
    browser,
  }, info) => {
    const work = await seed(page, library),
      before = await page.evaluate(databaseSnapshot),
      path = info.outputPath('中文「任务」.newworld')
    await exportWork(page, work, path)
    expect(await page.evaluate(databaseSnapshot)).toEqual(before)
    const entries = await unpack(path),
      manifest = JSON.parse(Buffer.from(entries.get('manifest.json')).toString())
    expect(manifest.schemaVersion).toBe(3)
    for (const bytes of entries.values())
      expect(Buffer.from(bytes).toString()).not.toContain('PRIVATE-')
    if (process.env.UPDATE_TASK_EXAMPLE === '1' && library === 'original') {
      await mkdir('docs/examples', { recursive: true })
      await writeFile('docs/examples/雾港-创作任务.newworld', await readFile(path))
    }
    const clean = await fresh(browser)
    try {
      await choose(clean.page, projectImport, path)
      const preview = clean.page.getByRole('dialog', { name: '导入工程预览', exact: true })
      await expect(preview).toContainText('作品关联任务：3 条')
      expect((await clean.page.evaluate(databaseSnapshot)).tasks).toEqual([])
      await preview.getByRole('button', { name: '确认导入', exact: true }).click()
      await expect(preview).toBeHidden()
      const restored = await clean.page.evaluate(databaseSnapshot),
        expected = Object.fromEntries(taskNames.map((name) => [name, before[name]]))
      expected.tasks = expected.tasks.filter((t) =>
        [work.parent, work.child, work.deleted].includes(t.id),
      )
      expected.taskLabels = expected.taskLabels.filter((l) => l.id === work.label)
      for (const name of taskNames) expect(restored[name], name).toEqual(expected[name])
      expect(restored.taskSettings).toEqual([])
      expect(restored.taskFilters).toEqual([])
      expect(restored.taskTemplates).toEqual([])
      const second = info.outputPath('再导出.newworld')
      await exportWork(clean.page, work, second)
      const again = await unpack(second)
      entries.delete('manifest.json')
      again.delete('manifest.json')
      expect([...again]).toEqual([...entries])
      await clean.page.goto('/#/writing')
      await choose(clean.page, projectImport, path)
      await preview.getByLabel('导入方式').selectOption('copy')
      await preview.getByRole('button', { name: '确认导入', exact: true }).click()
      await expect(preview).toBeHidden()
      const copied = await clean.page.evaluate(databaseSnapshot),
        newWork = copied.books.find((b) => !b.workId && b.id !== work.root),
        newTasks = copied.tasks.filter((t) => t.link.bookId === newWork.id)
      expect(newTasks).toHaveLength(3)
      const parent = newTasks.find((t) => !t.parentId)
      expect(parent.id).not.toBe(work.parent)
      expect(parent.title).toContain(work.root)
      expect(parent.link.chapterId).not.toBe(work.first)
      expect(parent.comments[0].id).not.toBe(
        expected.tasks.find((t) => t.id === work.parent).comments[0].id,
      )
      for (const child of newTasks.filter((t) => t.parentId)) expect(child.parentId).toBe(parent.id)
      expect(copied.taskAttachments.find((a) => a.taskId === parent.id).content).toEqual(
        expected.taskAttachments[0].content,
      )
      expect(parent.projectId).not.toBe(work.subproject)
      expect(parent.labelIds).not.toContain(work.label)
      await clean.page.goto(`/#/tasks/work/${library}/${newWork.id}`)
      await clean.page.getByRole('button', { name: parent.title, exact: true }).click()
      const card = clean.page.locator(`[data-task-id="${parent.id}"] .task-card`)
      await card.getByLabel('任务备注', { exact: true }).fill('继续编辑导入任务')
      await card.getByRole('button', { name: '保存任务', exact: true }).click()
      await expect(card).toHaveCount(0)
      await clean.page.reload()
      expect(
        (await clean.page.evaluate(databaseSnapshot)).tasks.find((t) => t.id === parent.id).notes,
      ).toBe('继续编辑导入任务')
      expect(
        (await clean.page.evaluate(databaseSnapshot)).tasks.find((t) => t.id === parent.id)
          .reminderMinutes,
      ).toBe(45)
    } finally {
      await clean.context.close()
    }
  })
test('Schema 3 损坏、未知字段、错误引用和危险附件明确拒绝，附件写入中断整体回滚', async ({
  page,
  browser,
}, info) => {
  const work = await seed(page),
    source = info.outputPath('source.newworld')
  await exportWork(page, work, source)
  const entries = await unpack(source),
    manifest = JSON.parse(Buffer.from(entries.get('manifest.json')).toString()),
    clean = await fresh(browser)
  try {
    const before = await clean.page.evaluate(databaseSnapshot)
    const cases = [
      ['future', (e) => modify(e, 'manifest.json', (m) => (m.schemaVersion = 4))],
      ['unknown', (e) => modify(e, manifest.records.tasks, (v) => (v[0].runCode = 'unsafe'))],
      [
        'parent',
        (e) => modify(e, manifest.records.tasks, (v) => (v[0].parentId = crypto.randomUUID())),
      ],
      [
        'foreign',
        (e) => modify(e, manifest.records.tasks, (v) => (v[0].link.bookId = crypto.randomUUID())),
      ],
      [
        'dangerous',
        (e) =>
          modify(e, manifest.records.taskAttachments, (v) => {
            v[0].name = 'evil.html'
            v[0].type = 'text/html'
          }),
      ],
      [
        'missing',
        (e) => {
          const a = JSON.parse(Buffer.from(e.get(manifest.records.taskAttachments)).toString())[0]
          e.delete(a.content.$resource)
        },
      ],
    ]
    for (const [name, mutate] of cases) {
      const variant = new Map(entries)
      mutate(variant)
      const path = info.outputPath(name + '.newworld')
      await pack(variant, path)
      await clean.page
        .locator('.undo-toast')
        .evaluateAll((nodes) => nodes.forEach((n) => n.remove()))
      await choose(clean.page, projectImport, path)
      await expect(clean.page.locator('.undo-toast')).toBeVisible()
      await expect(
        clean.page.getByRole('dialog', { name: '导入工程预览', exact: true }),
      ).toHaveCount(0)
      expect(await clean.page.evaluate(databaseSnapshot)).toEqual(before)
    }
    await choose(clean.page, projectImport, source)
    const preview = clean.page.getByRole('dialog', { name: '导入工程预览', exact: true })
    await expect(preview).toBeVisible()
    await clean.page.evaluate(() => {
      const add = IDBObjectStore.prototype.add
      IDBObjectStore.prototype.add = function (...args) {
        if (this.name === 'taskAttachments') {
          this.transaction.abort()
          throw new DOMException('injected attachment failure', 'AbortError')
        }
        return add.apply(this, args)
      }
    })
    await preview.getByRole('button', { name: '确认导入', exact: true }).click()
    await expect(preview.getByRole('alert')).toBeVisible()
    expect(await clean.page.evaluate(databaseSnapshot)).toEqual(before)
  } finally {
    await clean.context.close()
  }
})
test('已发布 Schema 2 文件可直接导入，旧字段及未知元数据保留，任务为空', async ({ page }) => {
  await page.goto('/#/writing')
  await choose(page, projectImport, resolve('docs/examples/雾港-作品信息.newworld'))
  const preview = page.getByRole('dialog', { name: '导入工程预览', exact: true })
  await preview.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(preview).toBeHidden()
  const snapshot = await page.evaluate(databaseSnapshot)
  expect(snapshot.tasks).toEqual([])
  expect(snapshot.books[0].metadata.author).toBeTruthy()
  expect(snapshot.books[0].metadata.future).toBeDefined()
})

test('周期成员后来移为个人任务时只保留断开历史身份，不泄漏其当前内容也不补造任务', async ({
  page,
  browser,
}, info) => {
  const work = await seed(page)
  await page.goto(`/#/tasks/work/original/${work.root}`)
  await expect(page.getByRole('button', { name: 'PRIVATE-UNCONFIRMED', exact: true })).toHaveCount(
    0,
  )
  const parent = page.locator(`[data-task-id="${work.parent}"]`)
  await parent.getByRole('checkbox', { name: '完成任务', exact: true }).first().click()
  await expect
    .poll(async () => (await page.evaluate(databaseSnapshot)).taskCompletions.length)
    .toBe(2)
  await page.evaluate(async (childId) => {
    const db = await new Promise((r) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => r(q.result)
    })
    const tx = db.transaction('tasks', 'readwrite')
    const store = tx.objectStore('tasks')
    const child = await new Promise((r) => {
      const q = store.get(childId)
      q.onsuccess = () => r(q.result)
    })
    const updated = { ...child, parentId: null, title: 'PRIVATE-MOVED-CURRENT', notes: 'PRIVATE-MOVED-NOTES', revision: child.revision + 1 }
    delete updated.link
    store.put(updated)
    await new Promise((r) => (tx.oncomplete = r))
    db.close()
  }, work.child)
  const path = info.outputPath('detached-history.newworld')
  await exportWork(page, work, path)
  const entries = await unpack(path),
    manifest = JSON.parse(Buffer.from(entries.get('manifest.json')).toString())
  expect(manifest.detached.tasks).toEqual([work.child])
  for (const bytes of entries.values())
    expect(Buffer.from(bytes).toString()).not.toContain('PRIVATE-MOVED-')
  const clean = await fresh(browser)
  try {
    await choose(clean.page, projectImport, path)
    const preview = clean.page.getByRole('dialog', { name: '导入工程预览', exact: true })
    await preview.getByRole('button', { name: '确认导入', exact: true }).click()
    await expect(preview).toBeHidden()
    const before = await clean.page.evaluate(databaseSnapshot)
    expect(before.tasks).toHaveLength(2)
    expect(before.tasks.some((t) => t.id === work.child)).toBe(false)
    await clean.page.goto('/#/tasks/completed')
    await clean.page.getByText('完成历史', { exact: true }).click()
    await clean.page.getByRole('button', { name: '恢复本次完成', exact: true }).click()
    await expect(clean.page.locator('.undo-toast')).toContainText('无法自动恢复该周期')
    expect(await clean.page.evaluate(databaseSnapshot)).toEqual(before)
    await clean.page.goto('/#/tasks/all')
    await clean.page.getByRole('button', { name: '作品任务 · ' + work.root, exact: true }).click()
    const edit = clean.page.locator('.task-card')
    await edit.getByLabel('任务备注', { exact: true }).fill('保留断开历史后继续编辑')
    await edit.getByRole('button', { name: '保存任务', exact: true }).click()
    await expect(edit).toHaveCount(0)
  } finally {
    await clean.context.close()
  }
})
