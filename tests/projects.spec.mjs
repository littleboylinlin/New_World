import { createLegacyDatabase } from './legacy-database.mjs'
import { readFile, writeFile, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js'
import { test, expect as baseExpect, withoutRelease } from './app-test.mjs'
import { pixel } from './fixtures.mjs'
import { seedProject, databaseSnapshot, projectFixture } from './project-fixture.mjs'
import { editorAction } from './editor-helpers.mjs'

const expect = baseExpect.configure({ timeout: 15_000 })
test.setTimeout(90_000)

test.beforeEach(async ({ page }) => { await page.addInitScript(() => { window.showSaveFilePicker = undefined }) })

const importLabel = '导入'
const exportLabel = '导出 New_World 工程（.newworld）'
const dialog = (page) => page.getByRole('dialog', { name: '导入工程预览' })
async function choose(page, path) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: importLabel }).click()
  await (await chooser).setFiles(path)
}
async function exportWork(page, info, title, path) {
  await page.locator('.book-menu-toggle').first().click()
  await page.getByRole('menuitem', { name: exportLabel }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('dialog', { name: exportLabel }).getByRole('button', { name: '保存工程' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe(`${title}.newworld`)
  await file.saveAs(path)
  await expect(page.getByRole('dialog', { name: exportLabel })).toBeHidden()
}
async function unpack(path) {
  const zip = new ZipReader(new Uint8ArrayReader(await readFile(path)), { useWebWorkers: false })
  const out = new Map()
  for (const entry of await zip.getEntries()) out.set(entry.filename, await entry.getData(new Uint8ArrayWriter()))
  await zip.close()
  return out
}
async function repack(entries, path) {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const [name, bytes] of entries) await zip.add(name, new Uint8ArrayReader(bytes), { level: 0 })
  await writeFile(path, await zip.close())
}
function changeJson(entries, name, mutate) {
  const json = JSON.parse(Buffer.from(entries.get(name)).toString())
  mutate(json)
  const bytes = Buffer.from(JSON.stringify(json))
  entries.set(name, bytes)
  if (name !== 'manifest.json') {
    const manifest = JSON.parse(Buffer.from(entries.get('manifest.json')).toString())
    const r = manifest.resources.find((r) => r.path === name)
    r.bytes = bytes.length; r.sha256 = createHash('sha256').update(bytes).digest('hex')
    entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  }
}
async function freshPage(browser) {
  const context = await withoutRelease(await browser.newContext({ locale: 'zh-CN' }))
  const page = await context.newPage(); await page.addInitScript(() => { window.showSaveFilePicker = undefined }); await page.goto('/#/writing')
  await expect(page.getByRole('button', { name: importLabel })).toBeVisible()
  return { context, page }
}

for (const library of ['original', 'reference']) test(`${library} 工程跨干净书库往返，保留原字节、关系、历史及可编辑性`, async ({ page, browser }, info) => {
  await page.goto('/#/writing')
  await expect(page.getByRole('button', { name: importLabel })).toBeVisible()
  const seeded = await page.evaluate(seedProject, projectFixture(library, pixel.toString('base64')))
  const before = await page.evaluate(databaseSnapshot)
  await page.goto(`/#/${library}`)
  // Only the current work's card is exported, excluding the unrelated sentinel.
  const cards = page.locator('.book-card').filter({ hasText: '雾港 ·' })
  await cards.locator('.book-menu-toggle').click()
  await page.getByRole('menuitem', { name: exportLabel }).click()
  const path = info.outputPath('完整工程.newworld')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存工程', exact: true }).click()
  await expect(page.getByRole('dialog', { name: exportLabel })).toBeHidden({ timeout: 5000 })
  await (await download).saveAs(path)
  expect(await page.evaluate(databaseSnapshot)).toEqual(before)
  const packed = await unpack(path)
  const manifest = JSON.parse(Buffer.from(packed.get('manifest.json')).toString())
  expect(manifest.schemaVersion).toBe(5)
  expect(manifest.appVersion).not.toBe(manifest.schemaVersion)
  expect(manifest.detached.editions).toContain(seeded.missingEdition)
  for (const r of manifest.resources) expect(createHash('sha256').update(packed.get(r.path)).digest('hex')).toBe(r.sha256)
  const strings = [...packed.values()].map((b) => Buffer.from(b).toString()).join('')
  expect(strings).not.toContain('无关作品'); expect(strings).not.toContain('无关全局灵感'); expect(strings).not.toContain('should-not-export')
  // The published Schema 1 fixture is kept for backwards compatibility.
  const clean = await freshPage(browser)
  try {
    await clean.page.locator('[data-filter="' + (library === 'original' ? 'reference' : 'original') + '"]').click()
    await choose(clean.page, path)
    await expect(clean.page.locator('.type-options')).toHaveCount(0)
    await expect(dialog(clean.page)).toContainText('3 个章节 · 2 个编辑版本')
    expect((await clean.page.evaluate(databaseSnapshot)).books).toEqual([]) // preview has no writes
    await dialog(clean.page).getByRole('button', { name: '确认导入' }).click()
    await expect(dialog(clean.page)).toBeHidden()
    const restored = await clean.page.evaluate(databaseSnapshot)
    const root = { library, id: seeded.root }
    const expected = structuredClone(before)
    expected.books = expected.books.filter((b) => b.library === library && (b.id === seeded.root || b.workId === seeded.root))
    const ownedIds = new Set(expected.books.map((b) => b.id))
    expected.ideas = expected.ideas.filter((b) => b.library === library && ownedIds.has(b.bookId))
    expected.trash = expected.trash.filter((b) => b.library === library && ownedIds.has(b.bookId))
    expected.writingDays = []
    expect(restored).toEqual(expected)
    await clean.page.goto(`/#/${library}`)
    const secondPath = info.outputPath('再次导出.newworld')
    await exportWork(clean.page, info, library === 'original' ? '雾港 · 原创验收' : '雾港 · 续写验收', secondPath)
    const again = await unpack(secondPath)
    // ZIP timestamps and manifest creation time may differ; every logical record/resource is exact.
    packed.delete('manifest.json'); again.delete('manifest.json')
    expect([...again]).toEqual([...packed])
    if (library === 'original') {
      await clean.page.goto(`/#/original/${seeded.root}`)
      await expect(clean.page.locator('.annotation-mark')).toContainText('雾中')
    }
    await clean.page.goto(`/#/${library}/${seeded.root}/${seeded.firstEdition}`)
    await expect(clean.page.getByRole('textbox', { name: '章节正文', exact: true })).toContainText('灯塔亮了。')
    await editorAction(clean.page, '阅读模式')
    await expect(clean.page.locator('.annotation-inline')).toContainText('开篇的地点')
    await editorAction(clean.page, '编辑正文')
    await editorAction(clean.page, '历史版本')
    await expect(clean.page.locator('.revision-preview-text')).toHaveText('旧稿中的灯塔。')
    await clean.page.getByRole('button', { name: '恢复此版本', exact: true }).click()
    await expect(clean.page.getByRole('textbox', { name: '章节正文', exact: true })).toContainText('旧稿中的灯塔。')
    await clean.page.getByRole('textbox', { name: '章节正文', exact: true }).fill('导入后继续编辑。')
    await clean.page.keyboard.press('Control+s')
    await expect(clean.page.locator('.save-status')).toHaveText('已保存')
    await clean.page.reload()
    await expect(clean.page.getByRole('textbox', { name: '章节正文', exact: true })).toHaveText('导入后继续编辑。')
    const manuscript = clean.page.waitForEvent('download')
    await editorAction(clean.page, '导出')
    await clean.page.getByRole('button', { name: '开始导出', exact: true }).click()
    const textPath = info.outputPath('导入后正文.txt')
    await (await manuscript).saveAs(textPath)
    expect(await readFile(textPath, 'utf8')).toContain('导入后继续编辑。')
    await clean.page.goto('/#/trash')
    const deleted = clean.page.getByRole('listitem').filter({ hasText: '删去的章节' })
    await deleted.getByRole('button', { name: '恢复', exact: true }).click()
    await clean.page.goto(`/#/${library}/${seeded.root}/${seeded.firstEdition}`)
    await expect(clean.page.locator('.chapter-list')).toContainText('删去的章节')
    await clean.page.goto('/#/ideas')
    await clean.page.locator('.idea-row').filter({ hasText: '归航者带回一封信' }).locator('.idea-history-button').click()
    await expect(clean.page.getByRole('dialog', { name: /灵感历史版本/ })).toContainText('旧的灵感')
    await clean.page.getByRole('button', { name: '恢复此版本', exact: true }).click()
    await expect(clean.page.locator('.idea-text').filter({ hasText: /^旧的灵感$/ })).toBeVisible()
    if (library === 'reference') {
      await clean.page.locator('.idea-row').filter({ hasText: '原文旁的灵感' }).locator('.idea-history-button').click()
      await expect(clean.page.getByRole('dialog', { name: /灵感历史版本/ })).toContainText('原文旁的旧灵感')
      await clean.page.getByRole('button', { name: '恢复此版本', exact: true }).click()
      await expect(clean.page.locator('.idea-text').filter({ hasText: /^原文旁的旧灵感$/ })).toBeVisible()
      const notes = (await clean.page.evaluate(databaseSnapshot)).ideas
      expect(notes.find((v) => v.text === '原文旁的旧灵感').bookId).toBe(seeded.secondOriginal)
      await clean.page.goto('/#/trash')
      await clean.page.getByRole('listitem').filter({ hasText: '已删除的原文灵感' }).getByRole('button', { name: '恢复', exact: true }).click()
      await expect.poll(async () => (await clean.page.evaluate(databaseSnapshot)).ideas.find((v) => v.text === '已删除的原文灵感')?.bookId).toBe(seeded.secondOriginal)
    }
  } finally { await clean.context.close() }
})

test('重复导入可跳过或创建独立副本，原文件可重复且所有内部引用随 ID 迁移', async ({ page }, info) => {
  await page.goto('/#/writing'); await expect(page.getByRole('button', { name: importLabel })).toBeVisible()
  await choose(page, resolve('docs/examples/雾港.newworld'))
  await dialog(page).getByRole('button', { name: '确认导入' }).click(); await expect(dialog(page)).toBeHidden()
  await page.goto('/#/writing')
  const before = await page.evaluate(databaseSnapshot)
  await choose(page, resolve('docs/examples/雾港.newworld'))
  await expect(dialog(page)).toContainText('ID 冲突')
  await expect(dialog(page).getByRole('option', { name: '保留稳定 ID 导入' })).toHaveCount(0)
  await dialog(page).getByLabel('导入方式').selectOption('skip')
  await dialog(page).getByRole('button', { name: '确认导入' }).click(); await expect(dialog(page)).toBeHidden()
  expect(await page.evaluate(databaseSnapshot)).toEqual(before)
  await choose(page, resolve('docs/examples/雾港.newworld'))
  await dialog(page).getByRole('button', { name: '确认导入' }).click(); await expect(dialog(page)).toBeHidden()
  const after = await page.evaluate(databaseSnapshot)
  expect(after.books).toHaveLength(2); expect(after.files).toHaveLength(2); expect(after.revisionBlobs).toHaveLength(1)
  const copied = after.books.find((b) => b.id !== before.books[0].id)
  const editions = after.editions.filter((e) => e.bookId === copied.id)
  expect(editions).toHaveLength(2)
  expect(editions.find((e) => e.source === 'copy').copiedFrom).toBe(editions.find((e) => e.source === 'original').id)
  for (const e of editions) {
    expect(e.originalId).toBe(copied.id)
    for (const c of e.chapters) expect(after.chapters.some((row) => row.bookId === copied.id && row.editionId === e.id && row.id === c.id)).toBe(true)
  }
  const idea = after.ideas.find((v) => v.bookId === copied.id)
  expect(after.ideaRevisions.some((r) => r.ideaId === idea.id)).toBe(true)
  // Local copies own the same immutable source bytes but no edition/book keys collide.
  expect(after.books[0].digest).toBe(after.books[1].digest)
  expect(new Set(after.editions.map((v) => v.id)).size).toBe(4)
})

test('损坏、路径攻击、错误版本、缺失/危险资源及异常 ZIP 均不写库，写入故障整体回滚', async ({ page }, info) => {
  await page.goto('/#/writing'); await expect(page.getByRole('button', { name: importLabel })).toBeVisible()
  const before = await page.evaluate(databaseSnapshot)
  const original = await unpack(resolve('docs/examples/雾港.newworld'))
  const cases = [
    ['checksum', (e) => { const name = [...e.keys()].find((n) => n.startsWith('originals/') && n.endsWith('.bin')); e.set(name, Buffer.from('changed')) }],
    ['missing', (e) => e.delete('chapters/index.json')],
    ['version', (e) => changeJson(e, 'manifest.json', (v) => { v.schemaVersion = 999 })],
    ['type', (e) => changeJson(e, 'editions/index.json', (v) => { v[0].revision = 'bad' })],
    ['reference', (e) => changeJson(e, 'editions/index.json', (v) => { v[0].chapters[0].id = 'missing' })],
    ['attribute-type', (e) => changeJson(e, 'chapters/index.json', (v) => { v.find((c) => c.content.content.some((n) => n.type === 'image')).content.content.find((n) => n.type === 'image').attrs.width = { unsafe: 'value' } })],
    ['nested-gzip', (e) => changeJson(e, 'revisions/blobs.json', (v) => { v[0].rawBytes = 200 * 1024 * 1024 })],
    ['script', (e) => changeJson(e, 'chapters/index.json', (v) => { v[0].content.content.push({ type: 'image', attrs: { src: 'javascript:alert(1)' } }) })],
    ['path', (e) => e.set('../evil.js', Buffer.from('alert(1)'))],
    ['absolute', (e) => e.set('/tmp/evil', Buffer.from('x'))],
    ['extra', (e) => e.set('evil.js', Buffer.from('x'))],
  ]
  for (const [name, mutate] of cases) await test.step(name, async () => {
    const entries = new Map(original); mutate(entries)
    const path = info.outputPath(`${name}.newworld`); await repack(entries, path)
    await page.locator('.undo-toast').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
    await choose(page, path)
    await expect(page.getByRole('status').filter({ hasText: /工程/ }).last()).toBeVisible()
    await expect(dialog(page)).toHaveCount(0)
    expect(await page.evaluate(databaseSnapshot)).toEqual(before)
  })
  // Misleading huge central size is rejected before inflating; physical file is small.
  const bomb = Buffer.from(await readFile(resolve('docs/examples/雾港.newworld')))
  const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); bomb.writeUInt32LE(200 * 1024 * 1024, central + 24)
  const bombPath = info.outputPath('oversize.newworld'); await writeFile(bombPath, bomb)
  await page.locator('.undo-toast').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  await choose(page, bombPath); await expect(page.locator('.undo-toast')).toBeVisible(); await expect(dialog(page)).toHaveCount(0)
  const hugePath = info.outputPath('513MiB.newworld')
  const huge = await open(hugePath, 'w'); await huge.truncate(513 * 1024 * 1024); await huge.close()
  await page.locator('.undo-toast').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  await choose(page, hugePath)
  await expect(page.locator('.undo-toast')).toContainText('超过安全限制')
  expect(await page.evaluate(databaseSnapshot)).toEqual(before)
  await choose(page, resolve('docs/examples/雾港.newworld')); await expect(dialog(page)).toBeVisible()
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'trash') throw new DOMException('Test quota failure', 'QuotaExceededError')
      return add.apply(this, args)
    }
    window.restoreProjectAdd = () => { IDBObjectStore.prototype.add = add }
  })
  await dialog(page).getByRole('button', { name: '确认导入' }).click()
  await expect(dialog(page).getByRole('alert')).toBeVisible()
  expect(await page.evaluate(databaseSnapshot)).toEqual(before)
  await page.evaluate(() => window.restoreProjectAdd())
  await dialog(page).getByRole('button', { name: '确认导入' }).click()
  await expect(dialog(page)).toBeHidden()
  expect((await page.evaluate(databaseSnapshot)).books).toHaveLength(1)
})


