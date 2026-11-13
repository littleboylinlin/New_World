import { expect, test } from './app-test.mjs'
import { bookAction, file } from './fixtures.mjs'

const textArea = (page) => page.getByRole('textbox', { name: '章节正文' })
const chapters = (page) => page.getByRole('list', { name: '章节' }).getByRole('button')
const trashRow = (page, title) => page.getByRole('list', { name: '回收站内容' }).getByRole('listitem').filter({ hasText: title })
const undo = (page) => page.getByRole('status').filter({ hasText: '移入回收站' }).getByRole('button', { name: '撤销' })

async function newNovel(page, name) {
  await page.goto('/#/original')
  await page.getByRole('button', { name: '新建小说' }).click()
  await page.getByRole('textbox', { name: '作品名' }).fill(name)
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(textArea(page)).toBeVisible()
}

async function save(page) {
  await page.getByRole('button', { name: '手动保存' }).click()
  await expect(page.locator('.save-status')).toHaveText('已保存')
}

async function addChapter(page, title, text) {
  await page.getByRole('button', { name: '新建章节' }).click()
  await page.getByRole('textbox', { name: '章节名' }).fill(title)
  await page.getByRole('button', { name: '创建章节' }).click()
  await expect(page.locator('.writing-header h3')).toHaveText(title)
  await textArea(page).fill(text)
  await save(page)
}

async function deleteBook(page) {
  await page.goto('/#/original')
  await bookAction(page, '删除')
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByText('还没有原创作品')).toBeVisible()
}

test('删除作品后可以撤销，也能在回收站恢复或彻底删除', async ({ page }) => {
  await newNovel(page, '潮间带')
  await textArea(page).fill('退潮以后，礁石上留着字。')
  await save(page)

  await deleteBook(page)
  await undo(page).click()
  await page.getByRole('link', { name: '查看 潮间带', exact: true }).click()
  await expect(textArea(page)).toHaveText('退潮以后，礁石上留着字。')

  await deleteBook(page)
  await expect(page.locator('#trash-count')).toHaveText('1')
  await page.getByRole('link', { name: '回收站' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '回收站' })).toBeVisible()
  await expect(trashRow(page, '潮间带')).toContainText('作品')
  await trashRow(page, '潮间带').getByRole('button', { name: '恢复' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已恢复「潮间带」。' })).toBeVisible()
  await expect(page.getByText('回收站是空的')).toBeVisible()
  await expect(page.locator('#trash-count')).toHaveText('')
  await page.goto('/#/original')
  await expect(page.getByRole('link', { name: '查看 潮间带', exact: true })).toBeVisible()

  await deleteBook(page)
  await page.goto('/#/trash')
  await trashRow(page, '潮间带').getByRole('button', { name: '彻底删除' }).click()
  await page.getByRole('button', { name: '确认彻底删除' }).click()
  await expect(page.getByText('回收站是空的')).toBeVisible()
  await page.goto('/#/original')
  await expect(page.getByText('还没有原创作品')).toBeVisible()
})

test('章节删除后恢复到原来的位置和正文', async ({ page }) => {
  await newNovel(page, '三封信')
  await textArea(page).fill('第一封。')
  await save(page)
  await addChapter(page, '第二章', '第二封写了很久。')
  await addChapter(page, '第三章', '第三封。')
  await page.getByRole('button', { name: '第二章', exact: true }).click()
  await expect(textArea(page)).toHaveText('第二封写了很久。')

  await page.getByRole('button', { name: '删除章节' }).click()
  await page.getByRole('button', { name: '确认删除章节' }).click()
  await expect(chapters(page)).toHaveText(['第一章', '第三章'])
  await undo(page).click()
  await expect(chapters(page)).toHaveText(['第一章', '第二章', '第三章'])
  await page.getByRole('button', { name: '第二章', exact: true }).click()
  await expect(textArea(page)).toHaveText('第二封写了很久。')

  const edition = page.url()
  await page.getByRole('button', { name: '删除章节' }).click()
  await page.getByRole('button', { name: '确认删除章节' }).click()
  await expect(chapters(page)).toHaveText(['第一章', '第三章'])
  await page.goto('/#/trash')
  await expect(trashRow(page, '第二章')).toContainText('三封信 · 编辑稿')
  await trashRow(page, '第二章').getByRole('button', { name: '恢复' }).click()
  await expect(page.getByText('回收站是空的')).toBeVisible()
  await page.goto(edition)
  await expect(chapters(page)).toHaveText(['第一章', '第二章', '第三章'])
  await page.getByRole('button', { name: '重命名章节' }).click()
  await page.getByRole('textbox', { name: '章节名' }).fill('序')
  await page.getByRole('button', { name: '保存章节名' }).click()
  await expect(chapters(page)).toHaveText(['序', '第二章', '第三章'])
})

test('编辑版本和续写项目的原文删除后可以撤销', async ({ page }) => {
  await page.goto('/#/original')
  await page.locator('input[type=file]').setInputFiles(file('海图.txt', '海图上的第一行。'))
  await page.getByRole('link', { name: '查看 海图', exact: true }).click()
  await page.getByRole('button', { name: '转换为编辑稿' }).click()
  await expect(textArea(page)).toHaveText('海图上的第一行。')
  await page.getByRole('button', { name: '删除版本' }).click()
  await page.getByRole('button', { name: '确认删除版本' }).click()
  await expect(page.getByRole('article')).toHaveText('海图上的第一行。')
  await undo(page).click()
  await expect(textArea(page)).toHaveText('海图上的第一行。')

  await page.goto('/#/reference')
  await page.locator('input[type=file]').setInputFiles(file('旧港.txt', '旧港的原文。'))
  await page.getByRole('link', { name: '查看 旧港', exact: true }).click()
  const originals = page.getByRole('list', { name: '原文列表' })
  await originals.getByRole('button', { name: '移除原文' }).click()
  await page.getByRole('button', { name: '确认移除原文' }).click()
  await expect(page.getByText('当前没有原文。', { exact: false })).toBeVisible()
  await undo(page).click()
  await originals.getByRole('link', { name: '查看原文 旧港' }).click()
  await expect(page.getByRole('article')).toHaveText('旧港的原文。')
})

test('回收站在 30 天后清理过期内容', async ({ page }) => {
  await page.goto('/#/trash')
  await expect(page.getByText('回收站是空的')).toBeVisible()
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('new-world-library')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const day = 24 * 60 * 60 * 1000
    const tx = db.transaction('trash', 'readwrite')
    for (const [title, age] of [['过期的稿子', 31], ['还能恢复的稿子', 29]]) {
      const id = crypto.randomUUID()
      tx.objectStore('trash').add({
        id: crypto.randomUUID(), kind: 'book', library: 'original', bookId: id, title, deletedAt: Date.now() - age * day,
        books: [{ library: 'original', id, title, format: 'draft', importedAt: 1 }], files: [], editions: [], chapters: [],
      })
    }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    db.close()
  })
  await page.reload()
  await expect(trashRow(page, '还能恢复的稿子')).toContainText('还剩 1 天')
  await expect(trashRow(page, '过期的稿子')).toHaveCount(0)
  await expect(page.locator('#trash-count')).toHaveText('1')
})
