import { startWork } from './navigation-helpers.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { expect, test } from './app-test.mjs'
import { bookAction } from './fixtures.mjs'
import { editWorkInformation, editorAction, historyCount, saveNow } from './editor-helpers.mjs'

const textArea = (page) => page.getByRole('textbox', { name: '章节正文' })
const settings = (page) => page.locator('.settings-page')
const backupSection = (page) => settings(page).getByRole('region', { name: '备份与恢复', exact: true })

async function openBackupSettings(page) {
  await page.getByRole('link', { name: '设置', exact: true }).click()
  await settings(page).getByRole('link', { name: '备份与恢复', exact: true }).click()
}

async function closeSettings(page) {
  await settings(page).locator('.settings-back').click()
  await expect(settings(page)).toBeHidden()
}

async function newNovel(page, name, text) {
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill(name)
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(textArea(page)).toBeVisible()
  await textArea(page).fill(text)
  await saveNow(page)
  await expect(page.locator('.save-status')).toHaveText('已保存')
}

async function backUp(page, testInfo, name, password) {
  await openBackupSettings(page)
  const download = page.waitForEvent('download')
  await backupSection(page).getByRole('button', { name: '立即备份' }).click()
  if (password) {
    const dialog = page.getByRole('dialog', { name: '为这份备份设置密码' })
    await dialog.getByLabel('密码', { exact: true }).fill(password)
    await dialog.getByLabel('再次输入密码').fill(password)
    await dialog.getByRole('button', { name: '设置密码' }).click()
  }
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^New-World-backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/)
  const path = testInfo.outputPath(name)
  await file.saveAs(path)
  await expect(backupSection(page).locator('.backup-state')).toContainText('已备份 1 部作品')
  await closeSettings(page)
  return path
}

async function keepIdea(page, text) {
  await page.goto('/#/ideas')
  await page.getByRole('textbox', { name: '灵感' }).fill(text)
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('list', { name: '灵感列表' })).toContainText(text)
}

async function chooseBackup(page, path) {
  await openBackupSettings(page)
  const chooser = page.waitForEvent('filechooser')
  await backupSection(page).getByRole('button', { name: '从备份恢复…' }).click()
  await (await chooser).setFiles(path)
}

test('作品可以归档、撤销归档，在归档页打开和放回书库', async ({ page }) => {
  await newNovel(page, '旧港口', '码头上的灯一盏盏灭了。')
  await page.goto('/#/original')
  await bookAction(page, '归档')
  await expect(page.getByText('还没有原创作品')).toBeVisible()
  await page.getByRole('status').filter({ hasText: '已归档「旧港口」' }).getByRole('button', { name: '撤销' }).click()
  await expect(page.getByRole('link', { name: '查看 旧港口', exact: true })).toBeVisible()

  await bookAction(page, '归档')
  await page.goto('/#/')
  await page.goto('/#/original')
  await expect(page.locator('.list-count')).toHaveText('0 部')
  await page.getByRole('link', { name: '归档', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: '归档' })).toBeVisible()
  const row = page.getByRole('list', { name: '归档的作品' }).getByRole('listitem').filter({ hasText: '旧港口' })
  await expect(row).toContainText('原创库')
  await row.getByRole('link', { name: '旧港口' }).click()
  await expect(textArea(page)).toHaveText('码头上的灯一盏盏灭了。')

  await page.goto('/#/archive')
  await row.getByRole('button', { name: '取消归档' }).click()
  await expect(page.getByText('还没有归档的作品')).toBeVisible()
  await page.goto('/#/original')
  await expect(page.getByRole('link', { name: '查看 旧港口', exact: true })).toBeVisible()
})