test('预览后出现 ID 冲突时原子拒绝，重新选择副本后可以导入', async ({ page }) => {
  await page.goto('/#/writing'); await expect(page.getByRole('button', { name: importLabel })).toBeVisible()
  await choose(page, resolve('docs/examples/雾港.newworld')); await expect(dialog(page)).toBeVisible()
  await page.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open('new-world-library'); q.onsuccess = () => r(q.result) })
    const tx = db.transaction('books', 'readwrite')
    // Title conflict is also rechecked inside the write transaction.
    tx.objectStore('books').add({ library: 'original', id: crypto.randomUUID(), title: '雾港 · 原创验收', format: 'draft', importedAt: Date.now() })
    await new Promise((r) => { tx.oncomplete = r }); db.close()
  })
  const before = await page.evaluate(databaseSnapshot)
  await dialog(page).getByRole('button', { name: '确认导入' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('本地数据发生冲突')
  expect(await page.evaluate(databaseSnapshot)).toEqual(before)
  await dialog(page).getByLabel('导入方式').selectOption('copy')
  await dialog(page).getByRole('button', { name: '确认导入' }).click()
  await expect(dialog(page)).toBeHidden()
  expect((await page.evaluate(databaseSnapshot)).books).toHaveLength(2)
})


test('ZIP 重复路径、异常压缩率和超过 10000 条目被拒绝', async ({ page }, info) => {
  await page.goto('/#/writing'); await expect(page.getByRole('button', { name: importLabel })).toBeVisible()
  const before = await page.evaluate(databaseSnapshot)
  const entries = await unpack(resolve('docs/examples/雾港.newworld'))
  entries.set('qqqqq.json', Buffer.from('[]'))
  const duplicated = info.outputPath('duplicate.newworld'); await repack(entries, duplicated)
  const bytes = Buffer.from(await readFile(duplicated))
  const marker = Buffer.from('qqqqq.json')
  let offset = 0
  while ((offset = bytes.indexOf(marker, offset)) >= 0) { bytes.set(Buffer.from('books.json'), offset); offset += marker.length }
  await writeFile(duplicated, bytes)
  await choose(page, duplicated); await expect(page.locator('.undo-toast')).toContainText('无效')
  await page.locator('.undo-toast').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  const bomb = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  await bomb.add('manifest.json', new Uint8ArrayReader(Buffer.alloc(2 * 1024 * 1024, 32)), { level: 9 })
  const bombPath = info.outputPath('ratio.newworld'); await writeFile(bombPath, await bomb.close())
  await choose(page, bombPath); await expect(page.locator('.undo-toast')).toContainText('超过安全限制')
  await page.locator('.undo-toast').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  const many = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 })
  for (let i = 0; i < 10001; i++) await many.add(`files/${i}.bin`, new Uint8ArrayReader(Buffer.from('x')))
  const manyPath = info.outputPath('many.newworld'); await writeFile(manyPath, await many.close())
  await choose(page, manyPath); await expect(page.locator('.undo-toast')).toContainText('超过安全限制')
  expect(await page.evaluate(databaseSnapshot)).toEqual(before)
})

