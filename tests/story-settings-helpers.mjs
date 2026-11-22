import { expect } from '@playwright/test'
import { chapterAction, openChapterList } from './editor-helpers.mjs'
import { startWork } from './navigation-helpers.mjs'

export const action = (page, name) => page.getByRole('button', { name, exact: true })
export const storyEntry = (page) => action(page, '设定')
export const canvas = (page) => page.getByRole('region', { name: '故事画布' })
export const cardPanel = (page) => page.locator('.story-inspector-form')
export const storyCard = (page, name) => page.locator('.story-node-card').and(action(page, name))

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
  await expect(canvas(story)).toBeVisible()
  await expect(action(story, '新建卡片')).toBeEnabled()
  return story
}

export async function saveCard(page) {
  await action(cardPanel(page), '保存').click()
}

export async function fillNewCard(page, name) {
  await cardPanel(page).getByLabel('名称', { exact: true }).fill(name)
  await saveCard(page)
  await expect(storyCard(page, name)).toBeVisible()
}

export async function closeCard(page) {
  await action(cardPanel(page), '关闭编辑面板').click()
  await expect(cardPanel(page)).toBeHidden()
}

export async function newCard(page, name, point) {
  if (point) await canvas(page).dblclick({ position: point })
  else await action(page, '新建卡片').click()
  await fillNewCard(page, name)
  await closeCard(page)
}

export async function editCard(page, name) {
  await storyCard(page, name).dblclick()
  await expect(cardPanel(page).getByLabel('名称', { exact: true })).toHaveValue(name)
}

export async function deleteCard(page, name) {
  await storyCard(page, name).click()
  await action(page.locator('.story-tools'), '删除').click()
  const confirm = page.getByRole('dialog', { name: '将卡片移入回收站？' })
  await action(confirm, '移入回收站').click()
  await expect(confirm).toBeHidden()
  await expect(storyCard(page, name)).toHaveCount(0)
}

export async function addStoryChapter(page, title) {
  await openChapterList(page)
  await action(page, '新建章节').click()
  const dialog = page.getByRole('dialog', { name: '新建章节', exact: true })
  await dialog.getByLabel('章节名', { exact: true }).fill(title)
  await action(dialog, '创建章节').click()
  await expect(dialog).toBeHidden()
}

export async function renameStoryChapter(page, title, next) {
  await openChapterList(page)
  await chapterAction(page, title, '重命名章节')
  const dialog = page.getByRole('dialog', { name: '重命名章节', exact: true })
  await dialog.getByLabel('章节名', { exact: true }).fill(next)
  await action(dialog, '保存章节名').click()
  await expect(dialog).toBeHidden()
}

export async function drag(page, from, to, options = {}) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down(options)
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up(options)
}

export async function midpoint(locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Canvas item is hidden')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

export async function connect(page, name, side, target) {
  const source = storyCard(page, name)
  await source.click()
  const port = await midpoint(source.locator(`[data-port="${side}"]`))
  await drag(page, port, target)
  await expect(cardPanel(page).getByLabel('关系名称', { exact: true })).toBeVisible()
}

// Captures the board from IndexedDB, independently of viewport transforms and the rendered UI.
export async function boardState(page) {
  return page.evaluate(async () => {
    const path = location.hash.split('?')[0].split('/')
    const key = path.slice(-2)
    const db = await new Promise((resolve, reject) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => resolve(q.result)
      q.onerror = () => reject(q.error)
    })
    try {
      return await new Promise((resolve, reject) => {
        const q = db.transaction('storyBoards').objectStore('storyBoards').get(key)
        q.onsuccess = () => resolve(q.result)
        q.onerror = () => reject(q.error)
      })
    } finally { db.close() }
  })
}
