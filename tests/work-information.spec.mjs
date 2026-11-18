import { startWork } from './navigation-helpers.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js'
import { test, expect as baseExpect, withoutRelease } from './app-test.mjs'
import { seedProject, databaseSnapshot, projectFixture } from './project-fixture.mjs'
import { pixel } from './fixtures.mjs'

const expect = baseExpect.configure({ timeout: 15000 })
test.setTimeout(90000)
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { window.showSaveFilePicker = undefined }) })
const importName = '导入', exportName = '导出 New_World 工程（.newworld）'
const infoDialog = page => page.getByRole('dialog', { name: '编辑作品信息', exact: true })
const editor = page => page.getByRole('textbox', { name: '章节正文', exact: true })
const values = { author: '无名 <作者>', subtitle: '第二次归航', synopsis: '简介第一段。\n第二行。\n\n简介第二段。', tags: ['奇幻', '海洋, 冒险'], status: 'serializing' }
async function fillInfo(dialog, metadata = values) {
  for (const [field, label] of [['author','作者'],['subtitle','副标题'],['synopsis','作品简介']]) await dialog.getByLabel(label, { exact: true }).fill(metadata[field] ?? '')
  await dialog.getByLabel('标签', { exact: true }).fill(metadata.tags?.join('\n') ?? '')
  await dialog.getByLabel('创作状态', { exact: true }).selectOption(metadata.status ?? '')
}
async function create(page, library, name, metadata) {
  await page.goto(`/#/${library}`)
  await startWork(page, library)
  const form = page.getByRole('dialog')
  await expect(form.getByLabel('作者', { exact: true })).toHaveValue('')
  await expect(form.getByLabel('创作状态', { exact: true })).toHaveValue('')
  await form.getByLabel('作品名', { exact: true }).fill(name)
  if (metadata) await fillInfo(form, metadata)
  await form.getByRole('button', { name: '创建小说', exact: true }).click()
  await expect(form).toBeHidden()
}
async function choose(page, path) {
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: importName, exact: true }).click(); await (await chooser).setFiles(path)
}
async function exportProject(page, path) {
  await page.locator('.book-card').filter({hasText: '雾港 ·'}).locator('.book-menu-toggle').click(); await page.getByRole('menuitem', { name: exportName, exact: true }).click()
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: '保存工程', exact: true }).click()
  await expect(page.getByRole('dialog', {name:exportName})).toBeHidden()
  await (await downloaded).saveAs(path)
}
async function unpack(path) {
  const zip = new ZipReader(new Uint8ArrayReader(await readFile(path)), { useWebWorkers: false }); const data = new Map()
  for (const entry of await zip.getEntries()) data.set(entry.filename, await entry.getData(new Uint8ArrayWriter()))
  await zip.close(); return data
}
async function mutateProject(path, target, mutate) {
  const entries = await unpack(path)
  const books = JSON.parse(Buffer.from(entries.get('books.json')).toString())
  const manifest = JSON.parse(Buffer.from(entries.get('manifest.json')).toString())
  mutate(books, manifest)
  const bytes = Buffer.from(JSON.stringify(books)); entries.set('books.json', bytes)
  Object.assign(manifest.resources.find(r => r.path === 'books.json'), { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 })
  for (const [name, bytes] of entries) await writer.add(name, new Uint8ArrayReader(bytes))
  await writeFile(target, await writer.close())
}
async function updateStoredMetadata(page, id, metadata) {
  await page.evaluate(async ({ id, metadata }) => {
    const db = await new Promise(r => { const q = indexedDB.open('new-world-library'); q.onsuccess = () => r(q.result) })
    const tx = db.transaction('books', 'readwrite'), store = tx.objectStore('books'), q = store.getAll()
    q.onsuccess = () => { const book = q.result.find(b => b.id === id); store.put({ ...book, metadata }) }
    await new Promise((r,j) => { tx.oncomplete = r; tx.onabort = () => j(tx.error) }); db.close()
  }, { id, metadata })
}