test('现有 v7 书库升级到最新版本后完整保留数据和索引主键', async ({ page }) => {
  await page.goto('/appearance.js')
  await page.evaluate(createLegacyDatabase, 7)
  const seeded = await page.evaluate(seedProject, projectFixture('reference', pixel.toString('base64')))
  const before = await page.evaluate(databaseSnapshot)
  await page.goto('/#/writing')
  await expect(page.getByRole('button', { name: importLabel })).toBeVisible()
  await expect(page.getByRole('link', { name: '回收站', exact: true })).not.toHaveAttribute('aria-describedby')
  const version = await page.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open('new-world-library'); q.onsuccess = () => r(q.result) })
    const books = db.transaction('books').objectStore('books')
    const result = { version: db.version, unique: books.index('byLibraryDigest').unique, keyPath: books.keyPath }; db.close(); return result
  })
  expect(version).toEqual({ version: 15, unique: false, keyPath: ['library', 'id'] })
  for (const name of ['tasks','taskProjects','taskSections','taskLabels','taskCompletions','taskSettings','taskFilters','taskTemplates','taskAttachments','writingStyles','storyBoards','bookChats','foreshadowing']) before[name] = []
  expect(await page.evaluate(databaseSnapshot)).toEqual(before)
  await page.goto(`/#/reference/${seeded.root}/${seeded.firstEdition}`)
  await expect(page.getByRole('textbox', { name: '章节正文', exact: true })).toContainText('灯塔亮了。')
})

