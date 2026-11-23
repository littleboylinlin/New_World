import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { test, expect } from './app-test.mjs'
import { bookAction, pixel } from './fixtures.mjs'
import { databaseSnapshot } from './project-fixture.mjs'
import {
  addStoryChapter, boardState, cardPanel, closeCard, connect, deleteCard, editCard, nameEdge, newCard,
  chapterBox, linkMode, newStoryWork, openMenu, openStoryWindow, saveCard, selectCard, storyCard,
} from './story-settings-helpers.mjs'

const button = (page, name) => page.getByRole('button', { name, exact: true })
const manifestName = 'new-world-backup.json'
const title = '雾灯故事'
const projectExportName = '导出 New_World 工程（.newworld）'

test.setTimeout(90_000)

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.showSaveFilePicker = undefined })
})

async function archiveJson(path, name) {
  const zip = new ZipReader(new Uint8ArrayReader(await readFile(path)), { useWebWorkers: false })
  try {
    const entry = (await zip.getEntries()).find((item) => item.filename === name)
    return JSON.parse(await entry.getData(new TextWriter()))
  } finally {
    await zip.close()
  }
}

async function seedCards(page) {
  await page.goto('/#/writing')
  await newStoryWork(page, title)
  await addStoryChapter(page, '灯塔')
  const story = await openStoryWindow(page)
  await newCard(story, '雾港', { x: 495, y: 100 })
  await newCard(story, '守灯人', { x: 125, y: 105 })
  await editCard(story, '守灯人')
  const panel = cardPanel(story)
  await panel.getByLabel('别名', { exact: true }).fill('灯长')
  await panel.getByLabel('正文', { exact: true }).fill('灯灭后不得出航。')
  await button(panel, '添加字段').click()
  await panel.getByLabel('字段名', { exact: true }).fill('职责')
  await panel.getByLabel('内容', { exact: true }).fill('灯塔值守')
  // New cards follow the editor, now on chapter 2; link chapter 1 instead.
  // Link both chapters; another card below is for the whole work.
  await chapterBox(panel, '第 1 章 · 第一章').check()
  await panel.getByText('章节状态', { exact: true }).click()
  await button(panel, '添加状态').click()
  await panel.getByRole('combobox', { name: '从章节起', exact: true }).selectOption({ label: '第 2 章 · 灯塔' })
  await panel.getByLabel('状态', { exact: true }).fill('独自值夜')
  await saveCard(story)
  await expect(panel.getByRole('status')).toHaveText('已保存')
  await closeCard(story)
  const relation = await connect(story, '守灯人', '雾港')
  await nameEdge(story, relation.id, '居于')

  await selectCard(story, '守灯人')
  await button(story, '分组框').click()
  await expect(story.locator('.story-node-group')).toHaveCount(1)
  const chooser = story.waitForEvent('filechooser')
  await button(story, '图片').click()
  await (await chooser).setFiles({ name: '位置草图.png', mimeType: 'image/png', buffer: pixel })
  await expect(story.locator('.story-node-image img')).toBeVisible()
  await openMenu(story, '标签')
  await story.locator('.story-sidebar').getByLabel('标签名称').fill('灯塔组')
  await button(story, '新增标签').click()
  await expect.poll(async () => (await boardState(story)).scene.tags.length).toBe(1)
  await button(story.locator('.story-sidebar'), '关闭编辑面板').click()
  await editCard(story, '守灯人')
  await panel.getByRole('checkbox', { name: '灯塔组' }).check()
  await saveCard(story)
  await expect(panel.getByRole('status')).toHaveText('已保存')
  await closeCard(story)
  await deleteCard(story, '雾港')
  await newCard(story, '雾灯规矩', { x: 300, y: 470 })
  await editCard(story, '雾灯规矩')
  await linkMode(panel, '全书').check()
  await saveCard(story)
  await expect(panel.getByRole('status')).toHaveText('已保存')
  await closeCard(story)
  await button(story, '放大').click()
  await expect.poll(async () => (await boardState(story)).view.zoom).toBeGreaterThan(1)
  return { story, bookId: new URL(story.url()).hash.split('?')[0].split('/').at(-1) }
}

