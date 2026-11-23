import { readFile } from 'node:fs/promises'
import { TextWriter, Uint8ArrayReader, ZipReader } from '@zip.js/zip.js'
import { test, expect } from './app-test.mjs'
import { bookAction } from './fixtures.mjs'
import { chapterHeading, openChapterList } from './editor-helpers.mjs'
import {
  action, addStoryChapter, boardState, canvas, cardPanel, chapterBox, closeCard, defaultLink, editCard, linkMode, liveView, newCard,
  newStoryWork, openMenu, openStoryWindow, saveCard, storyCard, storyEntry,
} from './story-settings-helpers.mjs'

test.setTimeout(90_000)

const cards = async (page) => (await boardState(page)).scene.nodes.filter((node) => node.kind === 'card')
const byName = async (page, name) => (await cards(page)).find((card) => card.name === name)

async function showChapter(page, title) {
  await openChapterList(page)
  await page.getByRole('list', { name: '章节' }).getByRole('button', { name: title, exact: true }).click()
  await expect(chapterHeading(page)).toHaveText(title)
}

async function twoChapterWork(page, name) {
  await page.goto('/#/writing')
  await newStoryWork(page, name)
  await addStoryChapter(page, '出海')
  await showChapter(page, '第一章')
  return openStoryWindow(page)
}

test('卡片可关联全书、多个章节或不关联：新建、修改、保存，全书的卡在每一章都算有效', async ({ page }) => {
  const story = await twoChapterWork(page, '关联方式')
  const editions = async () => page.evaluate(async () => {
    const db = await new Promise((resolve) => { const q = indexedDB.open('new-world-library'); q.onsuccess = () => resolve(q.result) })
    const rows = await new Promise((resolve) => { const q = db.transaction('editions').objectStore('editions').getAll(); q.onsuccess = () => resolve(q.result) })
    db.close()
    return rows
  })
  const [edition] = await editions()
  const [first, second] = edition.chapters.map(({ id }) => ({ editionId: edition.id, chapterId: id }))

  // By default a new card links to the editor's chapter.
  await newCard(story, '守灯人', { x: 220, y: 220 })
  await expect.poll(async () => (await byName(story, '守灯人'))).toMatchObject({ wholeBook: false, chapters: [first] })

  // Whole work.
  await editCard(story, '守灯人')
  const panel = cardPanel(story)
  await expect(linkMode(panel, '指定章节')).toBeChecked()
  await linkMode(panel, '全书').check()
  await expect(chapterBox(panel, '第 1 章 · 第一章')).toBeHidden()
  await saveCard(story)
  await expect(panel.getByRole('status')).toHaveText('已保存')
  await expect.poll(async () => (await byName(story, '守灯人'))).toMatchObject({ wholeBook: true, chapters: [] })
  await closeCard(story)

  // Several chapters.
  await newCard(story, '船长', { x: 620, y: 220 })
  await editCard(story, '船长')
  await chapterBox(panel, '第 2 章 · 出海').check()
  await saveCard(story)
  await expect(panel.getByRole('status')).toHaveText('已保存')
  await expect.poll(async () => (await byName(story, '船长'))).toMatchObject({ wholeBook: false, chapters: [first, second] })
  await closeCard(story)

  // No chapter.
  await newCard(story, '旅客', { x: 420, y: 460 })
  await editCard(story, '旅客')
  await linkMode(panel, '不关联章节').check()
  await saveCard(story)
  await expect(panel.getByRole('status')).toHaveText('已保存')
  await expect.poll(async () => (await byName(story, '旅客'))).toMatchObject({ wholeBook: false, chapters: [] })
  await closeCard(story)

  // Reopening shows what was saved.
  await story.reload()
  await editCard(story, '守灯人')
  await expect(linkMode(panel, '全书')).toBeChecked()
  await closeCard(story)
  await editCard(story, '船长')
  await expect(chapterBox(panel, '第 1 章 · 第一章')).toBeChecked()
  await expect(chapterBox(panel, '第 2 章 · 出海')).toBeChecked()
  await closeCard(story)
  await editCard(story, '旅客')
  await expect(linkMode(panel, '不关联章节')).toBeChecked()
  await closeCard(story)

  // The editor counts the whole-work card in every chapter.
  await expect(storyEntry(page)).toHaveAttribute('aria-description', '本章关联 2 张卡片')
  await showChapter(page, '出海')
  await expect(storyEntry(page)).toHaveAttribute('aria-description', '本章关联 2 张卡片')
  await expect(storyEntry(page)).toHaveAttribute('title', /守灯人.*船长|船长.*守灯人/)
})

