import { readFile, writeFile } from 'node:fs/promises'
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { expect, pastFirstVisit, test } from './app-test.mjs'
import { bookAction, pixel } from './fixtures.mjs'
import { chapterAction, chapterHeading, chapterTitles, editorAction, moveChapter, workAction } from './editor-helpers.mjs'
import { addStoryChapter, newStoryWork, renameStoryChapter } from './story-settings-helpers.mjs'
import { createLegacyDatabase } from './legacy-database.mjs'
import { startWork } from './navigation-helpers.mjs'
import { databaseSnapshot, projectFixture, seedProject } from './project-fixture.mjs'

const button = (host, name) => host.getByRole('button', { name, exact: true })
const link = (host, name) => host.getByRole('link', { name, exact: true })
const combo = (host, name) => host.getByRole('combobox', { name, exact: true })
const field = (host, name) => host.getByLabel(name, { exact: true })
const form = (page) => page.locator('.foreshadowing-form')
const entry = (page, title) => page.locator('.foreshadowing-entry').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
const editor = (page) => page.getByRole('textbox', { name: '章节正文', exact: true })
const boxPath = (work) => `/#/${work.library}/${work.root}/foreshadowing`

async function addEntry(page, title) {
  await button(page, '新增伏笔').click()
  await field(form(page), '标题').fill(title)
  return form(page)
}

async function finish(page) {
  await button(form(page), '完成').click()
  await expect(form(page)).toBeHidden()
}

async function addLocation(page, kind, chapter, note) {
  const setup = kind === '埋设位置'
  const group = form(page).getByRole('group', { name: kind, exact: true })
  await button(group, setup ? '添加埋设位置' : '添加回收位置').click()
  if (chapter) await combo(group, '关联章节').last().selectOption({ label: chapter })
  if (note) await field(group, setup ? '段落、原文或位置说明' : '回收方式或位置说明').last().fill(note)
}

async function deleteChapter(page, name) {
  await chapterAction(page, name, '删除章节')
  await button(page.getByRole('dialog'), '确认删除章节').click()
  await expect(page.getByRole('dialog')).toBeHidden()
}

async function saveDownload(page, info, name, save) {
  const download = page.waitForEvent('download')
  await save()
  const path = info.outputPath(name)
  await (await download).saveAs(path)
  return path
}

async function archive(path) {
  const zip = new ZipReader(new Uint8ArrayReader(await readFile(path)), { useWebWorkers: false })
  try {
    const data = new Map()
    for (const entry of await zip.getEntries()) data.set(entry.filename, await entry.getData(new Uint8ArrayWriter()))
    return data
  } finally { await zip.close() }
}

const json = (files, path) => JSON.parse(Buffer.from(files.get(path)).toString('utf8'))
async function writeArchive(path, files, manifestName, manifest) {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 })
  for (const [name, data] of files) {
    await zip.add(name, name === manifestName ? new TextReader(JSON.stringify(manifest)) : new Uint8ArrayReader(data))
  }
  await writeFile(path, await zip.close())
}

async function importProject(page, path, copy = false) {
  await page.goto('/#/writing')
  const chooser = page.waitForEvent('filechooser')
  await button(page, '导入').click()
  await (await chooser).setFiles(path)
  const dialog = page.getByRole('dialog', { name: '导入工程预览' })
  await expect(dialog).toBeVisible({ timeout: 12_000 })
  if (copy) await combo(dialog, '导入方式').selectOption('copy')
  await button(dialog, '确认导入').click()
  await expect(dialog).toBeHidden()
}

async function restoreBackup(page, path) {
  await page.goto('/#/settings/backup')
  const chooser = page.waitForEvent('filechooser')
  await button(page, '从备份恢复…').click()
  await (await chooser).setFiles(path)
  await button(page.getByRole('dialog', { name: '从备份恢复' }), '替换当前书库').click()
  await expect(page.getByText(/已从备份恢复/)).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.showSaveFilePicker = undefined })
})

