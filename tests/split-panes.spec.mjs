import { expect, test } from './app-test.mjs'
import { chapterText } from './writing-motion-helpers.mjs'
import { chapterHeading, chapterItem } from './editor-helpers.mjs'
import {
  areaPoint, dragTo, editArea, longChapter, openCompareTab, openFromChapterMenu, paragraph, reachable, rectOf,
  referencePanes, referenceText, seedChapters, seedTextWork, settle,
} from './split-helpers.mjs'

const three = [['第一章', [paragraph('灯塔下的第一章。')]], ['第二章', [paragraph('海雾里的第二章。')]], ['第三章', longChapter('潮')]]
const near = (a, b, tolerance = 3) => Math.abs(a - b) <= tolerance

async function closeAll(page) {
  while (await referencePanes(page).count()) {
    const before = await referencePanes(page).count()
    await page.getByRole('button', { name: '关闭对照' }).first().click()
    await expect(referencePanes(page)).toHaveCount(before - 1)
  }
}

/** Reachable once it has finished sliding or fading into place. */
const settledReachable = (locator) => expect.poll(() => reachable(locator)).toBe(true)

async function expectRect(locator, expected) {
  await expect.poll(async () => {
    const rect = await rectOf(locator)
    return ['left', 'top', 'right', 'bottom'].every((key) => expected[key] === undefined || near(rect[key], expected[key]))
  }, { message: JSON.stringify(expected) }).toBe(true)
}

