import { expect, test } from './app-test.mjs'
import { annotationNovel, annotationRows, createAnnotation, readingBody, selectReading } from './annotation-helpers.mjs'

const note = '窗外的灯光暗了下来，远处有人缓缓走过。'

async function sourceGeometry(page) {
  return readingBody(page).evaluate((root) => {
    const range = document.createRange()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const rects = []
    const bounds = root.getBoundingClientRect()
    while (walker.nextNode()) {
      range.selectNodeContents(walker.currentNode)
      for (const r of range.getClientRects()) if (r.width > 0) rects.push([r.x - bounds.x, r.y - bounds.y, r.width, r.height])
    }
    return { height: bounds.height, text: root.textContent, rects }
  })
}

async function expectLightweight(page) {
  const markers = page.locator('.annotation-inline')
  await expect(markers.first()).toBeVisible()
  const state = await markers.evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node), preview = node.querySelector('.annotation-inline-preview'), box = node.getBoundingClientRect()
    const source = document.querySelector('.novel-body, .reading-text')
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT), range = document.createRange()
    let collision = false
    while (walker.nextNode()) {
      range.selectNodeContents(walker.currentNode)
      for (const r of range.getClientRects()) if (r.width > 0 && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top) collision = true
    }
    return { background: style.backgroundColor, image: style.backgroundImage, border: style.borderWidth, height: box.height,
      fontSize: parseFloat(style.fontSize), color: style.color, ellipsis: getComputedStyle(preview).textOverflow, collision,
      inSource: source.contains(node), previewBackground: getComputedStyle(preview).backgroundColor }
  }))
  for (const item of state) {
    expect(item.background).toBe('rgba(0, 0, 0, 0)')
    expect(item.previewBackground).toBe('rgba(0, 0, 0, 0)')
    expect(item.image).toBe('none')
    expect(item.border).toBe('0px')
    expect(item.height).toBeLessThanOrEqual(12)
    expect(item.fontSize).toBeLessThanOrEqual(12)
    expect(item.ellipsis).toBe('ellipsis')
    expect(item.collision).toBe(false)
    expect(item.inSource).toBe(false)
  }
  return state
}

test('行间预览不改变任何正文行、透明文字色与高亮色分别保存，弹层没有引文/标题/关闭按钮', async ({ page }, testInfo) => {
  await annotationNovel(page, (note.repeat(3) + '\n').repeat(3))
  await readingBody(page).evaluate((node) => node.scrollIntoView({ block: 'start' }))
  const before = await sourceGeometry(page)
  await selectReading(page, 1, 12)
  await createAnnotation(page, '伏笔：留意灯光', 'inline', '#59738c')
  const marker = page.locator('.annotation-inline')
  await expect(marker).toContainText('伏笔：留意灯光')
  expect(await sourceGeometry(page)).toEqual(before)
  expect((await expectLightweight(page))[0].color).toBe('rgb(89, 115, 140)')
  await marker.hover()
  const popup = page.locator('.annotation-popup')
  await expect(popup).toBeVisible()
  await expect(popup.locator('.annotation-text')).toHaveText('伏笔：留意灯光')
  await expect(popup.locator('blockquote, strong, h1, h2, .annotation-popup-head')).toHaveCount(0)
  await expect(popup.getByRole('button', { name: '关闭批注' })).toHaveCount(0)
  expect(await popup.textContent()).not.toContain('窗外')
  await popup.hover()
  await page.waitForTimeout(350)
  await expect(popup).toBeVisible()
  await popup.locator('.annotation-text').click()
  await page.mouse.move(5, 5)
  await page.waitForTimeout(350)
  await expect(popup).toHaveAttribute('data-pinned', 'true')
  await popup.getByRole('button', { name: '编辑批注' }).click()
  const editor = page.getByRole('dialog', { name: '编辑批注' })
  await expect(editor.locator('blockquote')).toHaveCount(0)
  await expect(editor.getByLabel('自定义文字颜色')).toHaveValue('#59738c')
  await editor.getByLabel('展示形式').selectOption('mark')
  await editor.getByLabel('自定义高亮颜色').fill('#ed9bb2')
  await editor.getByRole('button', { name: '保存批注' }).click()
  const saved = (await annotationRows(page))[0].readingAnnotations.items[0]
  expect(saved).toMatchObject({ inlineColor: '#59738c', color: '#ed9bb2' })
  await page.locator('.annotation-mark').first().click()
  await expect(popup.locator('.annotation-text')).toHaveText('伏笔：留意灯光')
  await expect(popup.locator('blockquote, strong, .annotation-popup-head')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('editor-highlight-preview.png') })
  await popup.getByRole('button', { name: '编辑批注' }).click()
  await editor.getByLabel('展示形式').selectOption('inline')
  await editor.getByRole('button', { name: '保存批注' }).click()
  await expectLightweight(page)
  expect(await sourceGeometry(page)).toEqual(before)
  await page.mouse.move(5, 5)
  await page.screenshot({ path: testInfo.outputPath('editor-inline-reading.png') })
  await marker.click()
  await page.screenshot({ path: testInfo.outputPath('editor-inline-pinned.png') })
  await page.mouse.click(5, 5)
  await expect(popup).toBeHidden()
  const url = page.url()
  await page.goto('/#/original')
  await expect(page.locator('.shelf-page h1')).toHaveText('写作')
  await page.goto(url)
  await page.getByRole('button', { name: '阅读模式' }).click()
  await readingBody(page).evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await expect(marker).toBeVisible()
  expect((await annotationRows(page))[0].readingAnnotations.items[0]).toEqual({ ...saved, display: 'inline' })
})