test('伏笔增删改、自动保存、搜索筛选和章节侧栏 @webkit', async ({ page }) => {
  await page.goto('/#/writing')
  await newStoryWork(page, '雾中钟声')
  await addStoryChapter(page, '靠岸')
  await addStoryChapter(page, '夜航')
  await workAction(page, '伏笔箱')
  await addEntry(page, '顺手记下的承诺')
  await expect(form(page).getByRole('status')).toHaveText('已保存')
  await page.reload()
  await expect(entry(page, '顺手记下的承诺')).toBeVisible()
  await expect(page.locator('.foreshadowing-counts')).toHaveText('共 1 条伏笔 · 未回收 1 条')

  const details = await addEntry(page, '钟声')
  await field(details, '详细描述').fill('Only the shipwright knows the signal.')
  await field(details, '备注').fill('约好在退潮时响起。')
  await addLocation(page, '埋设位置', '第一章', '第二段：船匠放下铜钟。')
  await addLocation(page, '埋设位置', '靠岸', '主角认出声音。')
  await addLocation(page, '回收位置', '靠岸', '船匠以钟声示警。')
  await addLocation(page, '回收位置', '夜航', '船队听到钟声后掉头。')
  await addLocation(page, '回收位置', undefined, '后续还可以补一个解释。')
  await finish(page)
  const clue = entry(page, '钟声')
  await expect(clue).toContainText('第二段：船匠放下铜钟。')
  await expect(clue).toContainText('船匠以钟声示警。')
  await expect(clue).toContainText('后续还可以补一个解释。')
  await expect(clue.getByRole('link')).toHaveCount(4)

  const search = page.getByRole('searchbox', { name: '搜索伏笔标题或描述' })
  await search.fill('SHIPWRIGHT')
  await expect(page.locator('.foreshadowing-entry')).toHaveCount(1)
  await expect(clue).toBeVisible()
  await search.fill('承诺')
  await expect(entry(page, '顺手记下的承诺')).toBeVisible()
  await expect(clue).toBeHidden()
  await search.clear()

  const filters = page.getByRole('group', { name: '按状态筛选' })
  await button(filters, '未回收').click()
  await button(clue, '标为已回收').click()
  await expect(clue).toBeHidden()
  await expect(page.locator('.foreshadowing-counts')).toHaveText('共 2 条伏笔 · 未回收 1 条')
  await button(filters, '已回收').click()
  await expect(clue).toContainText('约好在退潮时响起。')
  await button(clue, '标为未回收').click()
  await expect(clue).toBeHidden()
  await button(filters, '全部').click()

  await link(clue, '第一章').click()
  await expect(chapterHeading(page)).toHaveText('第一章')
  await editor(page).fill('手稿留在编辑器中。')
  await editorAction(page, '本章伏笔')
  const side = page.locator('.foreshadowing-chapter-panel')
  await expect(side).toContainText('钟声')
  await expect(side).not.toContainText('顺手记下的承诺')
  await expect(editor(page)).toHaveText('手稿留在编辑器中。')
  await link(side, '管理本章伏笔').click()
  await expect(page.locator('.foreshadowing-scope')).toContainText('本章伏笔 · 第一章')
  await expect(page.locator('.foreshadowing-entry')).toHaveCount(1)
  await button(clue, '编辑').click()
  await field(form(page), '详细描述').fill('船匠知道信号。')
  // The back link uses the same leave guard as the manuscript editor.
  await link(page, '返回章节').click()
  await expect(chapterHeading(page)).toHaveText('第一章')
  await expect(editor(page)).toHaveText('手稿留在编辑器中。')
  await workAction(page, '伏笔箱')
  await expect(clue).toContainText('船匠知道信号。')
  await button(clue, '删除').click()
  await button(page.getByRole('dialog', { name: '删除这条伏笔？' }), '删除').click()
  await expect(clue).toBeHidden()
  await expect(entry(page, '顺手记下的承诺')).toBeVisible()
})

test('章节改名、移动、删除和恢复保留伏笔关联，失效关联可以重选', async ({ page }) => {
  await page.goto('/#/writing')
  await newStoryWork(page, '旧船票')
  await addStoryChapter(page, '渡口')
  const work = { library: 'original', root: new URL(page.url()).hash.split('/')[2] }
  await workAction(page, '伏笔箱')
  await addEntry(page, '票根上的记号')
  await addLocation(page, '埋设位置', '渡口', '写在船票背面。')
  await finish(page)
  const clue = entry(page, '票根上的记号')
  const linkedPath = await link(clue, '渡口').getAttribute('href')
  await link(clue, '渡口').click()
  await expect(chapterHeading(page)).toHaveText('渡口')
  await renameStoryChapter(page, '渡口', '旧渡口')
  await moveChapter(page, '旧渡口', 'up')
  await expect.poll(() => chapterTitles(page)).toEqual(['旧渡口', '第一章'])
  await workAction(page, '伏笔箱')
  await expect(link(clue, '旧渡口')).toHaveAttribute('href', linkedPath)
  await link(clue, '旧渡口').click()
  await expect(chapterHeading(page)).toHaveText('旧渡口')

  await deleteChapter(page, '旧渡口')
  await workAction(page, '伏笔箱')
  await expect(clue).toContainText('关联章节已失效')
  await expect(clue).toContainText('写在船票背面。')
  await expect(clue.getByRole('link')).toHaveCount(0)
  await page.goto('/#/trash')
  const deleted = page.getByRole('listitem').filter({ hasText: '旧渡口' })
  await button(deleted, '恢复').click()
  await expect(deleted).toHaveCount(0)
  await page.goto(boxPath(work))
  await expect(link(clue, '旧渡口')).toHaveAttribute('href', linkedPath)
  await link(clue, '旧渡口').click()
  await expect(chapterHeading(page)).toHaveText('旧渡口')

  await deleteChapter(page, '旧渡口')
  await workAction(page, '伏笔箱')
  await button(clue, '编辑').click()
  const picker = combo(form(page), '关联章节')
  await expect(picker.locator('option:checked')).toHaveText(/关联章节已失效/)
  await picker.selectOption({ label: '第一章' })
  await finish(page)
  await expect(clue).toContainText('写在船票背面。')
  await expect(clue).not.toContainText('关联章节已失效')
  await link(clue, '第一章').click()
  await expect(chapterHeading(page)).toHaveText('第一章')
})