test.describe('拖拽打开', () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1400, height: 900 }) })

  test('从章节目录拖到右半边：拖动中名字跟着光标，落点预览右半，松手展开只读对照块 @webkit', async ({ page }) => {
    await seedChapters(page, three)
    const area = await rectOf(editArea(page))
    await dragTo(page, chapterItem(page, '第二章'), await areaPoint(page, .85, .5), { release: false })
    const ghost = page.locator('.open-ghost')
    await expect(ghost).toHaveText('第二章')
    expect(Number(await ghost.evaluate((node) => getComputedStyle(node).opacity))).toBeLessThan(1)
    expect(await ghost.evaluate((node) => getComputedStyle(node).filter)).toContain('blur')
    await expectRect(page.locator('.drop-preview'), { left: area.left + area.width / 2, top: area.top, right: area.right, bottom: area.bottom })
    await page.mouse.up()
    await expect(referencePanes(page)).toHaveCount(1)
    await expect(page.locator('.open-ghost, .drop-preview')).toHaveCount(0)
    await expect(referenceText(page)).toContainText('海雾里的第二章。')
    await expectRect(referencePanes(page), { left: area.left + area.width / 2, top: area.top, right: area.right, bottom: area.bottom })
    await expectRect(page.locator('.main-pane'), { left: area.left, right: area.left + area.width / 2 })
    await expect(chapterText(page)).toContainText('灯塔下的第一章。')
  })

  for (const [side, fx, fy] of [['左半', .08, .5], ['上半', .5, .06], ['下半', .5, .94]]) {
    test(`拖到${side}，新块占${side}`, async ({ page }) => {
      await seedChapters(page, three)
      const area = await rectOf(editArea(page))
      await dragTo(page, chapterItem(page, '第二章'), await areaPoint(page, fx, fy))
      await expect(referencePanes(page)).toHaveCount(1)
      const expected = {
        左半: { left: area.left, right: area.left + area.width / 2, top: area.top, bottom: area.bottom },
        上半: { left: area.left, right: area.right, top: area.top, bottom: area.top + area.height / 2 },
        下半: { left: area.left, right: area.right, top: area.top + area.height / 2, bottom: area.bottom },
      }[side]
      await expectRect(referencePanes(page), expected)
    })
  }

  test('再拖进右半块的下方成为右下四分之一；贴着整个区域底边放下占满下半', async ({ page }) => {
    await seedChapters(page, three)
    const area = await rectOf(editArea(page))
    await dragTo(page, chapterItem(page, '第二章'), await areaPoint(page, .85, .5))
    await expect(referencePanes(page)).toHaveCount(1)
    await dragTo(page, chapterItem(page, '第三章'), await areaPoint(page, .75, .9), { release: false })
    await expectRect(page.locator('.drop-preview'), { left: area.left + area.width / 2, top: area.top + area.height / 2, right: area.right, bottom: area.bottom })
    await page.mouse.up()
    await expect(referencePanes(page)).toHaveCount(2)
    await expectRect(referencePanes(page).nth(1), { left: area.left + area.width / 2, top: area.top + area.height / 2, right: area.right, bottom: area.bottom })
    await expectRect(referencePanes(page).nth(0), { left: area.left + area.width / 2, top: area.top, bottom: area.top + area.height / 2 })

    // Along the whole area's own bottom edge, the new pane spans every column.
    await dragTo(page, chapterItem(page, '第一章'), { x: area.left + area.width * .25, y: area.bottom - 8 })
    await expect(referencePanes(page)).toHaveCount(3)
    await expectRect(referencePanes(page).nth(2), { left: area.left, right: area.right, top: area.top + area.height / 2, bottom: area.bottom })
    await expectRect(page.locator('.main-pane'), { left: area.left, top: area.top, bottom: area.top + area.height / 2 })
  })

  test('拖到编辑区以外松手或按 Esc：名字散开消失，什么都不打开', async ({ page }) => {
    await seedChapters(page, three)
    const toolbar = await rectOf(page.locator('.editor-toolbar'))
    await dragTo(page, chapterItem(page, '第二章'), { x: toolbar.left + toolbar.width / 2, y: toolbar.top + toolbar.height / 2 }, { release: false })
    await expect(page.locator('.drop-preview')).toBeHidden()
    await page.mouse.up()
    await expect(page.locator('.open-ghost')).toHaveAttribute('data-state', 'scatter')
    await expect(page.locator('.open-ghost')).toHaveCount(0)
    await expect(referencePanes(page)).toHaveCount(0)

    await dragTo(page, chapterItem(page, '第二章'), await areaPoint(page, .85, .5), { release: false })
    await expect(page.locator('.drop-preview')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.open-ghost, .drop-preview')).toHaveCount(0)
    await page.mouse.up()
    await expect(referencePanes(page)).toHaveCount(0)
    // The chapter order is untouched by either drag.
    await expect(page.getByRole('list', { name: '章节' }).locator('.chapter-title')).toHaveText(['第一章', '第二章', '第三章'])
  })

  test('从「对照」标签拖出另一部作品，放下打开它上次读到的章节', async ({ page }) => {
    await seedChapters(page, [['海图', [paragraph('别处的海图。')]]], '另一部')
    await seedChapters(page, three, '分块样书', false)
    const panel = await openCompareTab(page)
    const other = panel.locator('.compare-work').filter({ hasText: '另一部' })
    await expect(other).toBeVisible()
    await dragTo(page, other.locator('.compare-work-entry .compare-entry-open'), await areaPoint(page, .5, .9))
    await expect(referencePanes(page)).toHaveCount(1)
    await expect(referenceText(page)).toContainText('别处的海图。')
  })
})

