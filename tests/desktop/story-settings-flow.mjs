import { expect } from '@playwright/test'
import { addStoryChapter, cardPanel, newCard, newStoryWork, openStoryWindow, renameStoryChapter, saveCard, storyCard, storyEntry } from '../story-settings-helpers.mjs'

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

  await newCard(story, '守灯人')
  const panel = cardPanel(story)
  await panel.getByRole('button', { name: '关联章节', exact: true }).click()
  const linked = panel.getByRole('combobox', { name: '关联章节', exact: true })
  await addStoryChapter(page, '退潮')
  await expect(linked.locator('option').filter({ hasText: '第 2 章 · 退潮' })).toHaveCount(1)
  await linked.selectOption({ label: '第 2 章 · 退潮' })
  await saveCard(story)
  await expect(storyEntry(page)).toHaveAttribute('title', '本章关联 1 张卡片 · 守灯人')
  await renameStoryChapter(page, '退潮', '风暴')
  await expect(linked.locator('option:checked')).toHaveText('第 2 章 · 风暴')

  await storyEntry(page).click()
  expect(app.windows()).toHaveLength(2)
  const closed = story.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('#/story-settings/')).close()
  })
  await closed
  expect(app.windows()).toHaveLength(1)
  await expect(page.getByRole('textbox', { name: '章节正文', exact: true })).toBeVisible()
  const reopened = await openStoryWindow(page, app)
  await storyCard(reopened, '守灯人').click()
  await expect(cardPanel(reopened).getByRole('combobox', { name: '关联章节', exact: true }).locator('option:checked')).toHaveText('第 2 章 · 风暴')
}