test('默认关联跟随编辑器当前章；在设定窗口里手动改过后，编辑器换章节不再覆盖，可以改回跟随', async ({ page }) => {
  const story = await twoChapterWork(page, '默认关联')
  let panel = await defaultLink(story)
  await expect(panel).toContainText('新卡默认关联：第 1 章 · 第一章')
  await expect(panel).toContainText('跟随编辑器当前章')
  // The editor moves to chapter 2; the default follows without the editor being touched from here.
  await showChapter(page, '出海')
  await expect(panel).toContainText('新卡默认关联：第 2 章 · 出海')
  await newCard(story, '甲', { x: 600, y: 420 })
  await expect.poll(async () => (await byName(story, '甲'))?.chapters.map(({ chapterId }) => chapterId)).toHaveLength(1)
  const [firstCard] = await cards(story)

  // Choose the whole work here; the editor switching chapters keeps it.
  panel = await defaultLink(story)
  await panel.getByRole('button', { name: /新卡默认关联/ }).click()
  await linkMode(panel, '全书').check()
  await expect(panel).toContainText('新卡默认关联：全书')
  await expect(panel).toContainText('已手动选择')
  await showChapter(page, '第一章')
  await expect(chapterHeading(page)).toHaveText('第一章')
  await expect(panel).toContainText('新卡默认关联：全书')
  await newCard(story, '乙', { x: 600, y: 560 })
  await expect.poll(async () => (await byName(story, '乙'))).toMatchObject({ wholeBook: true, chapters: [] })

  // Several chapters at once.
  panel = await defaultLink(story)
  await panel.getByRole('button', { name: /新卡默认关联/ }).click()
  await linkMode(panel, '指定章节').check()
  await chapterBox(panel, '第 1 章 · 第一章').check()
  await chapterBox(panel, '第 2 章 · 出海').check()
  await expect(panel).toContainText('第 1 章 · 第一章、第 2 章 · 出海')
  await newCard(story, '丙', { x: 900, y: 420 })
  await expect.poll(async () => (await byName(story, '丙'))?.chapters).toHaveLength(2)

  // Back to following the editor.
  panel = await defaultLink(story)
  await panel.getByRole('button', { name: /新卡默认关联/ }).click()
  await action(panel, '改回跟随编辑器').click()
  await expect(panel).toContainText('新卡默认关联：第 1 章 · 第一章')
  await expect(panel).toContainText('跟随编辑器当前章')
  // The editor itself never moved because of the settings window.
  await expect(chapterHeading(page)).toHaveText('第一章')
  // The first card followed the editor to chapter 2, which is the second of the two linked to 丙.
  expect((await byName(story, '丙')).chapters[1]).toEqual(firstCard.chapters[0])
})

test('同一本书开两个窗口：一个里改，另一个马上同步，视角互不影响；编辑器再点设定会回到已打开的窗口', async ({ page, context }) => {
  await page.goto('/#/writing')
  await newStoryWork(page, '两个窗口')
  const first = await openStoryWindow(page)
  // Clicking 设定 again reuses the open tab.
  const pages = context.pages().length
  await storyEntry(page).click()
  await expect.poll(() => context.pages().length).toBe(pages)

  const opened = context.waitForEvent('page')
  await openMenu(first, '新窗口')
  const second = await opened
  await expect(canvas(second)).toBeVisible()
  await expect(second.getByText('两个窗口', { exact: true })).toBeVisible()
  expect(context.pages().length).toBe(pages + 1)

  // A change in one shows in the other.
  await newCard(first, '守灯人', { x: 300, y: 300 })
  await expect(storyCard(second, '守灯人')).toBeVisible()
  await newCard(second, '船长', { x: 700, y: 300 })
  await expect(storyCard(first, '船长')).toBeVisible()

  // Each window keeps its own view.
  const before = await liveView(second)
  await action(first, '放大').click()
  await action(first, '放大').click()
  await expect.poll(async () => (await liveView(first)).zoom).toBeGreaterThan(1.3)
  await second.bringToFront()
  await newCard(first, '旅客', { x: 500, y: 520 })
  await expect(storyCard(second, '旅客')).toBeVisible()
  expect(await liveView(second)).toEqual(before)
  await canvas(second).dispatchEvent('wheel', { deltaX: 40, deltaY: 0, deltaMode: 0 })
  await expect.poll(async () => (await liveView(second)).x).toBe(before.x - 40)
  expect((await liveView(first)).zoom).toBeGreaterThan(1.3)
})

test('全书和多章节关联随 .newworld 工程导出', async ({ page }, info) => {
  const story = await twoChapterWork(page, '导出关联')
  await newCard(story, '守灯人', { x: 220, y: 220 })
  await editCard(story, '守灯人')
  const panel = cardPanel(story)
  await linkMode(panel, '全书').check()
  await saveCard(story)
  await expect(panel.getByRole('status')).toHaveText('已保存')
  await closeCard(story)
  await newCard(story, '船长', { x: 620, y: 220 })
  await editCard(story, '船长')
  await chapterBox(panel, '第 2 章 · 出海').check()
  await saveCard(story)
  await expect(panel.getByRole('status')).toHaveText('已保存')
  const stored = await cards(story)

  await page.addInitScript(() => { window.showSaveFilePicker = undefined })
  await page.goto('/#/original')
  await page.evaluate(() => { window.showSaveFilePicker = undefined })
  await bookAction(page, '导出 New_World 工程（.newworld）', '导出关联')
  const preview = page.getByRole('dialog', { name: '导出 New_World 工程（.newworld）', exact: true })
  const download = page.waitForEvent('download')
  await preview.getByRole('button', { name: '保存工程', exact: true }).click()
  const path = info.outputPath('links.newworld')
  await (await download).saveAs(path)
  const zip = new ZipReader(new Uint8ArrayReader(await readFile(path)), { useWebWorkers: false })
  const entries = await zip.getEntries()
  const manifest = JSON.parse(await entries.find((entry) => entry.filename === 'manifest.json').getData(new TextWriter()))
  const boards = JSON.parse(await entries.find((entry) => entry.filename === manifest.records.storyBoards).getData(new TextWriter()))
  await zip.close()
  const exported = boards[0].scene.nodes.filter((node) => node.kind === 'card')
  expect(exported).toEqual(stored)
  expect(exported.map(({ name, wholeBook, chapters }) => [name, wholeBook, chapters.length])).toEqual([['守灯人', true, 0], ['船长', false, 2]])
})