test.describe('分块大小与聚焦', () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1400, height: 900 }) })

  test('拖动分隔线调大小，有最小尺寸；键盘方向键也能调', async ({ page }) => {
    await seedChapters(page, three)
    await openFromChapterMenu(page, '第二章')
    await expect(referencePanes(page)).toHaveCount(1)
    const divider = page.getByRole('separator', { name: '调整分块大小' })
    await expect(divider).toBeVisible()
    const before = await rectOf(referencePanes(page))
    const handle = await rectOf(divider)
    await page.mouse.move(handle.left + handle.width / 2, handle.top + 200)
    await page.mouse.down()
    await page.mouse.move(handle.left + handle.width / 2 - 120, handle.top + 200, { steps: 6 })
    await page.mouse.up()
    await expect.poll(async () => (await rectOf(referencePanes(page))).width).toBeGreaterThan(before.width + 110)
    // Far past the edge, the text pane keeps its minimum width.
    const moved = await rectOf(divider)
    await page.mouse.move(moved.left + moved.width / 2, moved.top + 200)
    await page.mouse.down()
    await page.mouse.move(0, moved.top + 200, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => Math.round((await rectOf(page.locator('.main-pane'))).width)).toBe(260)
    await divider.focus()
    const wide = (await rectOf(referencePanes(page))).width
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await rectOf(referencePanes(page))).width).toBeLessThan(wide - 10)
    await expect(divider).toBeFocused()
  })

  test('聚焦切换后，作品名、章节名、章节菜单、格式工具和查找都作用于聚焦的块', async ({ page }) => {
    await seedChapters(page, three)
    await openFromChapterMenu(page, '第二章')
    await expect(referenceText(page)).toContainText('海雾里的第二章。')
    const bold = page.getByRole('button', { name: '加粗' })
    // Opening focuses the new pane: the toolbar follows it.
    await expect(chapterHeading(page)).toHaveText('第二章')
    await expect(page.locator('.reference-status')).toHaveText('只读对照')
    await expect(bold).toBeDisabled()
    await expect(page.locator('.split-pane[data-focused]')).toHaveClass(/reference-pane/)

    await chapterText(page).click()
    await expect(chapterHeading(page)).toHaveText('第一章')
    await expect(page.locator('.reference-status')).toBeHidden()
    await expect(bold).toBeEnabled()
    await expect(page.locator('.split-pane[data-focused]')).toHaveClass(/main-pane/)

    await referenceText(page).click()
    await expect(chapterHeading(page)).toHaveText('第二章')
    // The chapter menu switches the focused pane, not the text being written.
    await page.locator('.chapter-name').click()
    await page.getByRole('menuitemradio', { name: /第三章/ }).click()
    await expect(referenceText(page)).toContainText('潮第 1 段')
    await expect(chapterHeading(page)).toHaveText('第三章')
    await expect(chapterText(page)).toContainText('灯塔下的第一章。')
    // Find searches the focused pane.
    await page.keyboard.press('ControlOrMeta+f')
    await page.getByRole('searchbox').first().fill('潮第 12 段')
    await expect(page.locator('.reference-pane .found-text-current')).toHaveCount(1)
    await expect(page.locator('.main-pane .found-text')).toHaveCount(0)
  })

  test('对照块只读：输入不改变内容，可以选中，选中文字只出现「记灵感」并带上文字', async ({ page }) => {
    await seedChapters(page, three)
    await openFromChapterMenu(page, '第二章')
    const text = referenceText(page)
    await expect(text).toHaveAttribute('aria-readonly', 'true')
    await expect(text).toHaveAttribute('contenteditable', 'false')
    await text.click()
    await page.keyboard.type('不该出现')
    await expect(text).toHaveText('海雾里的第二章。')
    await expect(chapterText(page)).not.toContainText('不该出现')
    await text.locator('p').first().click({ clickCount: 3 })
    const tools = page.locator('.selection-toolbar')
    await expect(tools).toBeVisible()
    await expect(tools.locator('.selection-tool:visible')).toHaveCount(1)
    await tools.getByRole('button', { name: '记灵感' }).click()
    await expect(page.getByRole('dialog', { name: '记灵感' }).getByRole('textbox').first()).toHaveValue(/第二章/)
  })
})