test('工程导入、复制和旧 Schema 保留作品隔离及有效和失效的关联', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(75_000)
  await page.goto('/#/writing')
  await expect(button(page, '导入')).toBeVisible()
  const work = await page.evaluate(seedProject, projectFixture('original', pixel.toString('base64')))
  await page.goto(boxPath(work))
  await addEntry(page, '潮汐暗号')
  await addLocation(page, '埋设位置', '第一章 · 雾港', '海图背面')
  await addLocation(page, '埋设位置', '第二章 · 归航', '用暗号交接')
  await addLocation(page, '回收位置', '新的归航', '用海图避开礁石')
  await finish(page)
  const clue = entry(page, '潮汐暗号')
  await link(clue, '新的归航').click()
  await expect(chapterHeading(page)).toHaveText('新的归航')
  await expect(page).toHaveURL(new RegExp(work.secondEdition + '$'))
  await page.goto(`/#/original/${work.root}/${work.firstEdition}`)
  await deleteChapter(page, '第二章 · 归航')
  await page.goto('/#/trash')
  await button(page.getByRole('listitem').filter({ hasText: '第二章 · 归航' }), '彻底删除').click()
  await button(page.getByRole('dialog'), '确认彻底删除').click()
  await expect(page.getByText('已彻底删除「第二章 · 归航」。')).toBeVisible()

  await page.goto('/#/writing')
  await newStoryWork(page, '另一本小说')
  await workAction(page, '伏笔箱')
  await expect(clue).toHaveCount(0)
  await addEntry(page, '另一本书的暗号')
  await expect(form(page).getByRole('status')).toHaveText('已保存')
  await finish(page)
  await page.goto('/#/original')
  await bookAction(page, '导出 New_World 工程（.newworld）', '雾港 · 原创验收')
  const path = await saveDownload(page, info, '潮汐.newworld', () => button(page, '保存工程').click())
  const files = await archive(path)
  const manifest = json(files, 'manifest.json')
  const stored = json(files, manifest.records.foreshadowing)
  const removedChapter = stored[0].setups[1].chapter.chapterId
  expect(manifest.schemaVersion).toBe(5)
  expect(manifest.detached.chapters).toContain(removedChapter)
  expect(stored.map(({ title }) => title)).toEqual(['潮汐暗号'])

  const receiver = await pastFirstVisit(await browser.newContext({ baseURL, locale: 'zh-CN' }))
  try {
    const clean = await receiver.newPage()
    await importProject(clean, path)
    await clean.goto(boxPath(work))
    await expect(entry(clean, '潮汐暗号')).toContainText('关联章节已失效')
    await link(entry(clean, '潮汐暗号'), '新的归航').click()
    await expect(chapterHeading(clean)).toHaveText('新的归航')
    await importProject(clean, path, true)
    const copied = await clean.evaluate(databaseSnapshot)
    const copy = copied.foreshadowing.find((row) => row.bookId !== work.root)
    const firstEdition = copied.editions.find((row) => row.bookId === copy.bookId && row.name === '初稿')
    const secondEdition = copied.editions.find((row) => row.bookId === copy.bookId && row.name === '修订稿')
    expect(copy.id).not.toBe(stored[0].id)
    expect(copy.setups[0].chapter).toMatchObject({ editionId: firstEdition.id, chapterId: firstEdition.chapters[0].id })
    expect(copy.setups[1].chapter.chapterId).not.toBe(removedChapter)
    expect(copy.setups[1].note).toBe('用暗号交接')
    expect(copy.payoffs[0].chapter).toMatchObject({ editionId: secondEdition.id, chapterId: secondEdition.chapters[0].id })
    await clean.goto(boxPath({ library: 'original', root: copy.bookId }))
    await link(entry(clean, '潮汐暗号'), '新的归航').click()
    await expect(chapterHeading(clean)).toHaveText('新的归航')
    await expect(clean).toHaveURL(new RegExp(secondEdition.id + '$'))

    // A Schema 4 export for the same work has no foreshadowing records or detached clue IDs.
    const oldPath = info.outputPath('旧工程.newworld')
    const record = manifest.records.foreshadowing
    files.delete(record)
    delete manifest.records.foreshadowing
    manifest.resources = manifest.resources.filter(({ path }) => path !== record)
    manifest.detached.chapters = manifest.detached.chapters.filter((id) => id !== removedChapter)
    manifest.schemaVersion = 4
    await writeArchive(oldPath, files, 'manifest.json', manifest)
    await importProject(clean, oldPath, true)
    const after = await clean.evaluate(databaseSnapshot)
    const old = after.books.find((book) => !copied.books.some(({ id }) => id === book.id))
    await clean.goto(boxPath({ library: 'original', root: old.id }))
    await expect(clean.getByText('还没有伏笔。')).toBeVisible()
    expect(after.foreshadowing).toEqual(copied.foreshadowing)
  } finally { await receiver.close() }
})

