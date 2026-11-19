import { expect } from '@playwright/test'
import { chapterText, newWritingNovel } from './writing-motion-helpers.mjs'

// Shared steps for the split editor: seeding works, dragging entries out and reading pane geometry.

export const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
export const longChapter = (word, count = 80) => Array.from({ length: count }, (_, i) => paragraph(`${word}第 ${i + 1} 段，海风从石墙上吹过。`))

export const editArea = (page) => page.locator('.split-view')
export const referencePanes = (page) => page.locator('.reference-pane')
export const referenceText = (page) => page.getByRole('document', { name: '对照正文' })

/** Replaces the open work's chapters with the given ones, then reloads the editor. */
export async function seedChapters(page, entries, title = '分块样书', fresh = true) {
  if (fresh) await page.goto('/')
  await newWritingNovel(page, title)
  await page.evaluate(async (entries) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('new-world-library')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = db.transaction(['editions', 'chapters'], 'readwrite')
    const editions = transaction.objectStore('editions')
    const records = transaction.objectStore('chapters')
    const request = editions.getAll()
    const bookId = location.hash.split('/')[2]
    request.onsuccess = () => {
      const edition = request.result.find((item) => item.bookId === bookId)
      edition.chapters = entries.map(([name, paragraphs], i) => {
        const id = edition.chapters[i]?.id ?? crypto.randomUUID()
        records.put({ library: edition.library, bookId: edition.bookId, editionId: edition.id, id, content: { type: 'doc', content: paragraphs }, revision: 0 })
        return { id, title: name }
      })
      editions.put(edition)
    }
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error) })
    db.close()
  }, entries)
  await page.reload()
  await expect(chapterText(page)).toBeVisible()
  return page.url()
}

export async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

/** Presses on an element, drags it in steps to a point and releases it there. */
export async function dragTo(page, source, point, { steps = 12, release = true } = {}) {
  const box = await source.boundingBox()
  const start = { x: box.x + Math.min(40, box.width / 2), y: box.y + box.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(start.x + (point.x - start.x) * i / steps, start.y + (point.y - start.y) * i / steps)
    await settle(page)
  }
  if (release) await page.mouse.up()
}

/** A point inside the editing area, as fractions of its width and height. */
export async function areaPoint(page, fx, fy) {
  const box = await editArea(page).boundingBox()
  return { x: box.x + box.width * fx, y: box.y + box.height * fy }
}

export async function rectOf(locator) {
  return locator.evaluate((node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } })
}

/** The element is inside what is really visible, and a tap at its centre lands on it. */
export function reachable(locator) {
  return locator.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const view = window.visualViewport
    const x = view?.offsetLeft ?? 0, y = view?.offsetTop ?? 0
    const width = view?.width ?? innerWidth, height = view?.height ?? innerHeight
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return rect.width > 0 && rect.height > 0 && rect.left >= x - .5 && rect.top >= y - .5
      && rect.right <= x + width + .5 && rect.bottom <= y + height + .5 && node.contains(hit)
  })
}

/** Adds another editable version, with its own chapters, to the work open in the editor. */
export async function seedEdition(page, name, entries) {
  const baseId = await page.evaluate(async ({ name, entries }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('new-world-library')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = db.transaction(['editions', 'chapters'], 'readwrite')
    const editions = transaction.objectStore('editions')
    const records = transaction.objectStore('chapters')
    const bookId = location.hash.split('/')[2]
    const request = editions.getAll()
    let base
    request.onsuccess = () => {
      base = request.result.find((item) => item.bookId === bookId)
      const edition = { ...base, id: crypto.randomUUID(), name, source: 'copy', createdAt: base.createdAt + 1000, revision: 0 }
      edition.chapters = entries.map(([title, paragraphs]) => {
        const id = crypto.randomUUID()
        records.put({ library: edition.library, bookId: edition.bookId, editionId: edition.id, id, content: { type: 'doc', content: paragraphs }, revision: 0 })
        return { id, title }
      })
      editions.put(edition)
    }
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error) })
    db.close()
    return base.id
  }, { name, entries })
  // Back on the version that was open, with the new one now on the shelves.
  const [, library, bookId] = new URL(page.url()).hash.split('/')
  await page.goto(`/#/${library}/${bookId}/${baseId}`)
  await page.reload()
  await expect(chapterText(page)).toBeVisible()
}

/** Adds an imported plain-text work (only its original file, no editable version) to a library. */
export async function seedTextWork(page, title, text, library = 'original') {
  return page.evaluate(async ({ title, text, library }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('new-world-library')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const id = crypto.randomUUID()
    const blob = new Blob([text], { type: 'text/plain' })
    const transaction = db.transaction(['books', 'files'], 'readwrite')
    transaction.objectStore('books').put({ library, id, title, importedAt: Date.now() - 1000, originalName: `${title}.txt`, format: 'txt', size: blob.size, digest: id.replace(/-/g, '').padEnd(64, '0') })
    transaction.objectStore('files').put({ library, id, blob })
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error) })
    db.close()
    return id
  }, { title, text, library })
}

/** Opens a chapter beside the text from its menu in the chapter list (right click). */
export async function openFromChapterMenu(page, title, where = '在右侧打开') {
  await page.getByRole('list', { name: '章节' }).getByRole('button', { name: title, exact: true }).click({ button: 'right' })
  // A menu closed a moment ago may still be fading out; use the one just opened.
  await page.locator('.shell-layer[data-state="open"]').getByRole('menuitem', { name: where }).click()
}

/** The 对照 tab of the side panel. */
export async function openCompareTab(page) {
  const toggle = page.locator('.side-toggle')
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  else if (!await toggle.isVisible()) {
    await page.locator('.more-toggle').click()
    await page.getByRole('menuitemcheckbox', { name: '侧面板' }).click()
  }
  await page.getByRole('tab', { name: /^对照/ }).click()
  return page.locator('.compare-panel')
}