test('续写副本同步映射附属原文关联的灵感、历史与回收记录', async ({ page }, info) => {
  await page.goto('/#/writing'); await expect(page.getByRole('button', { name: importLabel })).toBeVisible()
  const seeded = await page.evaluate(seedProject, projectFixture('reference', pixel.toString('base64')))
  await page.goto('/#/reference')
  const path = info.outputPath('原文灵感工程.newworld')
  await exportWork(page, info, '雾港 · 续写验收', path)
  await page.goto('/#/writing')
  await choose(page, path)
  await expect(dialog(page)).toContainText('ID 冲突')
  await dialog(page).getByLabel('导入方式').selectOption('copy')
  await dialog(page).getByRole('button', { name: '确认导入' }).click()
  await expect(dialog(page)).toBeHidden()
  const data = await page.evaluate(databaseSnapshot)
  const root = data.books.find((b) => b.library === 'reference' && !b.workId && b.id !== seeded.root)
  const source = data.books.find((b) => b.workId === root.id)
  expect(source.id).not.toBe(seeded.secondOriginal)
  const note = data.ideas.find((v) => v.bookId === source.id && v.text === '原文旁的灵感')
  expect(note).toBeTruthy()
  expect(data.ideaRevisions.find((v) => v.ideaId === note.id).bookId).toBe(source.id)
  expect(data.trash.find((v) => v.kind === 'idea' && v.bookId === source.id).ideas[0].bookId).toBe(source.id)
  expect(data.editions.find((e) => e.bookId === root.id && e.source === 'copy').originalId).toBe(source.id)
  // Re-export of the copy validates recalculated historical owner hashes and the complete closure.
  await page.getByRole('button', { name: exportLabel }).click()
  const copied = page.waitForEvent('download')
  await page.getByRole('button', { name: '保存工程', exact: true }).click()
  await (await copied).saveAs(info.outputPath('原文灵感副本.newworld'))
})
