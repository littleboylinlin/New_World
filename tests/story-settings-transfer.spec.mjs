import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { test, expect } from './app-test.mjs'
import { bookAction } from './fixtures.mjs'
import { databaseSnapshot } from './project-fixture.mjs'
import { addStoryChapter, cardPanel, deleteCard, newCard, newStoryWork, openStoryWindow, saveCard, storyCard } from './story-settings-helpers.mjs'

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
  const editorUrl = page.url()
  const story = await openStoryWindow(page)
  await newCard(story, '雾港', 'location')
  await newCard(story, '守灯人')
  const panel = cardPanel(story)
  await panel.getByLabel('别名', { exact: true }).fill('灯长')
  await panel.getByLabel('给 AI 的简述', { exact: true }).fill('管理雾港的灯。')
  await panel.getByLabel('完整设定', { exact: true }).fill('灯灭后不得出航。')
  await panel.getByLabel('身份', { exact: true }).fill('灯塔值守')
  await button(panel, '关联章节').click()
  await panel.getByRole('combobox', { name: '关联章节', exact: true }).selectOption({ label: '第 1 章 · 第一章' })
  await button(panel, '添加状态').click()
  await panel.getByRole('combobox', { name: '从章节起', exact: true }).selectOption({ label: '第 2 章 · 灯塔' })
  await panel.getByLabel('状态', { exact: true }).fill('独自值夜')
  await button(panel, '添加关系').click()
  await panel.getByRole('combobox', { name: '目标卡片', exact: true }).selectOption({ label: '雾港 · 地点' })
  await panel.getByLabel('关系名称', { exact: true }).fill('居于')
  await saveCard(story)
  await storyCard(story, '雾港').click()
  await deleteCard(story)
  await expect(storyCard(story, '雾港')).toHaveCount(0)
  return { story, editorUrl, bookId: new URL(story.url()).hash.split('/').at(-1) }
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
  await newCard(other, '青铜罗盘', 'item')
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
  expect(manifest.storyCards).toEqual(before.storyCards)
  expect(manifest.trash.find((entry) => entry.kind === 'book').storyCards[0].name).toBe('青铜罗盘')

  await storyCard(story, '守灯人').click()
  await deleteCard(story)
  await restore(page, path)
  await expect(storyCard(story, '守灯人')).toBeVisible()
  const after = await page.evaluate(databaseSnapshot)
  expect(after.storyCards).toEqual(before.storyCards)
  expect(after.trash).toEqual(before.trash)

  await page.goto('/#/trash')
  const deletedWork = page.getByRole('listitem').filter({ hasText: '另一本书' })
  await button(deletedWork, '恢复').click()
  await expect(storyCard(other, '青铜罗盘')).toBeVisible()

  const legacy = { ...manifest, version: 3, trash: [] }
  delete legacy.storyCards
  const legacyArchive = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  await legacyArchive.add(manifestName, new TextReader(JSON.stringify(legacy)))
  const legacyPath = info.outputPath('old-v3.zip')
  await writeFile(legacyPath, await legacyArchive.close())
  await restore(page, legacyPath)
  await expect(storyCard(story, '守灯人')).toHaveCount(0)
  expect((await page.evaluate(databaseSnapshot)).storyCards).toEqual([])
})

test('工程保留本书卡片和回收记录，副本重映射版本、章节和卡片 ID，兼容旧工程', async ({ page, browser }, info) => {
  const { story, editorUrl, bookId } = await seedCards(page)
  const before = await page.evaluate(databaseSnapshot)
  const original = before.storyCards.find((card) => card.bookId === bookId)
  await page.goto('/#/writing')
  await newStoryWork(page, '私有设定')
  const privateStory = await openStoryWindow(page)
  await newCard(privateStory, '另外一本书的卡片', 'rule')
  const path = info.outputPath('雾灯故事.newworld')
  await downloadProject(page, title, path)
  const manifest = await archiveJson(path, 'manifest.json')
  expect(manifest.schemaVersion).toBe(4)
  expect(await archiveJson(path, manifest.records.storyCards)).toEqual([original])
  const trash = await archiveJson(path, manifest.records.trash)
  expect(trash).toEqual(before.trash)

  const fresh = await browser.newContext({ locale: 'zh-CN' })
  try {
    const receiver = await fresh.newPage()
    await receiver.addInitScript(() => { window.showSaveFilePicker = undefined })
    await uploadProject(receiver, path)
    const restored = await receiver.evaluate(databaseSnapshot)
    expect(restored.storyCards).toEqual([original])
    expect(restored.trash).toEqual(trash)
    const second = info.outputPath('再导出.newworld')
    await downloadProject(receiver, title, second)
    expect(await archiveJson(second, manifest.records.storyCards)).toEqual([original])

    await uploadProject(receiver, path, true)
    const rows = await receiver.evaluate(databaseSnapshot)
    const copy = rows.storyCards.find((card) => card.bookId !== bookId)
    const edition = rows.editions.find((edition) => edition.bookId === copy.bookId)
    const deleted = rows.trash.find((entry) => entry.bookId === copy.bookId)
    expect(copy.id).not.toBe(original.id)
    expect(copy.relations).toEqual([{ name: '居于', targetCardId: deleted.storyCards[0].id }])
    expect(copy.relations[0].targetCardId).not.toBe(original.relations[0].targetCardId)
    expect(copy.chapters).toEqual([{ editionId: edition.id, chapterId: edition.chapters[0].id }])
    expect(copy.states).toEqual([{ editionId: edition.id, chapterId: edition.chapters[1].id, text: '独自值夜' }])
    expect(copy.states[0].chapterId).not.toBe(original.states[0].chapterId)
    expect(copy.details).toBe(original.details)
    await receiver.goto(editorUrl.replace(bookId, copy.bookId).replace(original.chapters[0].editionId, edition.id))
    const copiedStory = await openStoryWindow(receiver)
    await button(copiedStory, '回收站').click()
    await button(copiedStory.locator('.story-trash-card'), '恢复').click()
    await button(copiedStory, '全部卡片').click()
    await storyCard(copiedStory, '守灯人').click()
    await expect(cardPanel(copiedStory).getByRole('combobox', { name: '目标卡片' }).locator('option:checked')).toHaveText('雾港 · 地点')
  } finally {
    await fresh.close()
  }

  // The immutable task example exercises the published Schema 3 manifest.
  await uploadProject(page, resolve('docs/examples/雾港-创作任务.newworld'))
  expect((await page.evaluate(databaseSnapshot)).storyCards).toHaveLength(2)
  await expect(storyCard(story, '守灯人')).toBeVisible()
})
