import { expect } from '@playwright/test'
import { chapterAction, openChapterList } from './editor-helpers.mjs'
import { startWork } from './navigation-helpers.mjs'

export const action = (page, name) => page.getByRole('button', { name, exact: true })
export const storyEntry = (page) => action(page, '设定')
export const canvas = (page) => page.getByRole('region', { name: '故事画布' })
export const cardPanel = (page) => page.locator('.story-inspector-form')
export const props = (page) => page.getByRole('region', { name: '属性' })
export const toolbar = (page) => page.getByRole('toolbar', { name: '工具' })
export const tool = (page, name) => action(toolbar(page), name)
export const storyCard = (page, name) => page.locator('.story-node-card').and(action(page, name))
export const inlineField = (page, name = '名称') => canvas(page).getByRole('textbox', { name, exact: true })
export const status = (page) => canvas(page).getByRole('status')

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
  await expect(tool(story, '卡片')).toBeEnabled()
  return story
}

export async function openMenu(page, item) {
  await action(page, '菜单').click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

export async function saveCard(page) {
  await action(cardPanel(page), '保存').click()
}

export async function closeCard(page) {
  await action(cardPanel(page), '关闭编辑面板').click()
  await expect(cardPanel(page)).toBeHidden()
}

/** Double-clicks the board (at `point` inside the canvas, or near its middle) and names the new card. */
export async function newCard(page, name, point) {
  // Clear the selection first, so its properties panel does not sit where the board is double-clicked.
  await canvas(page).press('Escape')
  await expect(props(page)).toBeHidden()
  const area = await canvas(page).boundingBox()
  await canvas(page).dblclick({ position: point ?? { x: area.width / 2, y: area.height / 2 } })
  await inlineField(page).fill(name)
  await inlineField(page).press('Enter')
  await expect(storyCard(page, name)).toBeVisible()
}

/** Clears any selection (and its panel), then selects one card. */
export async function selectCard(page, name) {
  // Escape closes an open side panel first, then clears the selection.
  await expect(async () => {
    await canvas(page).press('Escape')
    await expect(props(page)).toBeHidden({ timeout: 500 })
  }).toPass()
  await storyCard(page, name).click()
  await expect(storyCard(page, name)).toHaveAttribute('aria-pressed', 'true')
}

export async function editCard(page, name) {
  await selectCard(page, name)
  await action(props(page), '编辑卡片').click()
  await expect(cardPanel(page).getByLabel('名称', { exact: true })).toHaveValue(name)
}

export async function deleteCard(page, name) {
  await selectCard(page, name)
  await action(props(page), '删除').click()
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
  await page.mouse.move(to.x, to.y, { steps: options.steps ?? 8 })
  await page.mouse.up(options)
}

export async function midpoint(locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Canvas item is hidden')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Draws an arrow from one card's middle to another's with the arrow tool. */
export async function connect(page, from, to) {
  await page.keyboard.press('a')
  await expect(tool(page, '箭头')).toHaveAttribute('aria-pressed', 'true')
  const start = await midpoint(storyCard(page, from))
  const end = typeof to === 'string' ? await midpoint(storyCard(page, to)) : to
  const before = (await boardState(page)).scene.edges.length
  await drag(page, start, end)
  await expect.poll(async () => (await boardState(page)).scene.edges.length).toBe(before + 1)
  return (await boardState(page)).scene.edges.at(-1)
}

/** Writes an arrow's name in place, by double-clicking its middle. */
export async function nameEdge(page, id, name) {
  const point = await edgeMiddle(page, id)
  await page.mouse.dblclick(point.x, point.y)
  const field = inlineField(page, '关系名称')
  await field.fill(name)
  await field.press('Enter')
  await expect(page.locator(`[data-edge-id="${id}"] .story-edge-label`)).toHaveText(name)
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

/** Replaces the stored board (scene and view) and reloads the window. */
export async function seedBoard(page, scene, view = { x: 0, y: 0, zoom: 1 }) {
  await page.evaluate(async ({ scene, view }) => {
    const key = location.hash.split('?')[0].split('/').slice(-2)
    const db = await new Promise((resolve, reject) => { const q = indexedDB.open('new-world-library'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error) })
    const tx = db.transaction('storyBoards', 'readwrite')
    tx.objectStore('storyBoards').put({ library: key[0], bookId: key[1], scene, view, revision: crypto.randomUUID() })
    await new Promise((resolve) => { tx.oncomplete = resolve })
    db.close()
  }, { scene, view })
  await page.reload()
  await expect(canvas(page)).toBeVisible()
  await expect(tool(page, '卡片')).toBeEnabled()
}

export const card = (id, name, x, y, extra = {}) => ({
  id, kind: 'card', x, y, width: 200, height: 120, name, aliases: [], tagIds: [], fields: [], body: '', chapters: [], states: [], ...extra,
})
export const arrow = (id, from, to, extra = {}) => ({
  id, from: { nodeId: from }, to: typeof to === 'string' ? { nodeId: to } : to, name: '', direction: 'forward', stroke: 'solid', color: '#64748b', bend: 0, ...extra,
})

/** An arrow's drawn curve in canvas units: its two ends, control and middle. */
export async function edgeGeometry(page, id) {
  const d = await page.locator(`[data-edge-id="${id}"] .story-hit`).getAttribute('d')
  const [x1, y1, cx, cy, x2, y2] = d.match(/-?\d+(?:\.\d+)?/g).map(Number)
  return { from: { x: x1, y: y1 }, control: { x: cx, y: cy }, to: { x: x2, y: y2 }, mid: { x: (x1 + 2 * cx + x2) / 4, y: (y1 + 2 * cy + y2) / 4 } }
}

/** The current view, read from the rendered world transform. */
export async function liveView(page) {
  return page.locator('.story-world').evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform)
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a }
  })
}

/** Converts a canvas point to a page point. */
export async function toPage(page, point) {
  const view = await liveView(page)
  const area = await canvas(page).boundingBox()
  return { x: area.x + view.x + point.x * view.zoom, y: area.y + view.y + point.y * view.zoom }
}

export async function edgeMiddle(page, id) {
  return toPage(page, (await edgeGeometry(page, id)).mid)
}

/** Distance from a point to a rectangle's outline, negative inside it. */
export function outlineGap(rect, point) {
  const dx = Math.max(rect.x - point.x, point.x - rect.x - rect.width)
  const dy = Math.max(rect.y - point.y, point.y - rect.y - rect.height)
  return dx > 0 || dy > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) : Math.max(dx, dy)
}

/** Expects an arrow end to sit just outside a node's outline, as a glued end does. */
export function expectOnOutline(rect, point) {
  const gap = outlineGap(rect, point)
  expect(gap, `point ${JSON.stringify(point)} against ${JSON.stringify(rect)}`).toBeGreaterThanOrEqual(3)
  expect(gap, `point ${JSON.stringify(point)} against ${JSON.stringify(rect)}`).toBeLessThanOrEqual(7)
}

export function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Clicks an arrow where it is drawn: on its curve's middle, not the middle of its bounding box. */
export async function selectEdge(page, id) {
  const point = await edgeMiddle(page, id)
  await page.mouse.click(point.x, point.y)
  await expect(page.locator(`[data-edge-id="${id}"]`)).toHaveClass(/selected/)
}
