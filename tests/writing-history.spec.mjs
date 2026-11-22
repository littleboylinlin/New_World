import { readFile } from 'node:fs/promises'
import { TextWriter, Uint8ArrayReader, ZipReader } from '@zip.js/zip.js'
import { expect, pastFirstVisit, test, withoutRelease } from './app-test.mjs'
import { chapterHeading, editorAction, historyCount, saveNow } from './editor-helpers.mjs'
import { startWork } from './navigation-helpers.mjs'

const textArea = (page) => page.getByRole('textbox', { name: '章节正文' })
const saveStatus = (page) => page.locator('.save-status')

async function createNovel(page, name) {
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill(name)
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(textArea(page)).toBeVisible()
}

async function replaceAllAndSave(page, nextText) {
  await textArea(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(nextText)
  await saveNow(page)
  await expect(saveStatus(page)).toHaveText('已保存')
}

test('大幅修改（全选替换、大段删除）保存时自动保留旧正文，切章或刷新后可预览恢复 @webkit', async ({ page }) => {
  await createNovel(page, '普通写作历史保护')

  const para1 = '雾从海面漫过来时，林栖把最后一盏信号灯擦亮，仔细校准灯罩下的机械齿轮，确认每一道刻度都指向安全的航道。'.repeat(2)
  const para2 = '港口的钟声在凌晨三点准时响起，潮水沿着石阶缓慢退去，岸边铁链发出细碎声响。值守日志还摊在桌上，墨迹未干，记着昨夜经过灯塔的那艘货轮编号与航向。'.repeat(3)

  await textArea(page).click()
  await page.keyboard.insertText(para1)
  await page.keyboard.press('Enter')
  await page.keyboard.insertText(para2)
  await saveNow(page)
  await expect(saveStatus(page)).toHaveText('已保存')
  expect(await historyCount(page)).toBe('')

  // 小幅追加不生成额外快照
  await textArea(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('她回头看了一眼。')
  await saveNow(page)
  await expect(saveStatus(page)).toHaveText('已保存')
  expect(await historyCount(page)).toBe('')

  // 全选替换导致大面积覆盖 -> 自动保留大幅修改前正文
  await replaceAllAndSave(page, '误粘贴进来的单行内容。')
  await expect.poll(() => historyCount(page)).toBe('1')

  // 新建并切换章节，再切回并刷新页面（撤销栈已清空）
  await page.getByRole('button', { name: '新建章节' }).click()
  await page.getByRole('textbox', { name: '章节名' }).fill('第二章')
  await page.getByRole('button', { name: '创建章节' }).click()
  await expect(chapterHeading(page)).toHaveText('第二章')
  await page.getByRole('button', { name: '第一章', exact: true }).click()
  await expect(chapterHeading(page)).toHaveText('第一章')
  await expect(textArea(page)).toHaveText('误粘贴进来的单行内容。')

  await page.reload()
  await expect(chapterHeading(page)).toHaveText('第一章')
  await expect(textArea(page)).toHaveText('误粘贴进来的单行内容。')

  // 在历史版本中预览并恢复旧正文，同时确认恢复前自动备份当前内容
  await editorAction(page, '历史版本')
  const histDialog = page.getByRole('dialog', { name: /历史版本/ })
  await expect(histDialog.locator('button.revision-item')).toHaveCount(1)
  await expect(histDialog.locator('button.revision-item').first()).toContainText('大幅修改前')
  await expect(histDialog.locator('.revision-preview-text')).toContainText('林栖把最后一盏信号灯擦亮')
  await expect(histDialog.locator('.revision-preview-text')).toContainText('她回头看了一眼。')

  await histDialog.getByRole('button', { name: '恢复此版本' }).click()
  await expect(histDialog).toBeHidden()
  await expect(textArea(page)).toContainText('林栖把最后一盏信号灯擦亮')
  await expect(textArea(page)).toContainText('她回头看了一眼。')
  await expect.poll(() => historyCount(page)).toBe('2')

  await editorAction(page, '历史版本')
  await expect(histDialog.locator('button.revision-item')).toHaveCount(2)
  await expect(histDialog.locator('button.revision-item').first()).toContainText('恢复前自动备份')
  await expect(histDialog.locator('.revision-preview-text')).toHaveText('误粘贴进来的单行内容。')
  await histDialog.locator('button.revision-item').nth(1).click()
  await expect(histDialog.locator('button.revision-item').nth(1)).toContainText('大幅修改前')
  await expect(histDialog.locator('.revision-preview-text')).toContainText('她回头看了一眼。')
  await histDialog.getByRole('button', { name: '关闭' }).first().click()
  await expect(histDialog).toBeHidden()

  // 大段删除（删去第二段与尾句，保留第一段）：同样触发「大幅修改前」快照
  await replaceAllAndSave(page, para1)
  await expect.poll(() => historyCount(page)).toBe('3')
  await editorAction(page, '历史版本')
  await expect(histDialog.locator('button.revision-item').first()).toContainText('大幅修改前')
  await expect(histDialog.locator('.revision-preview-text')).toContainText('港口的钟声在凌晨三点准时响起')
  await expect(histDialog.locator('.revision-preview-text')).toContainText('她回头看了一眼。')
  await histDialog.getByRole('button', { name: '关闭' }).first().click()
})

test('连续写作满 10 分钟后保存才记录定时快照，短时间内频繁保存不刷历史', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-06-01T10:00:00Z') })
  await createNovel(page, '十分钟定时快照试验')

  // 首次非空保存只开始计时，不建快照
  await textArea(page).click()
  await page.keyboard.insertText('清晨的港口响起第一声汽笛。')
  await saveNow(page)
  await expect(saveStatus(page)).toHaveText('已保存')
  expect(await historyCount(page)).toBe('')

  // 5 分钟后小改保存：未满 10 分钟，不记快照
  await page.clock.fastForward(5 * 60 * 1000)
  await textArea(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('风吹动码头绳索。')
  await saveNow(page)
  await expect(saveStatus(page)).toHaveText('已保存')
  expect(await historyCount(page)).toBe('')

  // 再过 5 分 5 秒（距首次保存满 10 分钟）：保存时保留上一版已落盘正文
  await page.clock.fastForward(5 * 60 * 1000 + 5_000)
  await textArea(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('远处亮起航标灯。')
  await saveNow(page)
  await expect(saveStatus(page)).toHaveText('已保存')
  await expect.poll(() => historyCount(page)).toBe('1')

  await editorAction(page, '历史版本')
  const histDialog = page.getByRole('dialog', { name: /历史版本/ })
  await expect(histDialog.locator('button.revision-item')).toHaveCount(1)
  await expect(histDialog.locator('button.revision-item').first()).toContainText('写作中自动保留')
  await expect(histDialog.locator('.revision-preview-text')).toHaveText('清晨的港口响起第一声汽笛。风吹动码头绳索。')
  await histDialog.getByRole('button', { name: '关闭' }).first().click()

  // 4 分钟后小改不触发；满下一个 10 分钟后再保留一条
  await page.clock.fastForward(4 * 60 * 1000)
  await textArea(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('潮声渐近。')
  await saveNow(page)
  await expect(saveStatus(page)).toHaveText('已保存')
  expect(await historyCount(page)).toBe('1')

  await page.clock.fastForward(6 * 60 * 1000 + 5_000)
  await textArea(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('天色将明。')
  await saveNow(page)
  await expect(saveStatus(page)).toHaveText('已保存')
  await expect.poll(() => historyCount(page)).toBe('2')

  await editorAction(page, '历史版本')
  await expect(histDialog.locator('button.revision-item')).toHaveCount(2)
  await expect(histDialog.locator('button.revision-item').first()).toContainText('写作中自动保留')
  await expect(histDialog.locator('.revision-preview-text')).toContainText('潮声渐近。')
  await expect(histDialog.locator('.revision-preview-text')).not.toContainText('天色将明。')
})

test('每章最多保留 30 条写作快照并回收孤立载荷（不影响 AI 快照），写快照失败时退回普通保存', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  await createNovel(page, '写作快照上限与降级保存')
  const v0 = '第零版原始长正文，'.repeat(30)
  await textArea(page).click()
  await page.keyboard.insertText(v0)
  await saveNow(page)
  await expect(saveStatus(page)).toHaveText('已保存')

  const urlMatch = new URL(page.url()).hash.match(/^#\/original\/([^/]+)\/([^/]+)$/)
  expect(urlMatch).toBeTruthy()
  const [, bookId, editionId] = urlMatch

  const chapterId = await page.evaluate(async ([bId, edId]) => {
    const db = await new Promise((resolve, reject) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => resolve(q.result)
      q.onerror = () => reject(q.error)
    })
    const edition = await new Promise((resolve) => {
      const q = db.transaction('editions').objectStore('editions').get(['original', bId, edId])
      q.onsuccess = () => resolve(q.result)
    })
    const chId = edition.chapters[0].id
    const enc = new TextEncoder()
    const mkBlob = (hash, text, at) => {
      const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
      const raw = enc.encode(JSON.stringify(doc))
      return { hash, encoding: 'json', data: raw, rawBytes: raw.byteLength, storedBytes: raw.byteLength, createdAt: at }
    }
    const baseAt = Date.now() - 100_000
    const aiBlob = mkBlob('ai-only-blob-hash', 'AI 历史保留版本。', baseAt - 10_000)
    const orphanBlob = mkBlob('orphan-writing-blob-hash', '将被淘汰的最旧写作快照。', baseAt)
    const keptBlob = mkBlob('kept-writing-blob-hash', '保留下来的较新写作快照。', baseAt + 1000)

    const tx = db.transaction(['revisions', 'revisionBlobs'], 'readwrite', { durability: 'strict' })
    const blobsStore = tx.objectStore('revisionBlobs')
    const revStore = tx.objectStore('revisions')
    blobsStore.put(aiBlob)
    blobsStore.put(orphanBlob)
    blobsStore.put(keptBlob)

    revStore.add({
      id: 'ai-rev-keep',
      library: 'original',
      bookId: bId,
      editionId: edId,
      chapterId: chId,
      chapterTitle: '第一章',
      editionName: edition.name,
      chapterRevision: 0,
      blobHash: aiBlob.hash,
      contentHash: aiBlob.hash,
      rawBytes: aiBlob.rawBytes,
      storedBytes: aiBlob.storedBytes,
      words: 9,
      source: 'ai',
      action: 'chapters.update',
      clientName: 'Tester',
      createdAt: baseAt - 10_000,
    })

    for (let i = 0; i < 29; i++) {
      const blob = i === 0 ? orphanBlob : keptBlob
      revStore.add({
        id: `writing-seed-${i}`,
        library: 'original',
        bookId: bId,
        editionId: edId,
        chapterId: chId,
        chapterTitle: '第一章',
        editionName: edition.name,
        chapterRevision: i,
        blobHash: blob.hash,
        contentHash: blob.hash,
        rawBytes: blob.rawBytes,
        storedBytes: blob.storedBytes,
        words: 12,
        source: 'writing',
        action: 'interval',
        createdAt: baseAt + i * 1000,
      })
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onabort = () => reject(tx.error)
    })
    db.close()
    return chId
  }, [bookId, editionId])

  // 两次大幅替换写入（29 + 2 = 31 -> 淘汰最旧 1 条，回收孤立载荷，AI 快照保持不变）
  await replaceAllAndSave(page, '第一轮大幅替换的长正文内容，'.repeat(25))
  await replaceAllAndSave(page, '第二轮大幅替换的长正文内容，'.repeat(25))

  const stored = await page.evaluate(async ([bId, edId, chId]) => {
    const db = await new Promise((resolve, reject) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => resolve(q.result)
      q.onerror = () => reject(q.error)
    })
    const revs = await new Promise((resolve) => {
      const q = db.transaction('revisions').objectStore('revisions').index('byChapter').getAll(['original', bId, edId, chId])
      q.onsuccess = () => resolve(q.result)
    })
    const blobs = await new Promise((resolve) => {
      const q = db.transaction('revisionBlobs').objectStore('revisionBlobs').getAll()
      q.onsuccess = () => resolve(q.result.map((b) => b.hash))
    })
    db.close()
    return {
      total: revs.length,
      writingCount: revs.filter((r) => r.source === 'writing').length,
      hasOldestSeed: revs.some((r) => r.id === 'writing-seed-0'),
      hasAiRev: revs.some((r) => r.id === 'ai-rev-keep'),
      blobHashes: blobs,
    }
  }, [bookId, editionId, chapterId])

  expect(stored.writingCount).toBe(30)
  expect(stored.total).toBe(31)
  expect(stored.hasOldestSeed).toBe(false)
  expect(stored.hasAiRev).toBe(true)
  expect(stored.blobHashes).not.toContain('orphan-writing-blob-hash')
  expect(stored.blobHashes).toContain('ai-only-blob-hash')
  expect(stored.blobHashes).toContain('kept-writing-blob-hash')

  // 故障注入：写 revisions 抛出 QuotaExceededError 时，退回不带快照的普通保存，正文仍可靠落盘
  try {
    await page.evaluate(() => {
      const origAdd = IDBObjectStore.prototype.add
      window.__restoreIdbAdd = () => { IDBObjectStore.prototype.add = origAdd }
      IDBObjectStore.prototype.add = function (...args) {
        if (this.name === 'revisions') {
          throw new DOMException('Simulated quota exceeded for snapshot', 'QuotaExceededError')
        }
        return origAdd.apply(this, args)
      }
    })

    await replaceAllAndSave(page, '配额已满时也必须保存成功。')
    await expect(page.locator('.editor-notices .notice-error')).toBeHidden()
    expect(pageErrors).toEqual([])
  } finally {
    await page.evaluate(() => { window.__restoreIdbAdd?.() }).catch(() => {})
  }

  await page.reload()
  await expect(textArea(page)).toHaveText('配额已满时也必须保存成功。')
})

test('含写作历史快照的 .newworld 工程可导出并在干净书库中导入与恢复', async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000)
  await page.addInitScript(() => { window.showSaveFilePicker = undefined })
  await createNovel(page, '工程写作历史测试')

  const originalProse = '准备写入工程文件的第一章正文内容，至少两百多个字用来触发大幅修改快照。'.repeat(7)
  await textArea(page).click()
  await page.keyboard.insertText(originalProse)
  await saveNow(page)
  await expect(saveStatus(page)).toHaveText('已保存')

  await replaceAllAndSave(page, '覆写后的工程当前正文。')
  await expect.poll(() => historyCount(page)).toBe('1')

  await page.goto('/#/original')
  await page.locator('.book-card').filter({ hasText: '工程写作历史测试' }).locator('.book-menu-toggle').click()
  await page.getByRole('menuitem', { name: '导出 New_World 工程（.newworld）', exact: true }).click()
  const projectPath = testInfo.outputPath('writing-history.newworld')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('dialog', { name: '导出 New_World 工程（.newworld）' }).getByRole('button', { name: '保存工程', exact: true }).click()
  const downloaded = await downloadPromise
  await downloaded.saveAs(projectPath)
  await expect(page.getByRole('dialog', { name: '导出 New_World 工程（.newworld）' })).toBeHidden()

  const zip = new ZipReader(new Uint8ArrayReader(await readFile(projectPath)), { useWebWorkers: false })
  const revEntry = (await zip.getEntries()).find((e) => e.filename === 'revisions/chapters.json')
  expect(revEntry).toBeTruthy()
  const exportedRevisions = JSON.parse(await revEntry.getData(new TextWriter()))
  await zip.close()
  expect(exportedRevisions).toHaveLength(1)
  expect(exportedRevisions[0].source).toBe('writing')
  expect(exportedRevisions[0].action).toBe('large-change')

  const cleanContext = await withoutRelease(await pastFirstVisit(await browser.newContext({ locale: 'zh-CN' })))
  try {
    const cleanPage = await cleanContext.newPage()
    await cleanPage.goto('/#/original')
    const chooser = cleanPage.waitForEvent('filechooser')
    await cleanPage.getByRole('button', { name: '导入', exact: true }).click()
    await (await chooser).setFiles(projectPath)

    const importDialog = cleanPage.getByRole('dialog', { name: '导入工程预览' })
    await expect(importDialog).toBeVisible()
    await importDialog.getByRole('button', { name: '确认导入' }).click()
    await expect(importDialog).toBeHidden()

    await expect(cleanPage).toHaveURL(/#\/original\/[^/]+/)
    await expect(textArea(cleanPage)).toHaveText('覆写后的工程当前正文。')
    await expect.poll(() => historyCount(cleanPage)).toBe('1')

    await editorAction(cleanPage, '历史版本')
    const histDialog = cleanPage.getByRole('dialog', { name: /历史版本/ })
    await expect(histDialog.locator('button.revision-item').first()).toContainText('大幅修改前')
    await expect(histDialog.locator('.revision-preview-text')).toHaveText(originalProse)
    await histDialog.getByRole('button', { name: '恢复此版本' }).click()
    await expect(textArea(cleanPage)).toHaveText(originalProse)
  } finally {
    await cleanContext.close()
  }
})