test.describe('记住与恢复', () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1400, height: 900 }) })

  test('布局、各块内容、大小和聚焦在重新打开作品后恢复', async ({ page }) => {
    await seedChapters(page, three)
    await openFromChapterMenu(page, '第二章')
    await referenceText(page).click()
    await openFromChapterMenu(page, '第三章', '在下方打开')
    await expect(referencePanes(page)).toHaveCount(2)
    const divider = page.getByRole('separator', { name: '调整分块大小' }).first()
    await divider.focus()
    await page.keyboard.press('Shift+ArrowLeft')
    await settle(page)
    const rects = await referencePanes(page).evaluateAll((nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }))
    const main = await rectOf(page.locator('.main-pane'))
    await page.reload()
    await expect(chapterText(page)).toBeVisible()
    await expect(referencePanes(page)).toHaveCount(2)
    await expect(referencePanes(page).nth(0)).toContainText('海雾里的第二章。')
    await expect(referencePanes(page).nth(1)).toContainText('潮第 1 段')
    await expect.poll(async () => {
      const now = await referencePanes(page).evaluateAll((nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }))
      return now.every((rect, i) => rect.every((value, j) => near(value, rects[i][j])))
    }).toBe(true)
    expect(near((await rectOf(page.locator('.main-pane'))).width, main.width)).toBe(true)
    await expect(page.locator('.split-pane[data-focused]')).toContainText('潮第 1 段')
    await expect(chapterHeading(page)).toHaveText('第三章')

    // Closing every pane leaves the text alone again, also after reopening.
    await closeAll(page)
    await page.reload()
    await expect(chapterText(page)).toBeVisible()
    await expect(referencePanes(page)).toHaveCount(0)
  })

  test('打开任何内容都从上次停留的位置开始：章节和原文件', async ({ page }) => {
    await seedChapters(page, three)
    await seedTextWork(page, '旧港札记', Array.from({ length: 300 }, (_, i) => `札记第 ${i + 1} 行，旧港的码头上堆满了木箱。`).join('\n'))
    await openFromChapterMenu(page, '第三章')
    const pane = referencePanes(page).first()
    await expect(pane).toContainText('潮第 1 段')
    await pane.locator('.reference-scroll').evaluate((node) => { node.scrollTop = 1500 })
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: '关闭对照' }).click()
    await expect(referencePanes(page)).toHaveCount(0)
    await openFromChapterMenu(page, '第三章')
    await expect.poll(() => referencePanes(page).first().locator('.reference-scroll').evaluate((node) => node.scrollTop)).toBeGreaterThan(1400)
    // Only read beside the text: the version still reopens on the chapter being written.
    await page.reload()
    await expect(chapterText(page)).toContainText('灯塔下的第一章。')

    await closeAll(page)
    const panel = await openCompareTab(page)
    const file = panel.locator('.compare-work').filter({ hasText: '旧港札记' })
    await file.locator('summary > svg').click()
    await file.getByRole('button', { name: /原文件/ }).click()
    const reading = referencePanes(page).first()
    await expect(reading).toContainText('札记第 300 行')
    await expect(chapterHeading(page)).toHaveText('原文件')
    await reading.locator('.reference-scroll').evaluate((node) => { node.scrollTop = node.scrollHeight / 2 })
    const half = await reading.locator('.reference-scroll').evaluate((node) => node.scrollTop)
    await page.waitForTimeout(400)
    await page.reload()
    await expect(referencePanes(page).first()).toContainText('札记第 300 行')
    await expect.poll(() => referencePanes(page).first().locator('.reference-scroll').evaluate((node) => node.scrollTop)).toBeGreaterThan(half - 40)
  })

  test('新窗口路由用同一套对照块：同样的停留位置和外观', async ({ page, context }) => {
    await seedChapters(page, three)
    await openFromChapterMenu(page, '第三章')
    await referencePanes(page).first().locator('.reference-scroll').evaluate((node) => { node.scrollTop = 1200 })
    await page.waitForTimeout(400)
    const route = await page.evaluate(() => {
      const layouts = JSON.parse(localStorage.getItem('new-world:editor-split'))
      const pane = Object.values(Object.values(layouts)[0].panes)[0]
      return `#/compare/${pane.library}/${pane.bookId}/${pane.editionId}/${pane.chapterId}`
    })
    const reading = await context.newPage()
    await reading.goto(`/${route}`)
    await expect(reading.getByRole('document', { name: '对照正文' })).toContainText('潮第 1 段')
    await expect(reading.locator('.chapter-name')).toContainText('第三章')
    await expect.poll(() => reading.locator('.reference-scroll').evaluate((node) => node.scrollTop)).toBeGreaterThan(1100)
    const font = await page.locator('.reference-body').evaluate((node) => getComputedStyle(node).fontSize)
    expect(await reading.locator('.reference-body').evaluate((node) => getComputedStyle(node).fontSize)).toBe(font)
  })
})