async function downloadProject(page, workTitle, path) {
  await page.goto('/#/original')
  await bookAction(page, projectExportName, workTitle)
  const preview = page.getByRole('dialog', { name: projectExportName, exact: true })
  const download = page.waitForEvent('download')
  await preview.getByRole('button', { name: '保存工程', exact: true }).click()
  await (await download).saveAs(path)
  await expect(preview).toBeHidden()
}

async function uploadProject(page, path, copy = false) {
  await page.goto('/#/writing')
  const chooser = page.waitForEvent('filechooser')
  await button(page, '导入').click()
  await (await chooser).setFiles(path)
  const preview = page.getByRole('dialog', { name: '导入工程预览', exact: true })
  if (copy) await preview.getByLabel('导入方式').selectOption('copy')
  await preview.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(preview).toBeHidden()
}

function backupPanel(page) {
  return page.getByRole('region', { name: '备份与恢复', exact: true })
}

async function restore(page, path) {
  await page.goto('/#/settings/backup')
  const chooser = page.waitForEvent('filechooser')
  await button(backupPanel(page), '从备份恢复…').click()
  await (await chooser).setFiles(path)
  await page.getByRole('dialog', { name: '从备份恢复', exact: true })
    .getByRole('button', { name: '替换当前书库', exact: true }).click()
  await expect(page.getByText(/已从备份恢复/)).toBeVisible()
}

test('全库备份往返保留活动卡片、卡片回收记录和已删除作品的卡片，格式 3 可恢复', async ({ page }, info) => {
  const { story } = await seedCards(page)
  await page.goto('/#/writing')
  await newStoryWork(page, '另一本书')
  const other = await openStoryWindow(page)
  await newCard(other, '青铜罗盘')
  await page.goto('/#/original')
  await bookAction(page, '删除', '另一本书')
  await button(page, '确认删除').click()
  await expect(other.getByText('这部作品已不在书库中。', { exact: true })).toBeVisible()
  const before = await page.evaluate(databaseSnapshot)

  await page.goto('/#/settings/backup')
  const download = page.waitForEvent('download')
  await button(backupPanel(page), '立即备份').click()
  const path = info.outputPath('story-backup.zip')
  await (await download).saveAs(path)
  const manifest = await archiveJson(path, manifestName)
  expect(manifest.version).toBe(4)
  expect(manifest.storyBoards).toEqual(before.storyBoards)
  expect(manifest.trash.find((entry) => entry.kind === 'book').storyBoard.scene.nodes[0].name).toBe('青铜罗盘')

  // The seeded view is zoomed in; bring the cards out from under the top islands first.
  await button(story, '适应全部内容').click()
  await deleteCard(story, '守灯人')
  await restore(page, path)
  await expect(storyCard(story, '守灯人')).toBeVisible()
  const after = await page.evaluate(databaseSnapshot)
  expect(after.storyBoards).toEqual(before.storyBoards)
  expect(after.trash).toEqual(before.trash)

  await page.goto('/#/trash')
  const deletedWork = page.getByRole('listitem').filter({ hasText: '另一本书' })
  await button(deletedWork, '恢复').click()
  await expect(storyCard(other, '青铜罗盘')).toBeVisible()

  const legacy = { ...manifest, version: 3, trash: [] }
  delete legacy.storyBoards
  const legacyArchive = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  await legacyArchive.add(manifestName, new TextReader(JSON.stringify(legacy)))
  const legacyPath = info.outputPath('old-v3.zip')
  await writeFile(legacyPath, await legacyArchive.close())
  await restore(page, legacyPath)
  await expect(storyCard(story, '守灯人')).toHaveCount(0)
  expect((await page.evaluate(databaseSnapshot)).storyBoards).toEqual([])
})

