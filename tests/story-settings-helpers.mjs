import { expect } from '@playwright/test'
import { chapterAction, openChapterList } from './editor-helpers.mjs'
import { startWork } from './navigation-helpers.mjs'

const action = (page, name) => page.getByRole('button', { name, exact: true })
export const storyEntry = (page) => action(page, '设定')
export const cardPanel = (page) => page.getByRole('form', { name: /.+/ })
export const storyCard = (page, name) => page.locator('.story-card').and(action(page, name))

export async function newStoryWork(page, name) {
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill(name)
  await action(page, '创建小说').click()
  await expect(page.getByRole('textbox', { name: '章节正文', exact: true })).toBeVisible()
}

export async function openStoryWindow(page, app) {
  const entry = storyEntry(page)
  const menu = !(await entry.isVisible())
  if (menu) await page.locator('.more-toggle').click()
  const opened = app ? app.waitForEvent('window') : page.context().waitForEvent('page')
  await (menu ? page.getByRole('menuitem', { name: '设定', exact: true }) : entry).click()
  const story = await opened
  await expect(story.getByRole('heading', { name: '故事设定库', exact: true })).toBeVisible()
  return story
}

export async function saveCard(page) {
  await cardPanel(page).getByRole('button', { name: '保存卡片', exact: true }).click()
  await expect(cardPanel(page).getByRole('status')).toHaveText('卡片已保存')
}

export async function newCard(page, name, category = 'character') {
  await action(page, '新建卡片').click()
  await cardPanel(page).getByRole('combobox', { name: '分类', exact: true }).selectOption(category)
  await cardPanel(page).getByLabel('名称', { exact: true }).fill(name)
  await saveCard(page)
  await expect(storyCard(page, name)).toBeVisible()
}

export async function closeCard(page) {
  await action(page, '关闭编辑面板').click()
  await expect(cardPanel(page)).toBeHidden()
}

export async function deleteCard(page) {
  await action(page, '删除卡片').click()
  const confirm = page.getByRole('dialog', { name: '将卡片移入回收站？' })
  await confirm.getByRole('button', { name: '移入回收站', exact: true }).click()
  await expect(confirm).toBeHidden()
}

export async function addStoryChapter(page, title) {
  await openChapterList(page)
  await action(page, '新建章节').click()
  const dialog = page.getByRole('dialog', { name: '新建章节', exact: true })
  await dialog.getByLabel('章节名', { exact: true }).fill(title)
  await dialog.getByRole('button', { name: '创建章节', exact: true }).click()
  await expect(dialog).toBeHidden()
}

export async function renameStoryChapter(page, title, next) {
  await openChapterList(page)
  await chapterAction(page, title, '重命名章节')
  const dialog = page.getByRole('dialog', { name: '重命名章节', exact: true })
  await dialog.getByLabel('章节名', { exact: true }).fill(next)
  await dialog.getByRole('button', { name: '保存章节名', exact: true }).click()
  await expect(dialog).toBeHidden()
}
