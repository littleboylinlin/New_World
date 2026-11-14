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

test('回收站永久保留超过 30 天的旧内容与历史记录格式，直到用户手动恢复或二次确认彻底删除', async ({ page }) => {
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
    for (const [title, age] of [['旧版百日旧稿', 120], ['满月旧稿', 31]]) {
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
  await expect(page.locator('#trash-count')).toHaveText('2')
  await expect(page.getByText('会持续保留在这里，可随时恢复，直到你手动彻底删除。')).toBeVisible()
  await expect(trashRow(page, '旧版百日旧稿')).toContainText('删除')
  await expect(trashRow(page, '旧版百日旧稿')).not.toContainText('还剩')
  await expect(trashRow(page, '满月旧稿')).toContainText('删除')
  await expect(trashRow(page, '满月旧稿')).not.toContainText('还剩')

  await trashRow(page, '旧版百日旧稿').getByRole('button', { name: '恢复' }).click()
  await expect(page.locator('#trash-count')).toHaveText('1')

  await trashRow(page, '满月旧稿').getByRole('button', { name: '彻底删除' }).click()
  await page.getByRole('button', { name: '取消' }).click()
  await expect(trashRow(page, '满月旧稿')).toHaveCount(1)
  await trashRow(page, '满月旧稿').getByRole('button', { name: '彻底删除' }).click()
  await page.getByRole('button', { name: '彻底删除' }).last().click()
  await expect(page.getByText('回收站是空的')).toBeVisible()
  await expect(page.locator('#trash-count')).toHaveText('')

  await page.goto('/#/original')
  await expect(page.getByRole('link', { name: '查看 旧版百日旧稿', exact: true })).toBeVisible()
})

test('永久删除作品、版本、章节、来源与灵感时级联清理专属历史与基线，保留共享去重块并提示外部备份', async ({ page }) => {
  // 1. Create Work A (with Ch1, Ch2 and cloned Edition 2), Work B, and Reference project + attached source
  await newNovel(page, '小说甲')
  await textArea(page).fill('小说甲第一章初始正文。')
  await save(page)
  const workAUrl = page.url()
  await addChapter(page, '章节A2', '小说甲第二章正文。')
  await page.getByRole('button', { name: '另存为独立版本' }).click()
  await page.getByRole('textbox', { name: '版本名' }).fill('版本甲二')
  await page.getByRole('button', { name: '保存独立版本' }).click()
  await expect(page.getByRole('heading', { level: 2, name: '版本甲二' })).toBeVisible()

  await newNovel(page, '小说乙')
  await textArea(page).fill('小说乙保留正文。')
  await save(page)

  await page.goto('/#/reference')
  await page.locator('input[type=file]').setInputFiles(file('续写底本.txt', '续写底本第一行。'))
  await page.getByRole('link', { name: '查看 续写底本', exact: true }).click()
  await expect(page.getByRole('heading', { name: '续写列表' })).toBeVisible()
  await page.locator('input[type=file]').setInputFiles(file('附属资料.txt', '附属参考内容。'))
  await expect(page.getByRole('list', { name: '原文列表' }).getByRole('listitem')).toHaveCount(2)
  await page.getByRole('button', { name: '新建续写' }).click()
  await page.getByRole('textbox', { name: '续写名称' }).fill('续写草稿')
  await page.getByRole('button', { name: '开始续写' }).click()
  await expect(textArea(page)).toBeVisible()

  await page.goto('/#/ideas')
  const ideaInput = page.getByRole('textbox', { name: '灵感' })
  await ideaInput.fill('待删除灵感甲')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('待删除灵感甲')).toBeVisible()
  await ideaInput.fill('要保留灵感乙')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('要保留灵感乙')).toBeVisible()

  // Seed revisions, shared + exclusive revisionBlobs, 64KB aiBaselines, and ideaRevisions directly in IndexedDB
  const seeded = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('new-world-library')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const allBooks = await new Promise((r) => { const q = db.transaction('books').objectStore('books').getAll(); q.onsuccess = () => r(q.result) })
    const allEditions = await new Promise((r) => { const q = db.transaction('editions').objectStore('editions').getAll(); q.onsuccess = () => r(q.result) })
    const allIdeas = await new Promise((r) => { const q = db.transaction('ideas').objectStore('ideas').getAll(); q.onsuccess = () => r(q.result) })

    const workA = allBooks.find((b) => b.library === 'original' && b.title === '小说甲')
    const workB = allBooks.find((b) => b.library === 'original' && b.title === '小说乙')
    const edA1 = allEditions.find((e) => e.bookId === workA.id && e.name !== '版本甲二')
    const edA2 = allEditions.find((e) => e.bookId === workA.id && e.name === '版本甲二')
    const edB1 = allEditions.find((e) => e.bookId === workB.id)
    const chA2 = edA1.chapters.find((c) => c.title === '章节A2')
    const chA1 = edA1.chapters[0]
    const chA2Ed2 = edA2.chapters[0]
    const chB1 = edB1.chapters[0]
    const ideaDel = allIdeas.find((i) => i.text === '待删除灵感甲')
    const ideaKeep = allIdeas.find((i) => i.text === '要保留灵感乙')

    const makeBlob = (hash, label) => ({
      hash,
      encoding: 'json',
      data: new TextEncoder().encode(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: label }] }] })),
      rawBytes: 120,
      storedBytes: 120,
      createdAt: Date.now(),
    })

    const tx = db.transaction(['revisions', 'revisionBlobs', 'aiBaselines', 'ideaRevisions'], 'readwrite', { durability: 'strict' })
    const revStore = tx.objectStore('revisions')
    const blobStore = tx.objectStore('revisionBlobs')
    const baseStore = tx.objectStore('aiBaselines')
    const ideaRevStore = tx.objectStore('ideaRevisions')

    blobStore.put(makeBlob('blob-excl-a2', '独占章节A2快照'))
    blobStore.put(makeBlob('blob-excl-eda2', '独占版本甲二快照'))
    blobStore.put(makeBlob('blob-excl-booka', '独占小说甲快照'))
    blobStore.put(makeBlob('blob-shared-ab', '甲与乙共享去重快照'))

    const now = Date.now()
    const addRev = (id, lib, bookId, edId, chId, title, blobHash) => {
      revStore.put({
        id, library: lib, bookId, editionId: edId, chapterId: chId, chapterTitle: title,
        contentHash: blobHash, blobHash, rawBytes: 120, storedBytes: 120, words: 12,
        source: 'ai', action: 'chapters.update', clientId: 'test-ai', clientName: 'TestAI', createdAt: now,
      })
    }
    addRev('rev-a2-excl', 'original', workA.id, edA1.id, chA2.id, '章节A2', 'blob-excl-a2')
    addRev('rev-a2-shared', 'original', workA.id, edA1.id, chA2.id, '章节A2', 'blob-shared-ab')
    addRev('rev-eda2-excl', 'original', workA.id, edA2.id, chA2Ed2.id, chA2Ed2.title, 'blob-excl-eda2')
    addRev('rev-a1-bookexcl', 'original', workA.id, edA1.id, chA1.id, chA1.title, 'blob-excl-booka')
    addRev('rev-b1-shared', 'original', workB.id, edB1.id, chB1.id, chB1.title, 'blob-shared-ab')

    const largeAnchor = '基准锚点文本'.repeat(4000)
    baseStore.put({ clientId: 'test-ai', library: 'original', bookId: workA.id, editionId: edA1.id, chapterId: chA2.id, peakWords: 50, anchorWords: 50, anchorText: largeAnchor, updatedAt: now })
    baseStore.put({ clientId: 'test-ai', library: 'original', bookId: workA.id, editionId: edA2.id, chapterId: chA2Ed2.id, peakWords: 50, anchorWords: 50, anchorText: largeAnchor, updatedAt: now })
    baseStore.put({ clientId: 'test-ai', library: 'original', bookId: workA.id, editionId: edA1.id, chapterId: chA1.id, peakWords: 50, anchorWords: 50, anchorText: largeAnchor, updatedAt: now })
    baseStore.put({ clientId: 'test-ai', library: 'original', bookId: workB.id, editionId: edB1.id, chapterId: chB1.id, peakWords: 50, anchorWords: 50, anchorText: '保留作品基线', updatedAt: now })

    ideaRevStore.put({ id: 'irev-del-1', ideaId: ideaDel.id, text: '灵感甲历史版本1', source: 'ai', action: 'ideas.update', createdAt: now - 1000 })
    ideaRevStore.put({ id: 'irev-keep-1', ideaId: ideaKeep.id, text: '灵感乙历史版本1', source: 'ai', action: 'ideas.update', createdAt: now - 1000 })

    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    db.close()
    return { workAId: workA.id, workBId: workB.id, edA1Id: edA1.id, edA2Id: edA2.id, chA2Id: chA2.id, ideaDelId: ideaDel.id, ideaKeepId: ideaKeep.id }
  })

  const inspectDb = () => page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('new-world-library')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const getAll = (store) => new Promise((r) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => r(q.result) })
    const [revs, blobs, baselines, ideaRevs, trash] = await Promise.all([
      getAll('revisions'), getAll('revisionBlobs'), getAll('aiBaselines'), getAll('ideaRevisions'), getAll('trash'),
    ])
    db.close()
    return {
      revIds: revs.map((r) => r.id),
      blobHashes: blobs.map((b) => b.hash),
      baselineChapters: baselines.map((b) => `${b.bookId}:${b.editionId}:${b.chapterId}`),
      ideaRevIds: ideaRevs.map((r) => r.id),
      trashCount: trash.length,
    }
  })

  // 2. Soft-delete Chapter A2 -> must keep its revisions/blobs/baselines intact while in Trash
  await page.goto(workAUrl)
  await page.getByRole('button', { name: '章节A2', exact: true }).click()
  await page.getByRole('button', { name: '删除章节' }).click()
  await page.getByRole('button', { name: '确认删除章节' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '章节A2', exact: true })).toHaveCount(0)
  const afterSoftCh = await inspectDb()
  expect(afterSoftCh.revIds).toEqual(expect.arrayContaining(['rev-a2-excl', 'rev-a2-shared']))
  expect(afterSoftCh.blobHashes).toContain('blob-excl-a2')

  // Permanently delete Chapter A2 -> external backup warning shown; exclusive records gone, shared blob kept
  await page.goto('/#/trash')
  await trashRow(page, '章节A2').getByRole('button', { name: '彻底删除' }).click()
  await expect(page.getByRole('dialog')).toContainText('此前导出或自动生成的外部备份文件不会被删除，其中仍可能保存历史数据。')
  await page.getByRole('button', { name: '确认彻底删除' }).click()
  await expect(trashRow(page, '章节A2')).toHaveCount(0)

  const afterPermCh = await inspectDb()
  expect(afterPermCh.revIds).not.toContain('rev-a2-excl')
  expect(afterPermCh.revIds).not.toContain('rev-a2-shared')
  expect(afterPermCh.blobHashes).not.toContain('blob-excl-a2')
  expect(afterPermCh.blobHashes).toContain('blob-shared-ab')
  expect(afterPermCh.baselineChapters.some((k) => k.endsWith(`:${seeded.chA2Id}`))).toBe(false)

  // 3. Soft-delete Edition 2 -> permanently delete -> exclusive edition data gone, shared blob still kept for Work B
  await page.goto(`/#/original/${seeded.workAId}/${seeded.edA2Id}`)
  await page.getByRole('button', { name: '删除版本' }).click()
  await page.getByRole('button', { name: '确认删除版本' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('link', { name: '版本甲二' })).toHaveCount(0)
  await page.goto('/#/trash')
  await trashRow(page, '版本甲二').getByRole('button', { name: '彻底删除' }).click()
  await page.getByRole('button', { name: '确认彻底删除' }).click()
  await expect(trashRow(page, '版本甲二')).toHaveCount(0)
  const afterPermEd = await inspectDb()
  expect(afterPermEd.revIds).not.toContain('rev-eda2-excl')
  expect(afterPermEd.blobHashes).not.toContain('blob-excl-eda2')
  expect(afterPermEd.blobHashes).toContain('blob-shared-ab')
  expect(afterPermEd.baselineChapters.some((k) => k.includes(`:${seeded.edA2Id}:`))).toBe(false)

  // 4. Permanently delete whole Work A -> all remaining Work A revisions/blobs/baselines purged; Work B + shared blob survive
  await page.goto('/#/original')
  await bookAction(page, '删除', '小说甲')
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('li', { hasText: '小说甲' })).toHaveCount(0)
  await page.goto('/#/trash')
  await trashRow(page, '小说甲').getByRole('button', { name: '彻底删除' }).click()
  await page.getByRole('button', { name: '确认彻底删除' }).click()
  await expect(trashRow(page, '小说甲')).toHaveCount(0)
  const afterPermBook = await inspectDb()
  expect(afterPermBook.revIds).not.toContain('rev-a1-bookexcl')
  expect(afterPermBook.blobHashes).not.toContain('blob-excl-booka')
  expect(afterPermBook.baselineChapters.some((k) => k.startsWith(`${seeded.workAId}:`))).toBe(false)
  expect(afterPermBook.revIds).toContain('rev-b1-shared')
  expect(afterPermBook.blobHashes).toContain('blob-shared-ab')

  // 5. Permanently delete attached source on reference project
  await page.goto('/#/reference')
  await page.getByRole('link', { name: '查看 续写底本', exact: true }).click()
  await expect(page.getByRole('list', { name: '原文列表' })).toBeVisible()
  await page.getByRole('list', { name: '原文列表' }).locator('li', { hasText: '附属资料' }).getByRole('button', { name: '移除原文' }).click()
  await page.getByRole('button', { name: '确认移除原文' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('list', { name: '原文列表' }).locator('li', { hasText: '附属资料' })).toHaveCount(0)
  await page.goto('/#/trash')
  await trashRow(page, '附属资料').getByRole('button', { name: '彻底删除' }).click()
  await page.getByRole('button', { name: '确认彻底删除' }).click()
  await expect(trashRow(page, '附属资料')).toHaveCount(0)

  // 6. Soft-delete Idea 甲 keeps ideaRevisions; permanently deleting purges irev-del-1 while irev-keep-1 remains
  await page.goto('/#/ideas')
  const ideaRowDel = page.locator('li.idea-row', { hasText: '待删除灵感甲' })
  await ideaRowDel.getByRole('button', { name: '灵感操作' }).click()
  await page.getByRole('menuitem', { name: '删除' }).click()
  await expect(ideaRowDel).toHaveCount(0)
  const afterSoftIdea = await inspectDb()
  expect(afterSoftIdea.ideaRevIds).toContain('irev-del-1')
  await page.goto('/#/trash')
  await trashRow(page, '待删除灵感甲').getByRole('button', { name: '彻底删除' }).click()
  await page.getByRole('button', { name: '确认彻底删除' }).click()
  await expect(trashRow(page, '待删除灵感甲')).toHaveCount(0)
  const afterPermIdea = await inspectDb()
  expect(afterPermIdea.ideaRevIds).not.toContain('irev-del-1')
  expect(afterPermIdea.ideaRevIds).toContain('irev-keep-1')
})