test('立即备份后可从备份恢复整个书库，包括归档和回收站', async ({ page }, testInfo) => {
  await newNovel(page, '雾中灯塔', 'The keeper climbed the stairs. 灯塔守望者。')
  await editWorkInformation(page)
  const information = page.getByRole('dialog', { name: '编辑作品信息', exact: true })
  await information.getByLabel('作者', { exact: true }).fill('备份作者')
  await information.getByLabel('作品简介', { exact: true }).fill('第一段。\n\n第二段。')
  await information.getByRole('button', { name: '保存作品信息', exact: true }).click()
  await expect(information).toBeHidden()
  await page.goto('/#/original')
  await bookAction(page, '归档')
  await keepIdea(page, '灯塔下埋着一封信')
  const path = await backUp(page, testInfo, 'plain-backup.zip')
  const zip = await readFile(path)
  expect(zip.subarray(0, 2).toString()).toBe('PK')
  // Bit 0 of the general purpose flags marks an encrypted entry.
  expect(zip[6] & 1).toBe(0)
  const reader = new ZipReader(new Uint8ArrayReader(zip))
  const entry = (await reader.getEntries()).find((item) => item.filename === 'new-world-backup.json')
  const manifest = JSON.parse(await entry.getData(new TextWriter()))
  await reader.close()
  // The heatmap's writing history travels with the library.
  expect(manifest.writingDays.reduce((sum, day) => sum + day.words, 0)).toBeGreaterThan(0)
  expect(manifest.ideas.map((idea) => idea.text)).toEqual(['灯塔下埋着一封信'])
  expect(manifest.books[0].metadata).toEqual({ author: '备份作者', synopsis: '第一段。\n\n第二段。' })

  // Change the library, then restore.
  await page.goto('/#/archive')
  await page.getByRole('button', { name: '取消归档' }).click()
  await newNovel(page, '备份之后', '这部不在备份里。')
  await keepIdea(page, '备份之后的灵感')
  await chooseBackup(page, path)
  const confirm = page.getByRole('dialog', { name: '从备份恢复' })
  await expect(confirm).toContainText('1 部作品')
  await confirm.getByRole('button', { name: '替换当前书库' }).click()
  await expect(page.getByText('已从备份恢复 1 部作品。')).toBeVisible()
  await page.goto('/#/original')
  await expect(page.locator('.list-count')).toHaveText('0 部')
  await page.goto('/#/archive')
  await page.getByRole('link', { name: '雾中灯塔' }).click()
  await expect(textArea(page)).toHaveText('The keeper climbed the stairs. 灯塔守望者。')
  await editWorkInformation(page)
  const restoredInformation = page.getByRole('dialog', { name: '编辑作品信息', exact: true })
  await expect(restoredInformation.getByLabel('作者', { exact: true })).toHaveValue('备份作者')
  await expect(restoredInformation.getByLabel('作品简介', { exact: true })).toHaveValue('第一段。\n\n第二段。')
  await restoredInformation.getByRole('button', { name: '取消', exact: true }).click()
  await page.goto('/#/ideas')
  await expect(page.getByRole('list', { name: '灵感列表' }).locator('.idea-text')).toHaveText(['灯塔下埋着一封信'])
})

test('加密备份需要正确密码才能恢复，损坏的文件会被拒绝', async ({ page }, testInfo) => {
  await newNovel(page, '密封的信', '只有知道密码的人才能读到。')
  await openBackupSettings(page)
  await backupSection(page).getByRole('radio', { name: '用密码加密' }).check()
  await expect(backupSection(page).locator('.backup-state')).toHaveText('之后每次备份时会请你设置密码。')
  await closeSettings(page)

  // Mismatched passwords are caught before anything is written.
  await openBackupSettings(page)
  await backupSection(page).getByRole('button', { name: '立即备份' }).click()
  const ask = page.getByRole('dialog', { name: '为这份备份设置密码' })
  await ask.getByLabel('密码', { exact: true }).fill('lighthouse')
  await ask.getByLabel('再次输入密码').fill('lighthous')
  await ask.getByRole('button', { name: '设置密码' }).click()
  await expect(ask.getByRole('alert')).toHaveText('两次输入的密码不一致。')
  await ask.getByRole('button', { name: '取消' }).click()
  await closeSettings(page)

  const path = await backUp(page, testInfo, 'encrypted-backup.zip', 'lighthouse')
  expect((await readFile(path))[6] & 1).toBe(1)

  await page.goto('/#/original')
  await bookAction(page, '删除')
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByText('还没有原创作品')).toBeVisible()

  await chooseBackup(page, path)
  const password = page.getByRole('dialog', { name: '输入备份密码' })
  await password.getByLabel('密码', { exact: true }).fill('wrong')
  await password.getByRole('button', { name: '打开' }).click()
  await expect(password.getByRole('alert')).toHaveText('密码不正确。')
  await password.getByLabel('密码', { exact: true }).fill('lighthouse')
  await password.getByRole('button', { name: '打开' }).click()
  await page.getByRole('dialog', { name: '从备份恢复' }).getByRole('button', { name: '替换当前书库' }).click()
  await expect(page.getByText('已从备份恢复 1 部作品。')).toBeVisible()
  await page.goto('/#/original')
  await page.getByRole('link', { name: '查看 密封的信', exact: true }).click()
  await expect(textArea(page)).toHaveText('只有知道密码的人才能读到。')

  const broken = testInfo.outputPath('broken.zip')
  await writeFile(broken, 'not a zip at all')
  await chooseBackup(page, broken)
  await expect(backupSection(page).getByRole('alert')).toHaveText('这不是 New World 备份文件，或文件已损坏。')
})

