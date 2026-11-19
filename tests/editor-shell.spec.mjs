import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, test } from './app-test.mjs'
import { chapterText, newWritingNovel } from './writing-motion-helpers.mjs'
import { chapterHeading, chapterItem, chapterTitles, editorAction, openSidePanel } from './editor-helpers.mjs'

const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const toolbar = (page) => page.locator('.editor-toolbar')
const pane = (page) => page.locator('.editor-scroll')
const floating = (page) => page.locator('.selection-toolbar')
const aaPanel = (page) => page.getByRole('group', { name: '外观', exact: true })

/** Replaces the new work's chapters with the given ones, then reloads the editor. */
async function seedChapters(page, entries, title = '外壳样书') {
  await page.goto('/')
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
}

const longChapter = (word, count = 80) => Array.from({ length: count }, (_, i) => paragraph(`${word}第 ${i + 1} 段，海风从石墙上吹过。`))

/** The element is inside what is really visible, and a tap at its centre lands on it. */
function reachable(locator) {
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

async function selectWithMouse(page, from, to, steps = 8) {
  const points = await chapterText(page).evaluate((body, { from, to }) => {
    const { view } = body.editor
    const a = view.coordsAtPos(from), b = view.coordsAtPos(to)
    return { a: { x: a.left + 1, y: (a.top + a.bottom) / 2 }, b: { x: b.left - 1, y: (b.top + b.bottom) / 2 } }
  }, { from, to })
  await page.mouse.move(points.a.x, points.a.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(points.a.x + (points.b.x - points.a.x) * i / steps, points.a.y + (points.b.y - points.a.y) * i / steps)
    await page.evaluate(() => new Promise(requestAnimationFrame))
    await expect(floating(page)).toBeHidden()
  }
}

test.describe('页面外壳', () => {
  test('页面本身不滚动，只有正文区滚动，工具栏始终在顶上可见 @webkit', async ({ page }) => {
    await seedChapters(page, [['长章', longChapter('雾')]])
    const vertical = async () => { const box = await toolbar(page).boundingBox(); return { y: box.y, height: box.height } }
    const before = await vertical()
    expect(before.y).toBeGreaterThanOrEqual(0)
    await chapterText(page).click()
    await page.mouse.wheel(0, 2400)
    await expect.poll(() => pane(page).evaluate((node) => node.scrollTop)).toBeGreaterThan(600)
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.insertText('最后一句。')
    const state = await page.evaluate(() => ({
      window: scrollY, page: document.querySelector('#page').scrollTop,
      fits: document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth,
    }))
    expect(state).toEqual({ window: 0, page: 0, fits: true })
    expect(await vertical()).toEqual(before)
    await expect.poll(() => reachable(page.getByRole('button', { name: '撤销', exact: true }))).toBe(true)
  })

  test('打印（导出 PDF）不受固定页面限制，长章节分成多页', async ({ page }) => {
    await page.addInitScript(() => { window.print = () => { document.body.dataset.printRequested = 'yes' } })
    await seedChapters(page, [['长章', longChapter('印', 400)]])
    await editorAction(page, '导出')
    const dialog = page.getByRole('dialog', { name: '导出编辑稿' })
    await dialog.getByRole('radio', { name: 'PDF' }).check()
    await dialog.getByRole('button', { name: '开始导出' }).click()
    await expect(page.locator('body')).toHaveAttribute('data-print-requested', 'yes')
    await page.emulateMedia({ media: 'print' })
    const loading = getDocument({ data: Uint8Array.from(await page.pdf({ format: 'A4' })) })
    try { expect((await loading.promise).numPages).toBeGreaterThan(3) } finally { await loading.destroy() }
  })

  test('窄屏时工具按优先级收进「⋯」，工具栏不换行也不横向滚动 @webkit', async ({ page }) => {
    await seedChapters(page, [['第一章', [paragraph('窄屏工具。')]]])
    const row = page.locator('.toolbar-row')
    const height = (await row.boundingBox()).height
    for (const width of [1280, 900, 640, 390, 320]) {
      await page.setViewportSize({ width, height: 700 })
      await expect.poll(() => row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      expect(Math.abs((await row.boundingBox()).height - height)).toBeLessThan(4)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expect(page.locator('.more-toggle')).toBeVisible()
    }
    // At 320 px the low-priority tools are in "⋯" and still work from there.
    await expect(page.getByRole('button', { name: '下划线', exact: true })).toBeHidden()
    await chapterText(page).evaluate((body) => body.editor.commands.setTextSelection({ from: 1, to: 3 }))
    await page.locator('.more-toggle').click()
    await page.getByRole('menuitemcheckbox', { name: '下划线' }).click()
    await expect(chapterText(page).locator('u')).toHaveText('窄屏')
  })
})

test.describe('选中文字的浮动工具条', () => {
  test('拖动中不出现，松开约 200ms 后才出现并固定在选区旁', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await seedChapters(page, [['第一章', [paragraph('选中这一段文字之后，工具条才会出现在旁边。'), ...longChapter('选', 10)]]])
    await selectWithMouse(page, 2, 12)
    // Note when the button is released and when the tools open, then release it.
    await page.evaluate(() => {
      const node = document.querySelector('.selection-toolbar')
      window.selectionTiming = { up: 0, open: 0 }
      document.addEventListener('pointerup', () => { window.selectionTiming.up = performance.now() }, { capture: true, once: true })
      new MutationObserver((_, observer) => {
        if (node.dataset.state === 'open') { window.selectionTiming.open = performance.now(); observer.disconnect() }
      }).observe(node, { attributes: true })
    })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.selectionTiming.open)).toBeGreaterThan(0)
    const timing = await page.evaluate(() => window.selectionTiming.open - window.selectionTiming.up)
    const chosen = await page.evaluate(() => getSelection().toString())
    expect(timing).toBeGreaterThanOrEqual(180)
    expect(timing).toBeLessThan(600)
    await expect(floating(page)).toBeVisible()
    await floating(page).evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)))
    // Beside the selection without covering it, and it does not follow the mouse.
    const box = await floating(page).boundingBox()
    const selection = await page.evaluate(() => getSelection().getRangeAt(0).getBoundingClientRect().toJSON())
    expect(box.y + box.height <= selection.top + 1 || box.y >= selection.bottom - 1).toBe(true)
    await page.mouse.move(20, 600)
    expect(await floating(page).boundingBox()).toEqual(box)
    await expect.poll(() => reachable(floating(page).getByRole('button', { name: '加粗' }))).toBe(true)
    await floating(page).getByRole('button', { name: '加粗' }).click()
    await expect(chapterText(page).locator('strong')).toHaveText(chosen)
    await expect(floating(page).getByRole('button', { name: '加粗' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('点击别处、输入文字、按 Esc、选区变空时消失；键盘选择停下后出现', async ({ page }) => {
    await seedChapters(page, [['第一章', [paragraph('第一句话。第二句话。第三句话。')]]])
    const select = async () => {
      // Put the caret in the text the way a person would, then select the first sentence.
      await chapterText(page).click()
      await expect(chapterText(page)).toBeFocused()
      // The editor may still settle the click's caret a moment later; select again until it holds.
      await expect(async () => {
        await chapterText(page).evaluate((body) => body.editor.commands.setTextSelection({ from: 1, to: 6 }))
        await expect(floating(page)).toBeVisible({ timeout: 1500 })
      }).toPass({ timeout: 8000 })
    }
    await select()
    await page.keyboard.press('Escape')
    await expect(floating(page)).toBeHidden()
    await select()
    await page.locator('.chapter-nav-title').click()
    await expect(floating(page)).toBeHidden()
    await select()
    await chapterText(page).evaluate((body) => body.editor.commands.setTextSelection(3))
    await expect(floating(page)).toBeHidden()
    await select()
    await page.keyboard.type('换')
    await expect(floating(page)).toBeHidden()
    await expect(chapterText(page)).toContainText('换')

    await chapterText(page).evaluate((body) => body.editor.commands.setTextSelection(2))
    await page.keyboard.down('Shift')
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowRight')
      await expect(floating(page)).toBeHidden()
    }
    await page.keyboard.up('Shift')
    await expect(floating(page)).toBeVisible()
  })

  test('记灵感、建任务带上选中文字；批注只在阅读模式出现', async ({ page }) => {
    await seedChapters(page, [['第一章', [paragraph('灯塔下的那封信。')]]])
    await chapterText(page).evaluate((body) => { body.editor.commands.focus(); body.editor.commands.setTextSelection({ from: 1, to: 3 }) })
    await expect(floating(page).getByRole('button', { name: '添加批注' })).toBeHidden()
    await floating(page).getByRole('button', { name: '记灵感' }).click()
    const capture = page.getByRole('dialog', { name: '记灵感' })
    await expect(capture.getByRole('textbox', { name: '灵感' })).toHaveValue('灯塔')
    await capture.getByRole('button', { name: '取消' }).click()

    await editorAction(page, '阅读模式')
    await page.getByRole('document', { name: '章节正文' }).evaluate((body) => {
      const text = body.querySelector('p').firstChild
      const range = document.createRange(); range.setStart(text, 3); range.setEnd(text, 7)
      getSelection().removeAllRanges(); getSelection().addRange(range)
    })
    await expect(floating(page).getByRole('button', { name: '添加批注' })).toBeVisible()
    await expect(floating(page).getByRole('button', { name: '加粗' })).toBeHidden()
    await floating(page).getByRole('button', { name: '添加批注' }).click()
    await expect(page.getByRole('dialog', { name: '添加批注' })).toBeVisible()
  })
})

