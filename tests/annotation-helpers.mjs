import { startWork, chooseImportType } from './navigation-helpers.mjs'
import { expect } from '@playwright/test'
import { editorAction, saveNow } from './editor-helpers.mjs'

export const readingBody = (page) => page.locator('.novel-body')
export async function annotationNovel(page, text = '重复的句子。中文、English!\n第二段的文字。重复的句子。', library = 'original') {
  await page.goto(`/#/${library}`)
  if (library === 'reference') {
    await page.locator('input[type=file]').setInputFiles({ name: '参考.txt', mimeType: 'text/plain', buffer: Buffer.from('参考原文。') })
    await chooseImportType(page, 'reference')
    await page.getByRole('link', { name: '查看 参考', exact: true }).click()
    await page.getByRole('button', { name: '新建续写' }).click()
    await page.getByRole('textbox', { name: '续写名称' }).fill('批注测试')
    await page.getByRole('button', { name: '开始续写' }).click()
  } else {
    await startWork(page)
    await page.getByRole('textbox', { name: '作品名' }).fill('批注测试')
    await page.getByRole('button', { name: '创建小说' }).click()
  }
  await page.getByRole('textbox', { name: '章节正文' }).fill(text)
  await saveNow(page)
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await editorAction(page, '阅读模式')
  await expect(page.locator('.annotation-manager summary')).toContainText('（0）')
}

/** Real DOM selection across text/marks, excluding annotation UI. Offsets count text nodes only. */
export async function selectReading(page, from, to, selector = '.novel-body') {
  const root = page.locator(selector)
  await root.scrollIntoViewIfNeeded()
  await root.evaluate((root, { from, to }) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement.closest('[data-annotation-ui]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT })
    let total = 0, start, end
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (!start && total + node.length >= from) start = [node, from - total]
      if (total + node.length >= to) { end = [node, to - total]; break }
      total += node.length
    }
    if (!start || !end) throw new Error('Selection outside text')
    const range = document.createRange()
    range.setStart(...start); range.setEnd(...end)
    // Only the text pane scrolls: bring the start of the selection into view, as a reader would.
    start[0].parentElement.scrollIntoView({ block: 'center' })
    const selection = getSelection()
    selection.removeAllRanges(); selection.addRange(range)
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, { from, to })
  await expect(page.getByRole('button', { name: '添加批注', exact: true })).toBeVisible()
}

export async function createAnnotation(page, text, display = 'mark', color) {
  await page.getByRole('button', { name: '添加批注', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加批注' })
  await dialog.getByLabel('批注内容').fill(text)
  await dialog.getByLabel('展示形式').selectOption(display)
  if (color) await dialog.getByLabel(display === 'inline' ? '自定义文字颜色' : '自定义高亮颜色').fill(color)
  await dialog.getByRole('button', { name: '保存批注' }).click()
  await expect(dialog).toBeHidden()
}

export async function annotationRows(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('new-world-library')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const rows = db.transaction('chapters').objectStore('chapters').getAll()
      rows.onsuccess = () => { db.close(); resolve(rows.result) }
    }
  }))
}
