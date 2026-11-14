import { readFile, writeFile } from 'node:fs/promises'
import { TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { expect, test } from './app-test.mjs'
import { bookAction } from './fixtures.mjs'

const textArea = (page) => page.getByRole('textbox', { name: '章节正文' })
const settings = (page) => page.getByRole('dialog', { name: '设置' })
const backupSection = (page) => settings(page).getByRole('region', { name: '备份', exact: true })

async function newNovel(page, name, text) {
  await page.goto('/#/original')
  await page.getByRole('button', { name: '新建小说' }).click()
  await page.getByRole('textbox', { name: '作品名' }).fill(name)
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(textArea(page)).toBeVisible()
  await textArea(page).fill(text)
  await page.getByRole('button', { name: '手动保存' }).click()
  await expect(page.locator('.save-status')).toHaveText('已保存')
}

async function backUp(page, testInfo, name, password) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
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
  await settings(page).getByRole('button', { name: '关闭', exact: true }).click()
  return path
}

async function keepIdea(page, text) {
  await page.goto('/#/ideas')
  await page.getByRole('textbox', { name: '灵感' }).fill(text)
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('list', { name: '灵感列表' })).toContainText(text)
}

async function chooseBackup(page, path) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
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
  await expect(page.locator('.shelf-original .card-count')).toHaveText('0 部作品')
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
  await expect(page.locator('.shelf-original .card-count')).toHaveText('0 部作品')
  await page.goto('/#/archive')
  await page.getByRole('link', { name: '雾中灯塔' }).click()
  await expect(textArea(page)).toHaveText('The keeper climbed the stairs. 灯塔守望者。')
  await page.goto('/#/ideas')
  await expect(page.getByRole('list', { name: '灵感列表' }).locator('.idea-text')).toHaveText(['灯塔下埋着一封信'])
})

test('加密备份需要正确密码才能恢复，损坏的文件会被拒绝', async ({ page }, testInfo) => {
  await newNovel(page, '密封的信', '只有知道密码的人才能读到。')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await backupSection(page).getByRole('radio', { name: '用密码加密' }).check()
  await expect(backupSection(page).locator('.backup-state')).toHaveText('之后每次备份时会请你设置密码。')
  await settings(page).getByRole('button', { name: '关闭', exact: true }).click()

  // Mismatched passwords are caught before anything is written.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await backupSection(page).getByRole('button', { name: '立即备份' }).click()
  const ask = page.getByRole('dialog', { name: '为这份备份设置密码' })
  await ask.getByLabel('密码', { exact: true }).fill('lighthouse')
  await ask.getByLabel('再次输入密码').fill('lighthous')
  await ask.getByRole('button', { name: '设置密码' }).click()
  await expect(ask.getByRole('alert')).toHaveText('两次输入的密码不一致。')
  await ask.getByRole('button', { name: '取消' }).click()
  await settings(page).getByRole('button', { name: '关闭', exact: true }).click()

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
  await settings(page).getByRole('button', { name: '关闭', exact: true }).click()

  // 2. Deflated manifest exceeds maxBackupManifestBytes (64 MiB) while ZIP on disk is tiny
  const inflatedBombPath = testInfo.outputPath('manifest-bomb.zip')
  const bombWriter = new ZipWriter(new Uint8ArrayWriter())
  const hugePadding = ' '.repeat(65 * 1024 * 1024)
  await bombWriter.add('new-world-backup.json', new TextReader(`{"format":"new-world-library-backup","version":1,${hugePadding.slice(0, 10)}}` + hugePadding), { level: 9 })
  await writeFile(inflatedBombPath, await bombWriter.close())
  await chooseBackup(page, inflatedBombPath)
  await expect(backupSection(page).getByRole('alert')).toHaveText('备份文件太大，无法打开。')
  await settings(page).getByRole('button', { name: '关闭', exact: true }).click()

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
  await expect(page.locator('button.history-toggle .history-count')).toHaveText('1')
  await page.locator('button.history-toggle').click()
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
  await page.locator('button.history-toggle').click()
  await expect(page.getByRole('dialog', { name: /历史版本/ }).locator('.revision-preview-text')).toHaveText('来自旧版备份的内联正文。')
})