test.describe('Aa 面板', () => {
  test('与设置页读写同一套偏好，改一边另一边立即同步', async ({ page, context }) => {
    await seedChapters(page, [['第一章', [paragraph('版式同步。')]]])
    const editorUrl = page.url()
    await page.getByRole('button', { name: '外观', exact: true }).click()
    for (const [group, value] of [['行距', '宽松'], ['段落间距', '无'], ['正文宽度', '窄']]) {
      await aaPanel(page).getByRole('radiogroup', { name: group }).getByRole('radio', { name: value }).check()
    }
    await aaPanel(page).getByRole('checkbox', { name: '缩进两字' }).check()

    // The settings page, open in another tab, shows the change at once.
    const settings = await context.newPage()
    await settings.goto('/#/settings/appearance')
    const section = settings.getByRole('region', { name: '外观', exact: true })
    await expect(section.getByRole('radiogroup', { name: '行距' }).getByRole('radio', { name: '宽松' })).toBeChecked()
    await expect(section.getByRole('radiogroup', { name: '首行缩进' }).getByRole('radio', { name: '缩进两字' })).toBeChecked()
    await section.getByRole('radiogroup', { name: '行距' }).getByRole('radio', { name: '紧凑' }).check()
    await section.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '米黄色' }).check()
    // …and the panel still open in the editor follows without reopening.
    await expect(aaPanel(page).getByRole('radiogroup', { name: '行距' }).getByRole('radio', { name: '紧凑' })).toBeChecked()
    await expect(aaPanel(page).getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '米黄色' })).toBeChecked()
    await settings.close()

    // In the same window: the settings page then the editor again.
    await page.keyboard.press('Escape')
    await page.goto('/#/settings/appearance')
    await expect(page.getByRole('region', { name: '外观', exact: true }).getByRole('radiogroup', { name: '正文宽度' }).getByRole('radio', { name: '窄' })).toBeChecked()
    await page.getByRole('region', { name: '外观', exact: true }).getByRole('radiogroup', { name: '段落间距' }).getByRole('radio', { name: '宽' }).check()
    await page.goto(editorUrl)
    await page.getByRole('button', { name: '外观', exact: true }).click()
    await expect(aaPanel(page).getByRole('radiogroup', { name: '段落间距' }).getByRole('radio', { name: '宽' })).toBeChecked()
  })

  test('减少动态效果时面板、侧面板直接切换，不播放过渡', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await seedChapters(page, [['第一章', [paragraph('直接切换。')]]])
    await page.getByRole('button', { name: '外观', exact: true }).click()
    const layer = page.locator('.appearance-panel')
    await expect(layer).toHaveAttribute('data-state', 'open')
    expect(await layer.evaluate((node) => getComputedStyle(node).transitionDuration.split(',').every((value) => parseFloat(value) === 0))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(layer).toHaveCount(0)
    const side = page.locator('.workbench-end')
    await page.locator('.side-toggle').click()
    expect(await side.evaluate((node) => node.hidden || getComputedStyle(node).transitionDuration.split(',').every((value) => parseFloat(value) === 0))).toBe(true)
  })
})