test('备份恢复拦截超量条目与超限解压体积的 ZIP 炸弹且保留现有书库', async ({ page }, testInfo) => {
  await newNovel(page, '安全书库', '炸弹文件不能擦掉原有内容。')

  // 1. Entry count exceeds maxBackupZipEntries (10,000)
  const manyEntriesPath = testInfo.outputPath('too-many-entries.zip')
  const entryWriter = new ZipWriter(new Uint8ArrayWriter())
  await entryWriter.add('new-world-backup.json', new TextReader(JSON.stringify({
    format: 'new-world-library-backup',
    version: 1,
    app: '0.15.2',
    createdAt: Date.now(),
    books: [],
    files: [],
    editions: [],
    chapters: [],
    trash: [],
    writingDays: [],
    ideas: [],
  })), { level: 0 })
  for (let i = 0; i < 10_005; i++) {
    await entryWriter.add(`junk/${i}`, new TextReader('x'), { level: 0 })
  }
  await writeFile(manyEntriesPath, await entryWriter.close())
  await chooseBackup(page, manyEntriesPath)
  await expect(backupSection(page).getByRole('alert')).toHaveText('备份文件太大，无法打开。')
  await closeSettings(page)

  // 2. Deflated manifest exceeds maxBackupManifestBytes (64 MiB) while ZIP on disk is tiny
  const inflatedBombPath = testInfo.outputPath('manifest-bomb.zip')
  const bombWriter = new ZipWriter(new Uint8ArrayWriter())
  const hugePadding = ' '.repeat(65 * 1024 * 1024)
  await bombWriter.add('new-world-backup.json', new TextReader(`{"format":"new-world-library-backup","version":1,${hugePadding.slice(0, 10)}}` + hugePadding), { level: 9 })
  await writeFile(inflatedBombPath, await bombWriter.close())
  await chooseBackup(page, inflatedBombPath)
  await expect(backupSection(page).getByRole('alert')).toHaveText('备份文件太大，无法打开。')
  await closeSettings(page)

  // Existing library must still be completely untouched
  await page.goto('/#/original')
  await page.getByRole('link', { name: '查看 安全书库', exact: true }).click()
  await expect(textArea(page)).toHaveText('炸弹文件不能擦掉原有内容。')
})