for (const library of ['original', 'reference']) test(`${library} 可选作品信息创建、修改、清空及刷新持久化`, async ({ page }) => {
  await create(page, library, '信息小说', values)
  await expect(page.getByRole('region', { name: '作品信息', exact: true })).toContainText(values.author)
  await page.reload()
  let book = (await page.evaluate(databaseSnapshot)).books[0]
  expect(book.metadata).toEqual(values)
  await page.getByRole('button', { name: '编辑作品信息', exact: true }).click()
  await infoDialog(page).getByLabel('作者', { exact: true }).fill('修改后的笔名')
  await infoDialog(page).getByRole('button', { name: '保存作品信息', exact: true }).click()
  await expect(infoDialog(page)).toBeHidden()
  await page.reload(); book = (await page.evaluate(databaseSnapshot)).books[0]
  expect(book.metadata.author).toBe('修改后的笔名'); expect(book.metadata.synopsis).toBe(values.synopsis)
  await page.getByRole('button', { name: '编辑作品信息', exact: true }).click()
  await fillInfo(infoDialog(page), {})
  await infoDialog(page).getByRole('button', { name: '保存作品信息', exact: true }).click()
  await expect(infoDialog(page)).toBeHidden(); await page.reload()
  book = (await page.evaluate(databaseSnapshot)).books[0]
  expect(book).not.toHaveProperty('metadata')
  expect(book.title).toBe('信息小说')
})

test('Schema 1 不补默认信息，编辑保留未知字段与未改动的 CRLF，跨窗口冲突拒绝覆盖', async ({ page }) => {
  await page.goto('/#/writing'); await choose(page, resolve('docs/examples/雾港.newworld'))
  const preview = page.getByRole('dialog', { name: '导入工程预览' }); await preview.getByRole('button', { name: '确认导入' }).click(); await expect(preview).toBeHidden()
  let snapshot = await page.evaluate(databaseSnapshot), book = snapshot.books[0]
  expect(book).not.toHaveProperty('metadata')
  const metadata = { author: '', synopsis: '原样\r\n\r\n换行', status: 'future-status', future: { id: book.id, active: true, absent: null } }
  await updateStoredMetadata(page, book.id, metadata)
  await page.reload(); await page.getByRole('button', { name: '编辑作品信息', exact: true }).click()
  await expect(infoDialog(page).getByLabel('创作状态', { exact: true })).toHaveValue('future-status')
  await infoDialog(page).getByLabel('作者', { exact: true }).fill('新作者')
  await infoDialog(page).getByRole('button', { name: '保存作品信息', exact: true }).click(); await expect(infoDialog(page)).toBeHidden()
  book = (await page.evaluate(databaseSnapshot)).books[0]
  expect(book.metadata).toEqual({ ...metadata, author: '新作者' })
  await page.getByRole('button', { name: '编辑作品信息', exact: true }).click()
  await updateStoredMetadata(page, book.id, { ...book.metadata, future: { concurrent: true } })
  await infoDialog(page).getByLabel('作者', { exact: true }).fill('过期表单')
  await infoDialog(page).getByRole('button', { name: '保存作品信息', exact: true }).click()
  await expect(infoDialog(page).getByRole('alert')).toContainText('其他窗口更新')
  expect((await page.evaluate(databaseSnapshot)).books[0].metadata).toEqual({ ...book.metadata, future: { concurrent: true } })
})