test.describe('章节目录', () => {
  test('拖动调整顺序：有占位，其他章节让位，松开后保存', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await seedChapters(page, [['甲', [paragraph('甲章。')]], ['乙', [paragraph('乙章。')]], ['丙', [paragraph('丙章。')]], ['丁', [paragraph('丁章。')]]])
    const source = await chapterItem(page, '甲').boundingBox()
    const target = await chapterItem(page, '丙').boundingBox()
    await page.mouse.move(source.x + 40, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x + 40, source.y + source.height / 2 + 10, { steps: 3 })
    await expect(page.locator('.chapter-ghost')).toBeVisible()
    await expect(page.locator('.chapter-placeholder')).toContainText('甲')
    await page.mouse.move(source.x + 40, target.y + target.height * .85, { steps: 10 })
    await expect.poll(() => chapterItem(page, '乙').evaluate((node) => node.style.transform)).toMatch(/translateY\(-/)
    await page.mouse.up()
    await expect(page.locator('.chapter-ghost')).toHaveCount(0)
    await expect.poll(() => chapterTitles(page)).toEqual(['乙', '丙', '甲', '丁'])
    await expect(chapterHeading(page)).toHaveText('甲')
    await expect(page.locator('.chapter-navigation [aria-live]')).toHaveText('「甲」已移到第 3 位')
    await page.reload()
    await expect.poll(() => chapterTitles(page)).toEqual(['乙', '丙', '甲', '丁'])
  })

  test('键盘 Alt+方向键调整顺序并朗读新位置；右键与「⋯」除了打开位置只有改名和删除', async ({ page }) => {
    await seedChapters(page, [['甲', [paragraph('甲章。')]], ['乙', [paragraph('乙章。')]], ['丙', [paragraph('丙章。')]]])
    const list = page.getByRole('list', { name: '章节' })
    await list.getByRole('button', { name: '丙', exact: true }).focus()
    await page.keyboard.press('Alt+ArrowUp')
    await expect.poll(() => chapterTitles(page)).toEqual(['甲', '丙', '乙'])
    await expect(list.getByRole('button', { name: '丙', exact: true })).toBeFocused()
    await page.keyboard.press('Alt+ArrowUp')
    await expect.poll(() => chapterTitles(page)).toEqual(['丙', '甲', '乙'])
    await expect(page.locator('.chapter-navigation [aria-live]')).toHaveText('「丙」已移到第 1 位')
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(() => chapterTitles(page)).toEqual(['甲', '丙', '乙'])
    // The announcement comes once the new order is saved.
    await expect(page.locator('.chapter-navigation [aria-live]')).toHaveText('「丙」已移到第 2 位')
    await page.reload()
    await expect.poll(() => chapterTitles(page)).toEqual(['甲', '丙', '乙'])

    await expect(page.getByRole('button', { name: '上移' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '重命名章节' })).toHaveCount(0)
    await list.getByRole('button', { name: '乙', exact: true }).click({ button: 'right' })
    // The ways to open a chapter beside the text come first (第二期 split panes).
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['在右侧打开', '在下方打开', /^重命名章节/, '删除章节'])
    await page.keyboard.press('Escape')
    await chapterItem(page, '甲').hover()
    await expect(chapterItem(page, '甲').locator('.chapter-more')).toBeVisible()
    await chapterItem(page, '甲').locator('.chapter-more').click()
    await page.getByRole('menuitem', { name: /^重命名章节/ }).click()
    await page.getByRole('textbox', { name: '章节名' }).fill('甲之一')
    await page.getByRole('button', { name: '保存章节名' }).click()
    await expect.poll(() => chapterTitles(page)).toEqual(['甲之一', '丙', '乙'])
    await expect(page.getByRole('button', { name: '新建章节', exact: true })).toBeVisible()
  })
})