test('备份与恢复完整保留章节去重历史与灵感历史，并兼容旧版内联历史备份', async ({ page }, testInfo) => {
  await newNovel(page, '时光备份集', '当前正在连载的正文。')
  await keepIdea(page, '最新的灵感文本')

  // Seed a v7 deduplicated revision + idea revision in IndexedDB (gzip/json encoded)
  const seeded = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('new-world-library')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const books = await new Promise((r) => {
      const q = db.transaction('books').objectStore('books').getAll()
      q.onsuccess = () => r(q.result)
    })
    const editions = await new Promise((r) => {
      const q = db.transaction('editions').objectStore('editions').getAll()
      q.onsuccess = () => r(q.result)
    })
    const ideas = await new Promise((r) => {
      const q = db.transaction('ideas').objectStore('ideas').getAll()
      q.onsuccess = () => r(q.result)
    })
    const ed = editions[0]
    const chId = ed.chapters[0].id
    const revContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '被去重压缩保存的旧章节内容。' }] }] }
    const raw = new TextEncoder().encode(JSON.stringify(revContent))
    const blobHash = 'deadbeefcafebabe'
    const tx = db.transaction(['revisionBlobs', 'revisions', 'ideaRevisions'], 'readwrite', { durability: 'strict' })
    tx.objectStore('revisionBlobs').put({
      hash: blobHash,
      encoding: 'json',
      data: raw,
      rawBytes: raw.byteLength,
      storedBytes: raw.byteLength,
      createdAt: Date.now() - 20_000,
    })
    tx.objectStore('revisions').add({
      id: crypto.randomUUID(),
      library: ed.library,
      bookId: ed.bookId,
      editionId: ed.id,
      chapterId: chId,
      chapterTitle: '旧章节原名',
      contentHash: blobHash,
      blobHash,
      rawBytes: raw.byteLength,
      storedBytes: raw.byteLength,
      words: 13,
      source: 'ai',
      action: 'chapters.update',
      clientId: 'c1',
      clientName: 'TestAI',
      createdAt: Date.now() - 20_000,
    })
    tx.objectStore('ideaRevisions').add({
      id: crypto.randomUUID(),
      ideaId: ideas[0].id,
      text: '最早的灵感历史快照',
      createdAt: Date.now() - 20_000,
      source: 'ai',
      action: 'ideas.update',
      clientId: 'c1',
      clientName: 'TestAI',
    })
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    db.close()
    return { bookId: books[0].id, editionId: ed.id, chapterId: chId }
  })

  const v7Path = await backUp(page, testInfo, 'v7-history-backup.zip')
  const zipBytes = await readFile(v7Path)
  const reader = new ZipReader(new Uint8ArrayReader(zipBytes))
  const entry = (await reader.getEntries()).find((item) => item.filename === 'new-world-backup.json')
  const manifest = JSON.parse(await entry.getData(new TextWriter()))
  await reader.close()
  expect(manifest.revisionBlobs?.length).toBe(1)
  expect(manifest.revisions?.length).toBe(1)
  expect(manifest.ideaRevisions?.length).toBe(1)

  // Wipe existing data by deleting novel & idea, then restore v7 backup
  await page.goto('/#/original')
  await bookAction(page, '删除')
  await page.getByRole('button', { name: '确认删除' }).click()
  await chooseBackup(page, v7Path)
  await page.getByRole('dialog', { name: '从备份恢复' }).getByRole('button', { name: '替换当前书库' }).click()
  await expect(page.getByText('已从备份恢复 1 部作品。')).toBeVisible()

  // Verify chapter history from restored v7 blob works cleanly
  await page.goto(`/#/original/${seeded.bookId}/${seeded.editionId}`)
  await expect.poll(() => historyCount(page)).toBe('1')
  await editorAction(page, '历史版本')
  await expect(page.getByRole('dialog', { name: /历史版本/ }).locator('.revision-preview-text')).toHaveText('被去重压缩保存的旧章节内容。')
  await page.getByRole('dialog', { name: /历史版本/ }).getByRole('button', { name: '关闭' }).first().click()

  // Verify idea history restored cleanly
  await page.goto('/#/ideas')
  await expect(page.locator('.idea-history-button')).toContainText('1 个历史版本')
  await page.locator('.idea-history-button').click()
  await expect(page.getByRole('dialog', { name: /灵感历史版本/ })).toContainText('最早的灵感历史快照')
  await page.getByRole('dialog', { name: /灵感历史版本/ }).getByRole('button', { name: '关闭' }).first().click()

  // Simulate pre-v0.15.2 legacy backup (inline revisions without revisionBlobs/ideaRevisions)
  const legacyManifest = {
    ...manifest,
    revisions: [{
      id: 'legacy-rev-1',
      library: 'original',
      bookId: seeded.bookId,
      editionId: seeded.editionId,
      chapterId: seeded.chapterId,
      chapterTitle: '旧版第一章',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '来自旧版备份的内联正文。' }] }] },
      plainText: '来自旧版备份的内联正文。',
      contentHash: 'legacyhash1',
      words: 12,
      source: 'ai',
      action: 'chapters.update',
      createdAt: Date.now() - 40_000,
    }],
  }
  delete legacyManifest.revisionBlobs
  delete legacyManifest.ideaRevisions
  const legacyZipPath = testInfo.outputPath('legacy-backup.zip')
  const legacyWriter = new ZipWriter(new Uint8ArrayWriter())
  await legacyWriter.add('new-world-backup.json', new TextReader(JSON.stringify(legacyManifest)))
  await writeFile(legacyZipPath, await legacyWriter.close())

  await chooseBackup(page, legacyZipPath)
  await page.getByRole('dialog', { name: '从备份恢复' }).getByRole('button', { name: '替换当前书库' }).click()
  await expect(page.getByText('已从备份恢复 1 部作品。')).toBeVisible()

  await page.goto(`/#/original/${seeded.bookId}/${seeded.editionId}`)
  await editorAction(page, '历史版本')
  await expect(page.getByRole('dialog', { name: /历史版本/ }).locator('.revision-preview-text')).toHaveText('来自旧版备份的内联正文。')
})