for (const library of ['original', 'reference']) test(`${library} Schema 3 完整往返及副本保留未知元数据，全部原文/历史/批注数据不变`, async ({ page, browser }, info) => {
  await page.goto('/#/writing'); await expect(page.getByRole('button', { name: importName })).toBeVisible()
  const seeded = await page.evaluate(seedProject, projectFixture(library, pixel.toString('base64')))
  const metadata = { ...values, language: 'zh-Hans', future: { id: seeded.root, bookId: seeded.first, code: '<script>window.pwned=true</script>', nested: [null, true, 5] } }
  await updateStoredMetadata(page, seeded.root, metadata)
  if (library === 'reference') await updateStoredMetadata(page, seeded.secondOriginal, { author: '原作者', extensions: { original: true } })
  const before = await page.evaluate(databaseSnapshot)
  await page.goto(`/#/${library}`)
  const path = info.outputPath('带作品信息.newworld'); await exportProject(page, path)
  expect(await page.evaluate(databaseSnapshot)).toEqual(before)
  const entries = await unpack(path); expect(JSON.parse(Buffer.from(entries.get('manifest.json')).toString()).schemaVersion).toBe(3)
  // Published Schema 2 sample stays immutable; Schema 3 task samples have a separate generator test.
  const context = await withoutRelease(await browser.newContext({ locale: 'zh-CN' }))
  const clean = await context.newPage(); await clean.addInitScript(() => { window.showSaveFilePicker = undefined })
  try {
    await clean.goto('/#/writing'); await choose(clean, path)
    const preview = clean.getByRole('dialog', { name: '导入工程预览' }); await expect(preview).toContainText('3 个章节')
    expect((await clean.evaluate(databaseSnapshot)).books).toEqual([])
    await preview.getByRole('button', { name: '确认导入' }).click(); await expect(preview).toBeHidden()
    const expected = structuredClone(before); const ids = new Set(expected.books.filter(b => b.library === library && (b.id === seeded.root || b.workId === seeded.root)).map(b => b.id))
    expected.books = expected.books.filter(b => ids.has(b.id)); expected.ideas = expected.ideas.filter(i => ids.has(i.bookId)); expected.trash = expected.trash.filter(t => ids.has(t.bookId)); expected.writingDays = []
    expect(await clean.evaluate(databaseSnapshot)).toEqual(expected)
    expect(await clean.evaluate(() => window.pwned)).toBeUndefined()
    await clean.goto(`/#/${library}`); const second = info.outputPath('再次导出.newworld'); await exportProject(clean, second)
    const again = await unpack(second); entries.delete('manifest.json'); again.delete('manifest.json'); expect([...again]).toEqual([...entries])
    await clean.goto('/#/writing'); await choose(clean, path); await clean.getByRole('dialog', { name: '导入工程预览' }).getByLabel('导入方式').selectOption('copy')
    await clean.getByRole('button', { name: '确认导入', exact: true }).click(); await expect(clean.getByRole('dialog', { name: '导入工程预览' })).toBeHidden()
    const copied = (await clean.evaluate(databaseSnapshot)).books.find(b => !b.workId && b.id !== seeded.root)
    expect(copied.metadata).toEqual(metadata); expect(copied.id).not.toBe(metadata.future.id)
    await clean.getByRole('button', { name: '编辑作品信息', exact: true }).click()
    await infoDialog(clean).getByLabel('作者', { exact: true }).fill('副本作者')
    await infoDialog(clean).getByRole('button', { name: '保存作品信息', exact: true }).click(); await expect(infoDialog(clean)).toBeHidden()
    expect((await clean.evaluate(databaseSnapshot)).books.find(b => b.id === copied.id).metadata.future).toEqual(metadata.future)
  } finally { await context.close() }
})

test('不安全/超限元数据、未知结构字段及未来 Schema 明确拒绝且不改变书库', async ({ page }, info) => {
  await create(page, 'original', '既有作品')
  await page.goto('/#/writing'); const before = await page.evaluate(databaseSnapshot)
  const cases = [
    ['type', b => { b[0].metadata = { author: [] } }],
    ['resource', b => { b[0].metadata = { extension: { $resource: 'assets/evil.bin' } } }],
    ['size', b => { b[0].metadata = { future: '汉'.repeat(44000) } }],
    ['depth', b => { let deep = {}; for (let i=0;i<15;i++) deep = { deep }; b[0].metadata = { future: deep } }],
    ['array', b => { b[0].metadata = { future: Array(257).fill(0) } }],
    ['structural', b => { b[0].unrecognizedStructuralField = { safeText: 'semantics unknown' } }],
    ['schema1-new-field', (b,m) => { b[0].metadata = values; m.schemaVersion = 1 }],
    ['future', (b,m) => { m.schemaVersion = 999 }],
  ]
  for (const [name, mutate] of cases) await test.step(name, async () => {
    const path = info.outputPath(name + '.newworld')
    await mutateProject(resolve('docs/examples/雾港.newworld'), path, (b,m) => { m.schemaVersion=2; mutate(b,m) })
    await page.locator('.undo-toast').evaluateAll(nodes=>nodes.forEach(n=>n.remove()))
    await choose(page, path); await expect(page.locator('.undo-toast')).toContainText(/作品信息|不支持/)
    await expect(page.getByRole('dialog', { name: '导入工程预览' })).toHaveCount(0)
    expect(await page.evaluate(databaseSnapshot)).toEqual(before)
  })
})