test.describe('查找并入工具栏', () => {
  test('在工具栏内展开，不另浮一个框；选项、范围记住；全部替换一次撤销', async ({ page }) => {
    await seedChapters(page, [['雾港', [paragraph('Lamp 灯塔，lamp 灯塔，lamplight。')]], ['海图', [paragraph('灯塔在远方。')]]])
    await page.keyboard.press('ControlOrMeta+f')
    const panel = page.getByRole('search', { name: '查找／替换' })
    await expect(panel).toBeVisible()
    expect(await panel.evaluate((node) => Boolean(node.closest('.editor-toolbar')))).toBe(true)
    expect(await panel.evaluate((node) => getComputedStyle(node).position)).not.toBe('fixed')
    const field = panel.getByRole('searchbox', { name: '查找文字' })
    await field.fill('lamp')
    await expect(panel.getByRole('status')).toHaveText('1/3')
    await panel.getByRole('button', { name: '区分大小写' }).click()
    await expect(panel.getByRole('status')).toHaveText('1/2')
    await panel.getByRole('button', { name: '全字匹配' }).click()
    await expect(panel.getByRole('status')).toHaveText('1/1')
    await panel.getByRole('button', { name: '全字匹配' }).click()
    await panel.getByRole('button', { name: '区分大小写' }).click()
    await field.fill('灯塔')
    await expect(panel.getByRole('status')).toHaveText('1/2')
    await panel.getByRole('textbox', { name: '替换为' }).fill('航标')
    await panel.getByRole('button', { name: '全部替换' }).click()
    await expect(chapterText(page)).toHaveText('Lamp 航标，lamp 航标，lamplight。')
    await chapterText(page).focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(chapterText(page)).toHaveText('Lamp 灯塔，lamp 灯塔，lamplight。')

    await page.keyboard.press('ControlOrMeta+f')
    await panel.getByRole('button', { name: '全书', exact: true }).click()
    await panel.getByRole('button', { name: '区分大小写' }).click()
    await expect(panel.locator('.find-chapters li')).toHaveText(['雾港2', '海图1'])
    await panel.locator('.find-chapter-jump', { hasText: '海图' }).click()
    await expect(chapterHeading(page)).toHaveText('海图')
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()

    await page.reload()
    await page.getByRole('button', { name: '查找／替换', exact: true }).click()
    await expect(panel.getByRole('button', { name: '全书', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.getByRole('button', { name: '区分大小写' })).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.getByRole('button', { name: '全字匹配' })).toHaveAttribute('aria-pressed', 'false')
  })
})

test.describe('记住设置与位置', () => {
  test('目录、侧面板（开关、标签、宽度）、格式工具折叠、查找选项和 Aa 在重开和换作品后沿用', async ({ page }) => {
    await seedChapters(page, [['第一章', [paragraph('记住设置。')]]], '甲作品')
    await page.locator('.nav-toggle').click()
    await expect(page.locator('.workbench-start')).toBeHidden()
    await openSidePanel(page, '批注')
    const resizer = page.locator('.workbench-resizer')
    const handle = await resizer.boundingBox()
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 200)
    await page.mouse.down()
    await page.mouse.move(handle.x - 60, handle.y + 200, { steps: 5 })
    await page.mouse.up()
    const width = Math.round((await page.locator('.workbench-end').boundingBox()).width)
    expect(width).toBeGreaterThan(330)
    await editorAction(page, '收起格式工具')
    await expect(page.getByRole('button', { name: '加粗', exact: true })).toBeHidden()
    await page.getByRole('button', { name: '外观', exact: true }).click()
    await aaPanel(page).getByRole('button', { name: '放大字号' }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '查找／替换', exact: true }).click()
    await page.getByRole('search').getByRole('button', { name: '全字匹配' }).click()

    for (const step of ['reload', 'another work']) {
      if (step === 'reload') await page.reload()
      else await seedChapters(page, [['第一章', [paragraph('另一部作品。')]]], '乙作品')
      await expect(chapterText(page)).toBeVisible()
      await expect(page.locator('.workbench-start')).toBeHidden()
      await expect(page.locator('.nav-toggle')).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('.side-toggle')).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByRole('tab', { name: /^批注/ })).toHaveAttribute('aria-selected', 'true')
      expect(Math.abs(Math.round((await page.locator('.workbench-end').boundingBox()).width) - width)).toBeLessThanOrEqual(2)
      await expect(page.getByRole('button', { name: '加粗', exact: true })).toBeHidden()
      await expect(chapterText(page)).toHaveCSS('font-size', '19px')
      await page.getByRole('button', { name: '查找／替换', exact: true }).click()
      await expect(page.getByRole('search').getByRole('button', { name: '全字匹配' })).toHaveAttribute('aria-pressed', 'true')
      await page.keyboard.press('Escape')
    }
    await editorAction(page, '显示格式工具')
    await expect(page.getByRole('button', { name: '加粗', exact: true })).toBeVisible()
  })

  test('每一章都从上次停留的滚动位置和光标位置继续，重开作品回到上次那一章', async ({ page }) => {
    await seedChapters(page, [['第一章', longChapter('一')], ['第二章', longChapter('二')]])
    const place = () => page.evaluate(() => {
      const body = document.querySelector('.novel-body')
      return { scroll: document.querySelector('.editor-scroll').scrollTop, ...body.editor.state.selection.toJSON() }
    })
    await pane(page).evaluate((node) => { node.scrollTop = 900 })
    await chapterText(page).evaluate((body) => body.editor.commands.setTextSelection(120))
    await page.waitForTimeout(500)
    const first = await place()
    await page.getByRole('button', { name: '第二章', exact: true }).click()
    await expect(chapterHeading(page)).toHaveText('第二章')
    await pane(page).evaluate((node) => { node.scrollTop = 1500 })
    await chapterText(page).evaluate((body) => body.editor.commands.setTextSelection({ from: 300, to: 305 }))
    await page.waitForTimeout(500)
    const second = await place()

    await page.getByRole('button', { name: '第一章', exact: true }).click()
    await expect(chapterHeading(page)).toHaveText('第一章')
    await expect.poll(place).toEqual(first)
    await page.getByRole('button', { name: '第二章', exact: true }).click()
    await expect.poll(place).toEqual(second)
    await page.reload()
    await expect(chapterHeading(page)).toHaveText('第二章')
    await expect.poll(place).toEqual(second)
  })
})