test('工程保留本书卡片和回收记录，副本重映射版本、章节和卡片 ID，兼容旧工程', async ({ page, browser }, info) => {
  const { story, bookId } = await seedCards(page)
  const before = await page.evaluate(databaseSnapshot)
  const original = before.storyBoards.find((board) => board.bookId === bookId)
  const originalCard = original.scene.nodes.find((node) => node.kind === 'card')
  await page.goto('/#/writing')
  await newStoryWork(page, '私有设定')
  const privateStory = await openStoryWindow(page)
  await newCard(privateStory, '另外一本书的卡片')
  const path = info.outputPath('雾灯故事.newworld')
  await downloadProject(page, title, path)
  const manifest = await archiveJson(path, 'manifest.json')
  expect(manifest.schemaVersion).toBe(4)
  expect(await archiveJson(path, manifest.records.storyBoards)).toEqual([original])
  const trash = await archiveJson(path, manifest.records.trash)
  expect(trash).toEqual(before.trash)

  const fresh = await browser.newContext({ locale: 'zh-CN' })
  try {
    const receiver = await fresh.newPage()
    await receiver.addInitScript(() => { window.showSaveFilePicker = undefined })
    await uploadProject(receiver, path)
    const restored = await receiver.evaluate(databaseSnapshot)
    expect(restored.storyBoards).toEqual([original])
    expect(restored.trash).toEqual(trash)
    const second = info.outputPath('再导出.newworld')
    await downloadProject(receiver, title, second)
    expect(await archiveJson(second, manifest.records.storyBoards)).toEqual([original])

    await uploadProject(receiver, path, true)
    const rows = await receiver.evaluate(databaseSnapshot)
    const copy = rows.storyBoards.find((board) => board.bookId !== bookId)
    const card = copy.scene.nodes.find((node) => node.kind === 'card')
    const edition = rows.editions.find((edition) => edition.bookId === copy.bookId)
    const deleted = rows.trash.find((entry) => entry.bookId === copy.bookId)
    expect(card.id).not.toBe(originalCard.id)
    expect(copy.scene.edges[0]).toMatchObject({ from: { nodeId: card.id }, name: '居于', to: { nodeId: deleted.storyCard.id } })
    expect(copy.scene.edges[0].to.nodeId).not.toBe(original.scene.edges[0].to.nodeId)
    // Linked to chapter 2 (the editor's when it was made) and chapter 1, both remapped.
    expect(card.chapters).toEqual([{ editionId: edition.id, chapterId: edition.chapters[1].id }, { editionId: edition.id, chapterId: edition.chapters[0].id }])
    expect(card.wholeBook).toBe(false)
    expect(copy.scene.nodes.find((node) => node.name === '雾灯规矩')).toMatchObject({ wholeBook: true, chapters: [] })
    expect(card.states).toEqual([{ editionId: edition.id, chapterId: edition.chapters[1].id, text: '独自值夜' }])
    expect(card.tagIds).toEqual([copy.scene.tags[0].id])
    expect(card.tagIds).not.toEqual(originalCard.tagIds)
    expect(card.states[0].chapterId).not.toBe(originalCard.states[0].chapterId)
    expect(card.body).toBe(originalCard.body)
    expect(copy.view).toEqual(original.view)
    expect(copy.scene.nodes.map(({ x, y, width, height }) => [x, y, width, height]))
      .toEqual(original.scene.nodes.map(({ x, y, width, height }) => [x, y, width, height]))
    const copiedStory = await fresh.newPage()
    await copiedStory.goto(new URL(`#/story-settings/${copy.library}/${copy.bookId}`, receiver.url()).href)
    await openMenu(copiedStory, '回收站')
    await button(copiedStory.locator('.story-trash-row'), '恢复').click()
    await expect(copiedStory.locator('.story-edge-label')).toHaveText('居于')
  } finally {
    await fresh.close()
  }

  // The immutable task example exercises the published Schema 3 manifest.
  await uploadProject(page, resolve('docs/examples/雾港-创作任务.newworld'))
  expect((await page.evaluate(databaseSnapshot)).storyBoards).toHaveLength(2)
  await expect(storyCard(story, '守灯人')).toBeVisible()
})
