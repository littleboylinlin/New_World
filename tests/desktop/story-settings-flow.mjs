import { expect } from '@playwright/test'
import { action, addStoryChapter, boardState, canvas, cardPanel, chapterBox, closeCard, connect, defaultLink, drag, editCard, midpoint, nameEdge, newCard, newStoryWork, openStoryWindow, renameStoryChapter, saveCard, storyCard, storyEntry } from '../story-settings-helpers.mjs'

export async function desktopStorySettingsFlow(app, page, name) {
  await page.goto('new-world://app/#/writing')
  await newStoryWork(page, name)
  const story = await openStoryWindow(page, app)
  await expect(story.getByText(name, { exact: true })).toBeVisible()
  expect(app.windows()).toHaveLength(2)
  const native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({
    story: window.webContents.getURL().includes('#/story-settings/'),
    independent: window.getParentWindow() === null && !window.isModal() && window.isMovable(),
  })))
  expect(native.find((window) => window.story)?.independent).toBe(true)
  await expect(story.evaluate(() => window.newWorldDesktop.openStorySettings(location.hash))).rejects.toThrow()

  await newCard(story, '守灯人', { x: 260, y: 220 })
  await editCard(story, '守灯人')
  const panel = cardPanel(story)
  await expect(chapterBox(panel, '第 1 章 · 第一章')).toBeChecked()
  await addStoryChapter(page, '退潮')
  await chapterBox(panel, '第 2 章 · 退潮').check()
  await chapterBox(panel, '第 1 章 · 第一章').uncheck()
  await saveCard(story)
  await expect(panel.getByRole('status')).toHaveText('已保存')
  await closeCard(story)
  await expect(storyEntry(page)).toHaveAttribute('title', '本章关联 1 张卡片 · 守灯人')
  await renameStoryChapter(page, '退潮', '风暴')
  await storyEntry(page).click()
  // Clicking 设定 again brings back the open window instead of opening another.
  expect(app.windows()).toHaveLength(2)
  await expect(await defaultLink(story)).toContainText('新卡默认关联：第 2 章 · 风暴')
  await story.mouse.move(600, 500)
  await newCard(story, '灯塔', { x: 620, y: 420 })
  await expect.poll(async () => (await boardState(story)).scene.nodes[1].chapters).toHaveLength(1)
  await editCard(story, '灯塔')
  await expect(chapterBox(panel, '第 2 章 · 风暴')).toBeChecked()
  await closeCard(story)

  const originalX = (await boardState(story)).scene.nodes[0].x
  const point = await midpoint(storyCard(story, '守灯人'))
  await drag(story, point, { x: point.x + 48, y: point.y - 40 })
  await expect.poll(async () => (await boardState(story)).scene.nodes[0].x).toBe(originalX + 48)
  await action(story, '放大').click()
  await expect.poll(async () => (await boardState(story)).view.zoom).toBeGreaterThan(1)

  const relation = await connect(story, '守灯人', '灯塔')
  await nameEdge(story, relation.id, '守护')
  await expect(story.locator('.story-edge-label')).toHaveText('守护')
  // A second window on the same work: changes show in both, each keeps its own view.
  const another = app.waitForEvent('window')
  await action(story, '菜单').click()
  await story.getByRole('menuitem', { name: '新窗口', exact: true }).click()
  const second = await another
  await expect(canvas(second)).toBeVisible()
  expect(app.windows()).toHaveLength(3)
  const zoom = await canvas(story).getAttribute('data-zoom')
  await action(second, '缩小').click()
  await newCard(second, '雾港', { x: 520, y: 560 })
  await expect(storyCard(story, '雾港')).toBeVisible()
  await expect(canvas(story)).toHaveAttribute('data-zoom', zoom)
  // The editor brings back the window used last instead of opening another.
  await storyEntry(page).click()
  expect(app.windows()).toHaveLength(3)
  const board = await boardState(story)

  const closed = story.waitForEvent('close')
  const closedSecond = second.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().includes('#/story-settings/')) window.close()
  })
  await closed
  await closedSecond
  expect(app.windows()).toHaveLength(1)
  await expect(page.getByRole('textbox', { name: '章节正文', exact: true })).toBeVisible()
  const reopened = await openStoryWindow(page, app)
  await expect(canvas(reopened)).toHaveAttribute('data-zoom', String(board.view.zoom))
  expect(await boardState(reopened)).toEqual(board)
  await action(reopened, '适应全部内容').click()
  await editCard(reopened, '守灯人')
  await expect(chapterBox(cardPanel(reopened), '第 2 章 · 风暴')).toBeChecked()
}