test.describe('iPhone 尺寸', () => {
  test.use({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 })

  test('工具栏、选中文字工具和 Aa 面板都在可视区域内且能点按 @webkit', async ({ page }) => {
    await seedChapters(page, [['第一章', [paragraph('手机上选中文字。'), ...longChapter('手', 30)]]])
    for (const name of ['章节目录', '撤销', '更多操作']) {
      await expect.poll(() => reachable(page.locator('.toolbar-row').getByRole('button', { name, exact: true }))).toBe(true)
    }
    await expect.poll(() => reachable(chapterHeading(page))).toBe(true)

    // Touch screens get the tools under the toolbar, away from the system's own selection menu.
    await chapterText(page).tap()
    await chapterText(page).evaluate((body) => body.editor.commands.setTextSelection({ from: 1, to: 5 }))
    const strip = page.locator('.selection-strip')
    await expect(strip).toBeVisible()
    await expect(floating(page)).toBeHidden()
    expect((await strip.boundingBox()).y).toBeGreaterThanOrEqual((await page.locator('.toolbar-row').boundingBox()).y)
    for (const name of ['加粗', '记灵感']) await expect.poll(() => reachable(strip.getByRole('button', { name }))).toBe(true)
    await strip.getByRole('button', { name: '加粗' }).tap()
    await expect(chapterText(page).locator('strong')).toHaveText('手机上选')

    // "Aa" is folded into "⋯" on a phone; its panel spans the width and stays on screen.
    await page.getByRole('button', { name: '更多操作', exact: true }).tap()
    await page.getByRole('menuitem', { name: '外观' }).tap()
    await expect(aaPanel(page)).toBeVisible()
    await expect.poll(() => reachable(aaPanel(page))).toBe(true)
    for (const control of [aaPanel(page).getByRole('radio', { name: '黑色' }).locator('..'), aaPanel(page).getByRole('button', { name: '放大字号' }), aaPanel(page).getByRole('button', { name: '更多设置…' })]) {
      await control.scrollIntoViewIfNeeded()
      await expect.poll(() => reachable(control)).toBe(true)
    }
    await aaPanel(page).getByRole('button', { name: '放大字号' }).tap()
    await expect(aaPanel(page).locator('output')).toHaveText('19 px')

    // With the visible area squeezed (as a keyboard does), the toolbar stays at the top.
    await page.setViewportSize({ width: 390, height: 360 })
    await expect.poll(() => reachable(page.getByRole('button', { name: '更多操作', exact: true }))).toBe(true)
    expect(await page.evaluate(() => scrollY)).toBe(0)
  })
})
