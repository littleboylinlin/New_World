import { expect } from '@playwright/test'
import { action, addStoryChapter, boardState, canvas, cardPanel, closeCard, drag, editCard, fillNewCard, midpoint, newStoryWork, openStoryWindow, renameStoryChapter, storyCard, storyEntry } from '../story-settings-helpers.mjs'

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

  await action(story, '新建卡片').click()
  const panel = cardPanel(story)
  const linked = panel.getByRole('combobox', { name: '关联章节', exact: true })
  await expect(linked.locator('option:checked')).toHaveText('第 1 章 · 第一章')
  await addStoryChapter(page, '退潮')
  await expect(linked.locator('option').filter({ hasText: '第 2 章 · 退潮' })).toHaveCount(1)
  await linked.selectOption({ label: '第 2 章 · 退潮' })
  await fillNewCard(story, '守灯人')
  await closeCard(story)
  await expect(storyEntry(page)).toHaveAttribute('title', '本章关联 1 张卡片 · 守灯人')
  await renameStoryChapter(page, '退潮', '风暴')
  await storyEntry(page).click()
  await expect(story.getByText('新卡默认关联「风暴」')).toBeVisible()
  expect(app.windows()).toHaveLength(2)
  await action(story, '新建卡片').click()
  await expect(linked.locator('option:checked')).toHaveText('第 2 章 · 风暴')
  await closeCard(story)

  const originalX = (await boardState(story)).scene.nodes[0].x
  const point = await midpoint(storyCard(story, '守灯人'))
  await drag(story, point, { x: point.x + 48, y: point.y - 40 })
  await expect.poll(async () => (await boardState(story)).scene.nodes[0].x).toBe(originalX + 48)
  await action(story, '放大').click()
  await expect.poll(async () => (await boardState(story)).view.zoom).toBeGreaterThan(1)
  const board = await boardState(story)

  const closed = story.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('#/story-settings/')).close()
  })
  await closed
  expect(app.windows()).toHaveLength(1)
  await expect(page.getByRole('textbox', { name: '章节正文', exact: true })).toBeVisible()
  const reopened = await openStoryWindow(page, app)
  await expect(canvas(reopened)).toHaveAttribute('data-zoom', String(board.view.zoom))
  expect(await boardState(reopened)).toEqual(board)
  await action(reopened, '适合画布').click()
  await editCard(reopened, '守灯人')
  await expect(cardPanel(reopened).getByRole('combobox', { name: '关联章节', exact: true }).locator('option:checked')).toHaveText('第 2 章 · 风暴')
}