test.describe('菜单与键盘', () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1400, height: 900 }) })

  test('键盘打开章节的右键菜单，选「在下方打开」；对照标签的条目右键「在右侧打开」', async ({ page }) => {
    await seedChapters(page, three)
    await page.getByRole('list', { name: '章节' }).getByRole('button', { name: '第二章', exact: true }).focus()
    await page.keyboard.press('Shift+F10')
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: '在下方打开' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(referencePanes(page)).toHaveCount(1)
    const area = await rectOf(editArea(page))
    await expectRect(referencePanes(page), { top: area.top + area.height / 2, bottom: area.bottom, left: area.left, right: area.right })

    const panel = await openCompareTab(page)
    await panel.getByRole('button', { name: /第三章/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '在右侧打开' }).click()
    await expect(referencePanes(page)).toHaveCount(2)
    await expect(referencePanes(page).nth(1)).toContainText('潮第 1 段')
    // "Right" splits the focused pane (the one below), so it takes the lower right quarter.
    await expectRect(referencePanes(page).nth(1), { left: area.left + area.width / 2, top: area.top + area.height / 2, right: area.right })
    // The web version has no separate windows.
    await panel.getByRole('button', { name: /第一章/ }).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: '在新窗口打开' })).toHaveCount(0)
  })

  test('作品名菜单的「对照阅读」打开本作品另一章；角上菜单「切到这一章编辑」交换两块内容', async ({ page }) => {
    await seedChapters(page, three)
    await chapterText(page).click()
    await page.locator('.work-name').click()
    await page.getByRole('menuitem', { name: '对照阅读' }).click()
    await page.getByRole('menuitem', { name: '本作品' }).click()
    await page.getByRole('menuitem', { name: '第二章' }).click()
    await expect(referenceText(page)).toContainText('海雾里的第二章。')
    await chapterText(page).click()
    await page.keyboard.press('End')
    await page.keyboard.type('又添一句。')
    await referencePanes(page).first().getByRole('button', { name: '对照块菜单' }).click()
    await page.getByRole('menuitem', { name: '切到这一章编辑' }).click()
    await expect(chapterText(page)).toContainText('海雾里的第二章。')
    await expect(referenceText(page)).toContainText('灯塔下的第一章。又添一句。')
    await expect(chapterHeading(page)).toHaveText('第二章')
  })

  test('书架卡片右键「在右侧打开」：回到上次编辑的稿件，并把这部作品放在旁边', async ({ page }) => {
    await seedChapters(page, [['海图', [paragraph('别处的海图。')]]], '另一部')
    await seedChapters(page, three, '分块样书', false)
    await page.goto('/#/writing')
    await page.locator('.book-card').filter({ hasText: '另一部' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '在右侧打开' }).click()
    await expect(chapterText(page)).toContainText('灯塔下的第一章。')
    await expect(referenceText(page)).toContainText('别处的海图。')
  })

  test('减少动态效果时直接切换：没有过渡，取消时名字直接消失', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await seedChapters(page, three)
    await dragTo(page, chapterItem(page, '第二章'), await areaPoint(page, .85, .5))
    await expect(referencePanes(page)).toHaveCount(1)
    await expect(editArea(page)).not.toHaveAttribute('data-animating', /.*/)
    await dragTo(page, chapterItem(page, '第二章'), { x: 5, y: 5 })
    await expect(page.locator('.open-ghost')).toHaveCount(0)
  })
})