test('清空回收站清净关联与孤立历史记录、提示外部备份不受影响且不误伤现存作品数据', async ({ page }) => {
  await newNovel(page, '留存精品')
  await textArea(page).fill('留存精品正文。')
  await save(page)

  await newNovel(page, '待清空草稿')
  await textArea(page).fill('待清空草稿正文。')
  await save(page)
  await page.goto('/#/original')
  await page.locator('li', { hasText: '待清空草稿' }).getByRole('button', { name: /操作/ }).click()
  await page.getByRole('menuitem', { name: '删除' }).click()
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('li', { hasText: '待清空草稿' })).toHaveCount(0)

  const seeded = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('new-world-library')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const books = await new Promise((r) => { const q = db.transaction('books').objectStore('books').getAll(); q.onsuccess = () => r(q.result) })
    const editions = await new Promise((r) => { const q = db.transaction('editions').objectStore('editions').getAll(); q.onsuccess = () => r(q.result) })
    const keepBook = books.find((b) => b.title === '留存精品')
    const keepEd = editions.find((e) => e.bookId === keepBook.id)
    const keepCh = keepEd.chapters[0]

    const makeBlob = (hash, label) => ({
      hash,
      encoding: 'json',
      data: new TextEncoder().encode(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: label }] }] })),
      rawBytes: 100,
      storedBytes: 100,
      createdAt: Date.now(),
    })

    const tx = db.transaction(['revisions', 'revisionBlobs', 'aiBaselines', 'ideaRevisions'], 'readwrite', { durability: 'strict' })
    tx.objectStore('revisionBlobs').put(makeBlob('blob-keep-active', '留存正文快照'))
    tx.objectStore('revisionBlobs').put(makeBlob('blob-orphan-legacy', '历史遗留孤立快照'))
    tx.objectStore('revisions').put({
      id: 'rev-keep-active', library: 'original', bookId: keepBook.id, editionId: keepEd.id, chapterId: keepCh.id,
      chapterTitle: keepCh.title, contentHash: 'blob-keep-active', blobHash: 'blob-keep-active',
      rawBytes: 100, storedBytes: 100, words: 10, source: 'ai', action: 'chapters.update', createdAt: Date.now(),
    })
    tx.objectStore('revisions').put({
      id: 'rev-orphan-legacy', library: 'original', bookId: 'ghost-book', editionId: 'ghost-ed', chapterId: 'ghost-ch',
      chapterTitle: '幽灵章', contentHash: 'blob-orphan-legacy', blobHash: 'blob-orphan-legacy',
      rawBytes: 100, storedBytes: 100, words: 10, source: 'ai', action: 'chapters.update', createdAt: Date.now(),
    })
    tx.objectStore('aiBaselines').put({
      clientId: 'ai-1', library: 'original', bookId: keepBook.id, editionId: keepEd.id, chapterId: keepCh.id,
      peakWords: 10, anchorWords: 10, anchorText: '保留基线', updatedAt: Date.now(),
    })
    tx.objectStore('aiBaselines').put({
      clientId: 'ai-1', library: 'original', bookId: 'ghost-book', editionId: 'ghost-ed', chapterId: 'ghost-ch',
      peakWords: 100, anchorWords: 100, anchorText: '幽灵基线'.repeat(2000), updatedAt: Date.now(),
    })
    tx.objectStore('ideaRevisions').put({
      id: 'irev-orphan-legacy', ideaId: 'ghost-idea', text: '幽灵灵感历史', source: 'ai', action: 'ideas.update', createdAt: Date.now(),
    })
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    db.close()
    return { keepBookId: keepBook.id }
  })

  await page.goto('/#/trash')
  await page.getByRole('button', { name: '清空回收站' }).click()
  await expect(page.getByRole('dialog')).toContainText('此前导出或自动生成的外部备份文件不会被删除，其中仍可能保存历史数据。')
  await page.getByRole('button', { name: '确认清空' }).click()
  await expect(page.getByText('回收站是空的')).toBeVisible()

  const postEmpty = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('new-world-library')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const getAll = (store) => new Promise((r) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => r(q.result) })
    const [revs, blobs, baselines, ideaRevs, trash] = await Promise.all([
      getAll('revisions'), getAll('revisionBlobs'), getAll('aiBaselines'), getAll('ideaRevisions'), getAll('trash'),
    ])
    db.close()
    return { revs, blobs, baselines, ideaRevs, trash }
  })
  expect(postEmpty.trash).toHaveLength(0)
  expect(postEmpty.revs.map((r) => r.id)).toEqual(['rev-keep-active'])
  expect(postEmpty.blobs.map((b) => b.hash)).toEqual(['blob-keep-active'])
  expect(postEmpty.baselines.map((b) => b.bookId)).toEqual([seeded.keepBookId])
  expect(postEmpty.ideaRevs).toHaveLength(0)
})