test('全库备份还原活动和已删除作品的伏笔，旧备份可以恢复', async ({ page }, info) => {
  await page.goto('/#/writing')
  await newStoryWork(page, '潮声')
  const root = new URL(page.url()).hash.split('/')[2]
  await workAction(page, '伏笔箱')
  await addEntry(page, '约定的潮声')
  await addLocation(page, '回收位置', '第一章', '潮水涨过刻度。')
  await combo(form(page), '状态').selectOption('resolved')
  await finish(page)

  await page.goto('/#/writing')
  await startWork(page, 'reference')
  await field(page.getByRole('dialog'), '作品名').fill('续写潮声')
  await button(page.getByRole('dialog'), '创建小说').click()
  await link(page, '伏笔箱').click()
  const referenceId = new URL(page.url()).hash.split('/')[2]
  await expect(entry(page, '约定的潮声')).toHaveCount(0)
  await addEntry(page, '续写里的船契')
  await finish(page)
  await page.goto('/#/reference')
  await bookAction(page, '删除', '续写潮声')
  await button(page.getByRole('dialog'), '确认删除').click()
  await expect(link(page, '查看 续写潮声')).toHaveCount(0)

  await page.goto('/#/settings/backup')
  const path = await saveDownload(page, info, '潮声.zip', () => button(page, '立即备份').click())
  const files = await archive(path)
  const manifestName = 'new-world-backup.json'
  const manifest = json(files, manifestName)
  expect(manifest.version).toBe(6)
  expect(manifest.foreshadowing).toHaveLength(1)
  expect(manifest.foreshadowing[0]).toMatchObject({ title: '约定的潮声', resolved: true })
  expect(manifest.trash.find((row) => row.bookId === referenceId).foreshadowing[0].title).toBe('续写里的船契')

  const work = { library: 'original', root }
  await page.goto(boxPath(work))
  const active = entry(page, '约定的潮声')
  await button(active, '标为未回收').click()
  await expect(active.locator('.file-format')).toHaveText('未回收')
  await restoreBackup(page, path)
  await page.goto(boxPath(work))
  await expect(active.locator('.file-format')).toHaveText('已回收')
  await expect(active).toContainText('潮水涨过刻度。')

  await page.goto('/#/trash')
  const deleted = page.getByRole('listitem').filter({ hasText: '续写潮声' })
  await button(deleted, '恢复').click()
  await expect(deleted).toHaveCount(0)
  await page.goto(boxPath({ library: 'reference', root: referenceId }))
  await expect(entry(page, '续写里的船契')).toBeVisible()
  await expect(active).toHaveCount(0)

  manifest.version = 5
  delete manifest.foreshadowing
  for (const entry of manifest.trash) delete entry.foreshadowing
  const legacy = info.outputPath('旧备份.zip')
  await writeArchive(legacy, files, manifestName, manifest)
  await restoreBackup(page, legacy)
  await page.goto(boxPath(work))
  await expect(page.getByText('还没有伏笔。')).toBeVisible()
  await link(page, '返回作品').click()
  await expect(chapterHeading(page)).toHaveText('第一章')
})

test('原样升级 v14 书库，重启后保留新增的伏笔', async ({ page }) => {
  await page.goto('/appearance.js')
  await page.evaluate(createLegacyDatabase, 14)
  const work = await page.evaluate(seedProject, projectFixture('original', pixel.toString('base64')))
  const before = await page.evaluate(databaseSnapshot)
  await page.goto(boxPath(work))
  await expect(page.getByText('还没有伏笔。')).toBeVisible()
  expect(await page.evaluate(databaseSnapshot)).toEqual({ ...before, foreshadowing: [] })
  await addEntry(page, '旧书的新伏笔')
  await expect(form(page).getByRole('status')).toHaveText('已保存')
  const after = await page.evaluate(databaseSnapshot)
  await page.reload()
  await expect(entry(page, '旧书的新伏笔')).toBeVisible()
  expect(await page.evaluate(databaseSnapshot)).toEqual(after)
})