for (const descendingIds of [false, true]) test(`长批注窄窗口截断，同一行接近的选区合并标记但不丢失批注，紧凑行距不遮挡正文（ID${descendingIds ? '逆序' : '正序'}）`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await annotationNovel(page, note.repeat(15))
  await readingBody(page).evaluate((node) => node.scrollIntoView({ block: 'start' }))
  const before = await sourceGeometry(page)
  // Equal endpoints sort by ID, which can be opposite to annotation creation order.
  await page.evaluate((descending) => {
    const ids = ['00000000-0000-4000-8000-000000000001', 'ffffffff-ffff-4fff-8fff-ffffffffffff']
    if (descending) ids.reverse()
    const randomUUID = crypto.randomUUID.bind(crypto)
    crypto.randomUUID = () => ids.shift() ?? randomUUID()
  }, descendingIds)
  const firstNote = '长批注'.repeat(80), secondNote = '第二条也属于这里'
  await selectReading(page, 0, 9); await createAnnotation(page, firstNote, 'inline', '#75695c')
  await selectReading(page, 3, 9); await createAnnotation(page, secondNote, 'inline', '#567564')
  await expect(page.locator('.annotation-inline')).toHaveCount(1)
  const pieces = page.locator('.annotation-inline-piece')
  await expect(pieces).toHaveCount(2)
  await expect(pieces.filter({ hasText: firstNote })).toHaveCSS('color', 'rgb(117, 105, 92)')
  await expect(pieces.filter({ hasText: secondNote })).toHaveCSS('color', 'rgb(86, 117, 100)')
  const stored = (await annotationRows(page))[0].readingAnnotations.items
  expect(stored.find((item) => item.text === firstNote).inlineColor).toBe('#75695c')
  expect(stored.find((item) => item.text === secondNote).inlineColor).toBe('#567564')
  await expectLightweight(page)
  const preview = page.locator('.annotation-inline-preview')
  expect(await preview.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
  expect(await sourceGeometry(page)).toEqual(before)
  await page.locator('.annotation-inline').click()
  const popup = page.locator('.annotation-popup')
  await expect(popup.locator('.annotation-card')).toHaveCount(2)
  await expect(popup).toContainText('第二条也属于这里')
  await page.mouse.click(5, 5)
  await page.screenshot({ path: testInfo.outputPath('editor-inline-ellipsis.png') })
  await page.evaluate(() => document.documentElement.dataset.lineHeight = 'compact')
  await expectLightweight(page)
  await page.screenshot({ path: testInfo.outputPath('editor-inline-narrow.png') })
  await page.setViewportSize({ width: 320, height: 480 })
  await expectLightweight(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.locator('.annotation-inline').click()
  await expect(popup).toBeVisible()
  const box = await popup.boundingBox()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(320)
  await page.keyboard.press('Escape')
  await expect(popup).toBeHidden()
})

test('拖动全过程不出现工具栏，正反向/跨段选择释放后定位固定，键盘选择保持可用', async ({ page }) => {
  await annotationNovel(page, note + '\n' + note)
  await readingBody(page).evaluate((node) => window.scrollBy(0, node.getBoundingClientRect().top - 180))
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  const points = await readingBody(page).evaluate((root) => {
    const nodes = root.querySelectorAll('p')
    const point = (p, offset) => { const r = document.createRange(); r.setStart(p.firstChild, offset); r.setEnd(p.firstChild, offset + 1); const box = r.getBoundingClientRect(); return { x: box.left, y: box.top + box.height / 2 } }
    return { start: point(nodes[0], 2), end: point(nodes[1], 8) }
  })
  for (const reverse of [false, true]) {
    const from = reverse ? points.end : points.start, to = reverse ? points.start : points.end
    await page.mouse.move(from.x, from.y); await page.mouse.down()
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(from.x + (to.x - from.x) * i / 6, from.y + (to.y - from.y) * i / 6)
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
      await expect(page.locator('.annotation-selection')).toBeHidden()
    }
    await page.mouse.up()
    await expect(page.locator('.annotation-selection')).toBeVisible()
    const box = await page.locator('.annotation-selection').boundingBox()
    await page.mouse.move(3, 3)
    expect(await page.locator('.annotation-selection').boundingBox()).toEqual(box)
    await page.keyboard.press('Escape')
  }
  await readingBody(page).focus()
  await readingBody(page).evaluate((root) => {
    const range = document.createRange(); range.setStart(root.querySelector('p').firstChild, 0); range.collapse(true)
    getSelection().removeAllRanges(); getSelection().addRange(range)
  })
  await page.keyboard.down('Shift')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.annotation-selection')).toBeHidden()
  await page.keyboard.up('Shift')
  await expect(page.locator('.annotation-selection')).toBeVisible()
  await createAnnotation(page, '键盘选区的批注', 'inline')
  expect((await annotationRows(page))[0].readingAnnotations.items[0].anchor.quote.length).toBeGreaterThan(0)
})

