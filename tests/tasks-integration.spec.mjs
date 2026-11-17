import { test, expect, withoutRelease } from './app-test.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { seedProject, projectFixture, databaseSnapshot } from './project-fixture.mjs'
import { seedOwnedTasks } from './task-fixture.mjs'
import { pixel } from './fixtures.mjs'
test.setTimeout(90000)
const row = (page, id) => page.locator(`[data-task-id="${id}"]`)
async function choose(page, label, path) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: label, exact: true }).click()
  await (await chooser).setFiles(path)
}
async function snapshot(page) {
  return page.evaluate(databaseSnapshot)
}
async function seed(page) {
  await page.goto('/#/')
  await expect(
    page.getByRole('button', { name: '导入 New_World 工程（.newworld）', exact: true }),
  ).toBeVisible()
  const fixture = projectFixture('original', pixel.toString('base64')),
    work = await page.evaluate(seedProject, fixture)
  return {
    ...work,
    ...(await page.evaluate(seedOwnedTasks, { ...work, content: fixture.content })),
  }
}
test('任务 JSON 真正跨书库导入与副本、模板和过滤器引用映射、坏文件拒绝和事务回滚', async ({
  page,
  browser,
}, info) => {
  const work = await seed(page)
  await page.goto('/#/tasks/all')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出任务数据（JSON）', exact: true }).click()
  const path = info.outputPath('tasks.json')
  await (await download).saveAs(path)
  const file = JSON.parse(await readFile(path, 'utf8'))
  expect(file.data.taskSettings).toEqual([])
  expect(file.data.tasks.some((t) => t.title === 'PRIVATE-GLOBAL-TASK')).toBe(true)
  const source = await snapshot(page)
  const context = await withoutRelease(await browser.newContext({ locale: 'zh-CN' })),
    clean = await context.newPage()
  try {
    await clean.goto('/#/tasks')
    await choose(clean, '导入任务数据（JSON）', path)
    const preview = clean.getByRole('dialog', { name: '任务导入预览', exact: true })
    await expect(preview).toContainText('6 条任务')
    expect((await snapshot(clean)).tasks).toEqual([])
    await preview.getByRole('button', { name: '确认导入任务', exact: true }).click()
    await expect(preview).toBeHidden()
    const imported = await snapshot(clean)
    expect(imported.tasks).toHaveLength(6)
    expect(imported.taskSettings).toEqual([])
    expect(imported.taskAttachments).toEqual(source.taskAttachments)
    expect(imported.taskTemplates).toEqual(source.taskTemplates)
    expect(imported.tasks.filter((t) => t.link).every((t) => t.link.unconfirmed)).toBe(true)
    await choose(clean, '导入任务数据（JSON）', path)
    await preview.getByLabel('任务导入方式', { exact: true }).selectOption('skip')
    await preview.getByRole('button', { name: '确认导入任务', exact: true }).click()
    await expect(preview).toBeHidden()
    expect(await snapshot(clean)).toEqual(imported)
    await choose(clean, '导入任务数据（JSON）', path)
    await expect(preview).toBeVisible()
    await clean.evaluate(() => {
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'taskAttachments') {
          this.transaction.abort()
          throw new DOMException('injected failure', 'AbortError')
        }
        return put.apply(this, args)
      }
    })
    await preview.getByLabel('任务导入方式', { exact: true }).selectOption('copy')
    await preview.getByRole('button', { name: '确认导入任务', exact: true }).click()
    await expect(preview.getByRole('alert')).toBeVisible()
    expect(await snapshot(clean)).toEqual(imported)
    await preview.getByRole('button', { name: '取消', exact: true }).click()
    await clean.reload()
    await choose(clean, '导入任务数据（JSON）', path)
    await preview.getByLabel('任务导入方式', { exact: true }).selectOption('copy')
    await preview.getByRole('button', { name: '确认导入任务', exact: true }).click()
    await expect(preview).toBeHidden()
    const copied = await snapshot(clean)
    expect(copied.tasks).toHaveLength(12)
    const parent = copied.tasks.find((t) => t.title.includes(work.root) && t.id !== work.parent)
    expect(copied.tasks.filter((t) => t.parentId === parent.id)).toHaveLength(2)
    expect(parent.projectId).not.toBe(work.subproject)
    const filter = copied.taskFilters.find((f) => f.id !== source.taskFilters[0].id)
    expect(filter.group.conditions.find((c) => c.field === 'project').value).toBe(parent.projectId)
    expect(copied.taskAttachments.find((a) => a.taskId === parent.id).sha256).toBe(
      source.taskAttachments[0].sha256,
    )
    expect(
      copied.taskTemplates.find((t) => t.id !== source.taskTemplates[0].id).tasks[0].id,
    ).not.toBe(source.taskTemplates[0].tasks[0].id)
    for (const mutate of [
      (v) => (v.resources[0].base64 = 'AAAA'),
      (v) => (v.data.tasks[0].execute = 'script'),
      (v) => (v.resources[0].bytes = 17 * 1024 * 1024),
      (v) => (v.schemaVersion = 99),
      (v) => (v.data.tasks = Array(30001).fill(null)),
    ]) {
      const bad = structuredClone(file)
      mutate(bad)
      const damaged = info.outputPath('bad.json')
      await writeFile(damaged, JSON.stringify(bad))
      await clean.locator('.undo-toast').evaluateAll((nodes) => nodes.forEach((n) => n.remove()))
      await choose(clean, '导入任务数据（JSON）', damaged)
      await expect(clean.locator('.undo-toast')).toBeVisible()
      expect(await snapshot(clean)).toEqual(copied)
    }
  } finally {
    await context.close()
  }
})
test('章节位置联动、评论/附件、复制、模板、真实统计及灵感转换不互相改状态', async ({
  page,
}, info) => {
  await page.goto('/#/')
  await expect(
    page.getByRole('button', { name: '导入 New_World 工程（.newworld）', exact: true }),
  ).toBeVisible()
  const work = await page.evaluate(
    seedProject,
    projectFixture('original', pixel.toString('base64')),
  )
  await page.goto(`/#/original/${work.root}/${work.firstEdition}`)
  const editor = page.getByRole('textbox', { name: '章节正文', exact: true })
  await editor.click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Control+Shift+ArrowRight')
  await page.getByRole('button', { name: '从当前章节创建任务', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '添加任务', exact: true })
  await dialog.getByLabel('任务标题', { exact: true }).fill('修订开篇')
  await dialog.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(dialog).toBeHidden()
  let state = await snapshot(page),
    task = state.tasks[0]
  expect(task.link).toMatchObject({
    bookId: work.root,
    editionId: work.firstEdition,
    chapterId: work.first,
  })
  expect(task.link.position.to).toBeGreaterThan(task.link.position.from)
  await page.goto('/#/tasks/all')
  await row(page, task.id).getByRole('button', { name: '评论与附件', exact: true }).click()
  let extras = page.getByRole('dialog', { name: '评论与附件', exact: true })
  await extras.getByRole('button', { name: '添加评论', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '添加评论', exact: true })
  const comment = '长评论'.repeat(250) + '\n第二行'
  await dialog.getByLabel('评论内容', { exact: true }).fill(comment)
  await dialog.getByRole('button', { name: '保存评论', exact: true }).click()
  await expect(dialog).toBeHidden()
  const bytes = Buffer.from('参考原始字节\r\n第二行\n')
  await extras
    .getByLabel('添加文件附件', { exact: true })
    .setInputFiles({ name: '参考✦.txt', mimeType: 'text/plain', buffer: bytes })
  await expect.poll(async () => (await snapshot(page)).taskAttachments.length).toBe(1)
  await extras.getByLabel('添加文件附件', { exact: true }).setInputFiles({
    name: 'unsafe.js',
    mimeType: 'text/javascript',
    buffer: Buffer.from('alert(1)'),
  })
  await expect(page.locator('.undo-toast')).toBeVisible()
  expect((await snapshot(page)).taskAttachments).toHaveLength(1)
  const download = page.waitForEvent('download')
  await extras.getByRole('button', { name: '下载附件', exact: true }).click()
  const path = info.outputPath('attachment.txt')
  await (await download).saveAs(path)
  expect(await readFile(path)).toEqual(bytes)
  await extras.getByRole('button', { name: '关闭', exact: true }).click()
  await row(page, task.id).getByRole('button', { name: '复制任务', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).tasks.length).toBe(2)
  state = await snapshot(page)
  const copy = state.tasks.find((t) => t.id !== task.id)
  expect(copy.comments[0].id).not.toBe(state.tasks.find((t) => t.id === task.id).comments[0].id)
  expect(state.taskAttachments.find((a) => a.taskId === copy.id).sha256).toBe(
    createHash('sha256').update(bytes).digest('hex'),
  )
  await row(page, task.id).getByRole('button', { name: '保存为任务模板', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '保存为任务模板', exact: true })
  await dialog.getByLabel('模板名称', { exact: true }).fill('开篇模板')
  await dialog.getByRole('button', { name: '保存为任务模板', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('link', { name: '任务模板', exact: true }).click()
  await page.getByRole('button', { name: '使用模板', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).tasks.length).toBe(3)
  await row(page, task.id).getByRole('button', { name: '完成任务', exact: true }).click()
  await page.getByRole('link', { name: '效率统计', exact: true }).click()
  await expect(page.locator('.task-stats')).toContainText('有效完成记录：1')
  await page.getByLabel('统计粒度', { exact: true }).selectOption('month')
  await expect(page.locator('.task-stats')).toContainText('有效完成记录：1')
  state = await snapshot(page)
  const originalIdeas = state.ideas,
    originalHistory = state.ideaRevisions
  await page.goto('/#/ideas')
  const idea = page
    .locator('.idea-row')
    .filter({ hasText: originalIdeas.find((i) => i.id === work.ideaId).text })
  await idea.locator('.book-menu-toggle').click()
  await page.getByRole('menuitem', { name: '将灵感转换为任务', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '添加任务', exact: true })
  await dialog.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(dialog).toBeHidden()
  state = await snapshot(page)
  expect(state.ideas).toEqual(originalIdeas)
  expect(state.ideaRevisions).toEqual(originalHistory)
  expect(state.tasks).toHaveLength(4)
  await page.goto('/#/tasks/completed')
  await row(page, task.id).getByRole('button', { name: '取消完成', exact: true }).click()
  await page.goto('/#/tasks/all')
  await row(page, task.id)
    .getByRole('button', { name: /打开关联/ })
    .click()
  await expect(editor).toContainText('灯塔亮了。')
  await expect(page.locator('.chapter-jump[aria-current]')).toHaveText('第一章 · 雾港')
  const count = (await snapshot(page)).tasks.length
  await page.goto('/#/original')
  const card = page
    .locator('.book-card')
    .filter({ has: page.locator(`a[href="#/original/${work.root}"]`) })
  await card.locator('.book-menu-toggle').click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '删除作品？', exact: true })
  await expect(dialog).toContainText('关联任务和完成历史会保留')
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect((await snapshot(page)).tasks).toHaveLength(count)
  await page.goto('/#/tasks/all')
  await row(page, task.id)
    .getByRole('button', { name: /打开关联/ })
    .click()
  await expect(page.locator('.undo-toast')).toContainText('关联作品已不在书库')
})