test.describe('窄屏', () => {
  test('窄屏不硬分：对照在右侧抽屉里打开，左右滑动切换，工具栏按钮重新打开 @webkit', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 664 })
    await seedChapters(page, three)
    await page.locator('.nav-toggle').click()
    await openFromChapterMenu(page, '第二章')
    const drawer = page.locator('.compare-drawer')
    await expect(drawer).toHaveAttribute('data-state', 'open')
    await expect(referenceText(page)).toContainText('海雾里的第二章。')
    await settledReachable(drawer.locator('.pane-close'))
    await settledReachable(page.locator('.chapter-name'))
    await expect(chapterHeading(page)).toHaveText('第二章')
    // The text pane is never split.
    await expect(page.locator('.split-view .reference-pane')).toHaveCount(0)

    await page.locator('.compare-scrim').click({ position: { x: 10, y: 200 } })
    await expect(drawer).toHaveAttribute('data-state', 'closed')
    await expect(chapterHeading(page)).toHaveText('第一章')
    await page.locator('.nav-toggle').click()
    await openFromChapterMenu(page, '第三章')
    await expect(drawer.locator('.reference-pane')).toHaveCount(2)
    await expect(drawer.getByRole('tab')).toHaveCount(2)
    await expect(chapterHeading(page)).toHaveText('第三章')
    // Swiping sideways (the track snaps a pane at a time) moves to the other one.
    const track = drawer.locator('.compare-track')
    expect(await track.evaluate((node) => getComputedStyle(node).scrollSnapType)).toContain('x')
    await track.evaluate((node) => node.scrollTo({ left: 0, behavior: 'instant' }))
    await expect(chapterHeading(page)).toHaveText('第二章')
    await expect(drawer.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveAttribute('data-state', 'closed')

    const toggle = page.locator('.compare-toggle')
    const reopen = await toggle.isVisible() ? toggle : page.locator('.more-toggle')
    await settledReachable(reopen)
    if (reopen === toggle) await toggle.click()
    else { await reopen.click(); await page.getByRole('menuitem', { name: '对照' }).click() }
    await expect(drawer).toHaveAttribute('data-state', 'open')
    await settledReachable(drawer.locator('.compare-dot').first())
  })

  test('窗口变宽后抽屉里的对照回到分块，变窄后又收进抽屉', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 })
    await seedChapters(page, three)
    await page.locator('.nav-toggle').click()
    await openFromChapterMenu(page, '第二章')
    await expect(page.locator('.compare-drawer .reference-pane')).toHaveCount(1)
    await page.setViewportSize({ width: 1400, height: 900 })
    await expect(page.locator('.split-view .reference-pane')).toHaveCount(1)
    await expect(page.locator('.compare-drawer')).toBeHidden()
    await page.setViewportSize({ width: 480, height: 800 })
    await expect(page.locator('.compare-drawer .reference-pane')).toHaveCount(1)
    await expect(page.locator('.compare-drawer')).toHaveAttribute('data-state', 'closed')
  })
})

test.describe('iPhone 尺寸', () => {
  test.use({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true })

  test('抽屉、角上按钮和对照标签都在可视区域内且能点按 @webkit', async ({ page }) => {
    await seedChapters(page, three)
    const panel = await openCompareTab(page)
    const entry = panel.getByRole('button', { name: /第二章/ })
    await settledReachable(entry)
    await entry.tap()
    const drawer = page.locator('.compare-drawer')
    await expect(drawer).toHaveAttribute('data-state', 'open')
    for (const control of [drawer.locator('.pane-menu'), drawer.locator('.pane-close'), page.locator('.chapter-name')]) {
      await settledReachable(control)
    }
    await drawer.locator('.pane-close').tap()
    await expect(drawer.locator('.reference-pane')).toHaveCount(0)
    await expect(drawer).toHaveAttribute('data-state', 'closed')
  })
})