test('v0.17.0 的旧行间批注无需重写即可轻量显示，ID、锚点与高亮配置保留', async ({ page }, testInfo) => {
  await annotationNovel(page, note.repeat(2))
  await selectReading(page, 0, 6); await createAnnotation(page, '旧版批注', 'inline')
  await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('new-world-library')
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction('chapters', 'readwrite'), records = tx.objectStore('chapters'), rows = records.getAll()
      rows.onsuccess = () => { const row = rows.result[0], item = row.readingAnnotations.items[0]; delete item.inlineColor; item.collapsed = false; item.color = '#123abc'; records.put(row) }
      tx.oncomplete = () => { db.close(); resolve() }
    }
  }))
  const legacy = (await annotationRows(page))[0].readingAnnotations
  await page.reload()
  await page.getByRole('button', { name: '阅读模式' }).click()
  await readingBody(page).evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await expectLightweight(page)
  expect((await annotationRows(page))[0].readingAnnotations).toEqual(legacy)
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
  await expectLightweight(page)
  await page.screenshot({ path: testInfo.outputPath('editor-inline-dark.png') })
  await page.locator('.annotation-inline').click()
  await page.locator('.annotation-popup').getByRole('button', { name: '编辑批注' }).click()
  await page.getByRole('dialog', { name: '编辑批注' }).getByLabel('批注内容').fill('兼容后编辑')
  await page.getByRole('button', { name: '保存批注' }).click()
  const changed = (await annotationRows(page))[0].readingAnnotations.items[0]
  expect(changed).toMatchObject({ id: legacy.items[0].id, anchor: legacy.items[0].anchor, color: '#123abc', collapsed: false })
  await page.locator('.annotation-inline').click()
  await page.locator('.annotation-popup').getByRole('button', { name: '删除批注' }).click()
  await page.getByRole('button', { name: '确认删除批注' }).click()
  await expect(page.locator('.annotation-inline')).toHaveCount(0)
})

test('批注不进入复制文本，滚动容器正确裁切标记且不关闭已固定浮层', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await annotationNovel(page, note + '\n' + note.repeat(40))
  await selectReading(page, 1, 8); await createAnnotation(page, '这条批注不应复制到正文', 'inline')
  await selectReading(page, 2, note.length + 8)
  await page.keyboard.press('Control+c')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(note.slice(2) + '\n' + note.slice(0, 8))
  await page.keyboard.press('Escape')
  const paper = page.locator('.editor-paper')
  await paper.evaluate((node) => { node.style.maxHeight = '230px'; node.style.overflowY = 'auto'; node.scrollIntoView({ block: 'center' }) })
  const marker = page.locator('.annotation-inline')
  await expect(marker).toBeVisible()
  await marker.click()
  await expect(page.locator('.annotation-popup')).toHaveAttribute('data-pinned', 'true')
  await paper.evaluate((node) => { node.scrollTop = 500 })
  await expect(marker).toBeHidden()
  await expect(page.locator('.annotation-popup')).toBeVisible()
  await paper.evaluate((node) => { node.scrollTop = 0 })
  await expect(marker).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(page.locator('.annotation-popup')).toBeHidden()
})