test('正文五种格式的信息选项默认关闭，可选择标题副标题、作者与多段简介', async ({ page }, info) => {
  await create(page, 'original', '元数据导出书', { ...values, author: 'Export Author', synopsis: 'Intro one.\nLine two.\n\nIntro three.' })
  await editor(page).fill('BODY ONLY CONTENT.'); await page.keyboard.press('Control+s'); await expect(page.locator('.save-status')).toHaveText('已保存')
  async function exportAs(format, selected) {
    await page.getByRole('button', { name: '导出', exact: true }).click()
    const form = page.getByRole('dialog', { name: '导出编辑稿' })
    for (const label of ['作品标题及副标题','作者','作品简介']) await expect(form.getByRole('checkbox', { name: label, exact: true })).not.toBeChecked()
    await form.getByRole('radio', { name: format, exact: true }).check()
    for (const label of selected) await form.getByRole('checkbox', { name: label, exact: true }).check()
    const download = page.waitForEvent('download'); await form.getByRole('button', { name: '开始导出', exact: true }).click()
    const path = info.outputPath(format + '-' + selected.length); await (await download).saveAs(path); return readFile(path)
  }
  const plain = (await exportAs('TXT', [])).toString('utf8')
  expect(plain).toContain('BODY ONLY CONTENT.'); expect(plain).not.toContain('元数据导出书'); expect(plain).not.toContain('Export Author'); expect(plain).not.toContain('Intro one.')
  const title = (await exportAs('TXT', ['作品标题及副标题'])).toString('utf8')
  expect(title).toContain('元数据导出书'); expect(title).toContain(values.subtitle); expect(title).not.toContain('Export Author')
  const selected = ['作品标题及副标题','作者','作品简介']
  const markdown = (await exportAs('Markdown', selected)).toString('utf8'); expect(markdown).toContain('Export Author'); expect(markdown).toMatch(/Intro one\. {2}\nLine two\./)
  const html = (await exportAs('HTML', selected)).toString('utf8'); expect(html).toContain('class="export-work-info"'); expect(html).toContain('Export Author'); expect(html).toContain('Intro one.<br>Line two.<br><br>Intro three.')
  const docx = await exportAs('DOCX', selected); const zip = new ZipReader(new Uint8ArrayReader(docx)); const entries = await zip.getEntries()
  const xml = Buffer.from(await entries.find(e=>e.filename==='word/document.xml').getData(new Uint8ArrayWriter())).toString()
  expect(xml.indexOf('Export Author')).toBeLessThan(xml.indexOf('BODY ONLY CONTENT.')); expect((xml.match(/<w:sectPr/g)??[]).length).toBe(2)
  const core = Buffer.from(await entries.find(e=>e.filename==='docProps/core.xml').getData(new Uint8ArrayWriter())).toString(); expect(core).toContain('Export Author'); await zip.close()
  await page.evaluate(() => { window.newWorldDesktop = { savePdf: async () => { window.printedWork = document.querySelector('.print-edition').innerHTML } } })
  await page.getByRole('button', { name: '导出', exact: true }).click(); const form=page.getByRole('dialog',{name:'导出编辑稿'})
  await form.getByRole('radio',{name:'PDF',exact:true}).check(); for (const label of selected) await form.getByRole('checkbox',{name:label,exact:true}).check()
  await form.getByRole('button',{name:'开始导出',exact:true}).click(); await expect(form).toBeHidden()
  const printed = await page.evaluate(()=>window.printedWork); expect(printed).toContain('export-work-info'); expect(printed).toContain('Intro three.'); expect(printed).toContain('BODY ONLY CONTENT.')
})

test('移除及恢复续写工程首个原文件不丢失或回写旧作品信息', async ({ page }) => {
  await page.goto('/#/writing'); await expect(page.getByRole('button',{name:importName})).toBeVisible()
  const seeded = await page.evaluate(seedProject, projectFixture('reference', pixel.toString('base64')))
  await updateStoredMetadata(page, seeded.root, values)
  await page.goto(`/#/reference/${seeded.root}`)
  const row = page.locator('.book-row').filter({hasText:'雾港 · 续写验收'})
  await row.getByRole('button',{name:'移除原文',exact:true}).click()
  await page.getByRole('button',{name:'确认移除原文',exact:true}).click()
  await expect.poll(async()=> (await page.evaluate(databaseSnapshot)).books.find(b=>b.id===seeded.root).format).toBe('draft')
  let book=(await page.evaluate(databaseSnapshot)).books.find(b=>b.id===seeded.root)
  expect(book.metadata).toEqual(values); expect(book.cover).toBeTruthy()
  await page.getByRole('button',{name:'编辑作品信息',exact:true}).click(); await infoDialog(page).getByLabel('作者',{exact:true}).fill('移除后修改的作者')
  await infoDialog(page).getByRole('button',{name:'保存作品信息',exact:true}).click(); await expect(infoDialog(page)).toBeHidden()
  await page.goto('/#/trash'); await page.getByRole('listitem').filter({hasText:'原文「雾港」.md'}).getByRole('button',{name:'恢复',exact:true}).click()
  await expect.poll(async()=> (await page.evaluate(databaseSnapshot)).books.find(b=>b.id===seeded.root).format).toBe('md')
  book=(await page.evaluate(databaseSnapshot)).books.find(b=>b.id===seeded.root); expect(book.metadata.author).toBe('移除后修改的作者'); expect(book.metadata.synopsis).toBe(values.synopsis)
})