test('全库备份与恢复包含 AI 防丢基线，并兼容不含基线的旧格式备份', async ({ page }, testInfo) => {
  await newNovel(page, '基线之书', '备份时的正文内容。')
  const seeded = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('new-world-library')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const editions = await new Promise((r) => {
      const q = db.transaction('editions').objectStore('editions').getAll()
      q.onsuccess = () => r(q.result)
    })
    const ed = editions[0]
    const chId = ed.chapters[0].id
    const revContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '基线对应的历史快照。' }] }] }
    const raw = new TextEncoder().encode(JSON.stringify(revContent))
    const blobHash = 'ba5e11ed0001'
    const baseline = {
      clientId: 'client-baseline-test',
      library: ed.library,
      bookId: ed.bookId,
      editionId: ed.id,
      chapterId: chId,
      peakWords: 1200,
      anchorWords: 980,
      anchorText: '锚点原文片段。',
      updatedAt: 1_760_000_000_000,
    }
    const tx = db.transaction(['revisionBlobs', 'revisions', 'aiBaselines'], 'readwrite', { durability: 'strict' })
    tx.objectStore('revisionBlobs').put({
      hash: blobHash,
      encoding: 'json',
      data: raw,
      rawBytes: raw.byteLength,
      storedBytes: raw.byteLength,
      createdAt: 1_760_000_000_000,
    })
    tx.objectStore('revisions').add({
      id: crypto.randomUUID(),
      library: ed.library,
      bookId: ed.bookId,
      editionId: ed.id,
      chapterId: chId,
      chapterTitle: '第一章',
      contentHash: blobHash,
      blobHash,
      rawBytes: raw.byteLength,
      storedBytes: raw.byteLength,
      words: 10,
      source: 'ai',
      action: 'chapters.update',
      clientId: baseline.clientId,
      clientName: 'BaselineAI',
      createdAt: 1_760_000_000_000,
    })
    tx.objectStore('aiBaselines').put(baseline)
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    db.close()
    return { bookId: ed.bookId, editionId: ed.id, chapterId: chId, baseline }
  })

  const v3Path = await backUp(page, testInfo, 'v3-baseline-backup.zip')
  const v3Zip = new ZipReader(new Uint8ArrayReader(await readFile(v3Path)))
  const v3Entries = []
  for (const entry of await v3Zip.getEntries()) {
    v3Entries.push([entry.filename, await entry.getData(new Uint8ArrayWriter())])
  }
  await v3Zip.close()
  const manifest = JSON.parse(Buffer.from(v3Entries.find(([name]) => name === 'new-world-backup.json')[1]).toString())
  expect(manifest.version).toBe(3)
  expect(manifest.aiBaselines).toEqual([seeded.baseline])

  // Overwrite local baseline & edit chapter so local state diverges from the backup.
  await page.goto(`/#/original/${seeded.bookId}/${seeded.editionId}`)
  await textArea(page).fill('本地被篡改后的正文。')
  await saveNow(page)
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await page.evaluate(async (baseline) => {
    const db = await new Promise((resolve) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => resolve(q.result)
    })
    const tx = db.transaction('aiBaselines', 'readwrite', { durability: 'strict' })
    tx.objectStore('aiBaselines').put({
      ...baseline,
      peakWords: 99999,
      anchorWords: 88888,
      anchorText: '不该留下来的本机旧基线。',
      updatedAt: 1_770_000_000_000,
    })
    await new Promise((r) => { tx.oncomplete = r })
    db.close()
  }, seeded.baseline)

  // Restore v3 backup: text, history, and baseline must all come back consistently.
  await chooseBackup(page, v3Path)
  await page.getByRole('dialog', { name: '从备份恢复' }).getByRole('button', { name: '替换当前书库' }).click()
  await expect(page.getByText('已从备份恢复 1 部作品。')).toBeVisible()

  await page.goto(`/#/original/${seeded.bookId}/${seeded.editionId}`)
  await expect(textArea(page)).toHaveText('备份时的正文内容。')
  await expect.poll(() => historyCount(page)).toBe('1')
  const restoredBaselines = await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => resolve(q.result)
    })
    const rows = await new Promise((r) => {
      const q = db.transaction('aiBaselines').objectStore('aiBaselines').getAll()
      q.onsuccess = () => r(q.result)
    })
    db.close()
    return rows
  })
  expect(restoredBaselines).toEqual([seeded.baseline])

  // Build a legacy v2 backup (without aiBaselines) and ensure local mismatched baselines are cleared, not inherited.
  const legacyV2 = { ...manifest, version: 2 }
  delete legacyV2.aiBaselines
  const v2Path = testInfo.outputPath('legacy-v2-backup.zip')
  const v2Writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const [name, bytes] of v3Entries) {
    await v2Writer.add(name, new Uint8ArrayReader(name === 'new-world-backup.json' ? Buffer.from(JSON.stringify(legacyV2)) : bytes))
  }
  await writeFile(v2Path, await v2Writer.close())

  // Inject a mismatched local baseline before restoring the v2 backup.
  await page.evaluate(async (baseline) => {
    const db = await new Promise((resolve) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => resolve(q.result)
    })
    const tx = db.transaction('aiBaselines', 'readwrite', { durability: 'strict' })
    tx.objectStore('aiBaselines').put({
      ...baseline,
      peakWords: 7777,
      anchorText: '本地残余基线绝不能套用。',
    })
    await new Promise((r) => { tx.oncomplete = r })
    db.close()
  }, seeded.baseline)

  await chooseBackup(page, v2Path)
  await page.getByRole('dialog', { name: '从备份恢复' }).getByRole('button', { name: '替换当前书库' }).click()
  await expect(page.getByText('已从备份恢复 1 部作品。')).toBeVisible()

  await page.goto(`/#/original/${seeded.bookId}/${seeded.editionId}`)
  await expect(textArea(page)).toHaveText('备份时的正文内容。')
  await expect.poll(() => historyCount(page)).toBe('1')
  const baselinesAfterLegacy = await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => resolve(q.result)
    })
    const rows = await new Promise((r) => {
      const q = db.transaction('aiBaselines').objectStore('aiBaselines').getAll()
      q.onsuccess = () => r(q.result)
    })
    db.close()
    return rows
  })
  expect(baselinesAfterLegacy).toEqual([])

  // Malformed v3 backup (missing aiBaselines) and future v4 backup are rejected cleanly.
  const brokenV3 = { ...manifest }
  delete brokenV3.aiBaselines
  const brokenV3Path = testInfo.outputPath('broken-v3-backup.zip')
  const brokenWriter = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const [name, bytes] of v3Entries) {
    await brokenWriter.add(name, new Uint8ArrayReader(name === 'new-world-backup.json' ? Buffer.from(JSON.stringify(brokenV3)) : bytes))
  }
  await writeFile(brokenV3Path, await brokenWriter.close())
  await chooseBackup(page, brokenV3Path)
  await expect(backupSection(page).getByRole('alert')).toHaveText('这不是 New World 备份文件，或文件已损坏。')
  await closeSettings(page)

  const futureV4 = { ...manifest, version: 4 }
  const futureV4Path = testInfo.outputPath('future-v4-backup.zip')
  const futureWriter = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const [name, bytes] of v3Entries) {
    await futureWriter.add(name, new Uint8ArrayReader(name === 'new-world-backup.json' ? Buffer.from(JSON.stringify(futureV4)) : bytes))
  }
  await writeFile(futureV4Path, await futureWriter.close())
  await chooseBackup(page, futureV4Path)
  await expect(backupSection(page).getByRole('alert')).toHaveText('这份备份来自更新版本的 New World，请先更新应用。')
})
