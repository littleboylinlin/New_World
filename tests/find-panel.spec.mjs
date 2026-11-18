import { expect, test } from './app-test.mjs'
import { beginComposition, endComposition, expectReadingBox, readingBoxes, updateComposition } from './typing-helpers.mjs'
import { chapterText, newWritingNovel } from './writing-motion-helpers.mjs'

const panel = (page) => page.getByRole('search', { name: '查找／替换', exact: true })
const field = (page) => panel(page).getByRole('searchbox', { name: '查找文字' })
const replaceField = (page) => panel(page).getByRole('textbox', { name: '替换为' })
const control = (page, name) => panel(page).getByRole('button', { name, exact: true })
const counter = (page) => panel(page).getByRole('status')
const chapters = (page) => panel(page).locator('.find-chapters')
const total = (page) => panel(page).locator('.find-total')
const book = (page) => panel(page).locator('.find-book')
const active = (page) => page.locator('.found-text-current')
const matches = (page) => page.locator('.found-text')

const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

async function seedBook(page, entries) {
  await page.goto('/')
  await newWritingNovel(page, '查找样书')
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
    request.onsuccess = () => {
      const [edition] = request.result
      edition.chapters = entries.map(([title, paragraphs], i) => {
        const id = edition.chapters[i]?.id ?? crypto.randomUUID()
        records.put({ library: edition.library, bookId: edition.bookId, editionId: edition.id, id,
          content: { type: 'doc', content: paragraphs }, revision: 0 })
        return { id, title }
      })
      editions.put(edition)
    }
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve
      transaction.onabort = () => reject(transaction.error)
    })
    db.close()
  }, entries)
  await page.reload()
  await expect(chapterText(page)).toBeVisible()
}

async function openFind(page, query, wholeBook = false) {
  await page.getByRole('button', { name: '查找／替换', exact: true }).click()
  if (wholeBook) await control(page, '全书').click()
  await field(page).fill(query)
}

const fourChapters = [
  ['雾港', [paragraph('灯塔在开头。另一座灯塔在后面。')]],
  ['海图', [paragraph('潮水漫过船舷。')]],
  ['归航', [paragraph('归来的灯塔。结尾是灯塔。')]],
  ['远方', [paragraph('还记得灯塔。')]],
]

function viewportBounds(locator) {
  return locator.evaluate((node) => {
    const { top, right, bottom, left, width, height } = node.getBoundingClientRect()
    const view = window.visualViewport
    const x = view?.offsetLeft ?? 0, y = view?.offsetTop ?? 0
    const point = document.elementFromPoint(left + width / 2, top + height / 2)
    return {
      fullyInside: left >= x && top >= y && right <= x + (view?.width ?? innerWidth)
        && bottom <= y + (view?.height ?? innerHeight),
      hit: node.contains(point),
    }
  })
}

async function expectMatchClear(page, centered = false) {
  await expect.poll(() => active(page).evaluate((mark, centered) => {
    const match = mark.getBoundingClientRect()
    const find = document.querySelector('.search-panel').getBoundingClientRect()
    const header = document.querySelector('.site-header').getBoundingClientRect()
    const bottom = Math.min(innerHeight, document.querySelector('.site-footer').getBoundingClientRect().top)
    const top = Math.max(0, header.bottom)
    const overlap = match.left < find.right && match.right > find.left && match.top < find.bottom && match.bottom > find.top
    const centerError = Math.abs((match.top + match.bottom - find.bottom - bottom) / 2)
    return !overlap && match.top >= top && match.bottom <= bottom && (!centered || centerError < 42)
  }, centered)).toBe(true)
}

test('快捷键预填选中文字，查找计数和前后导航可绕回 @webkit', async ({ page }) => {
  const filler = Array.from({ length: 42 }, () => paragraph('海风从石墙上吹过。'))
  await seedBook(page, [['长章', [paragraph('第一处灯塔。'), ...filler, paragraph('第二处灯塔。'),
    ...filler, paragraph('末尾灯塔。'), ...filler]]])
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await chapterText(page).evaluate((body) => {
    body.editor.view.focus()
    body.editor.commands.setTextSelection({ from: 4, to: 6 })
  })
  await page.keyboard.press('ControlOrMeta+f')
  await expect(field(page)).toBeFocused()
  await expect(field(page)).toHaveValue('灯塔')
  expect(await field(page).evaluate((input) => [input.selectionStart, input.selectionEnd])).toEqual([0, 2])
  await expect(counter(page)).toHaveText('1/3')
  await expect(matches(page)).toHaveCount(3)
  await expectMatchClear(page)
  await expect(active(page)).not.toHaveCSS('box-shadow', 'none')
  const ordinaryColor = await matches(page).last().evaluate((node) => getComputedStyle(node).backgroundColor)
  await expect(active(page)).not.toHaveCSS('background-color', ordinaryColor)

  await field(page).press('Enter')
  await expect(counter(page)).toHaveText('2/3')
  await expectMatchClear(page, true)
  await field(page).press('Shift+Enter')
  await expect(counter(page)).toHaveText('1/3')
  await field(page).press('Shift+F3')
  await expect(counter(page)).toHaveText('3/3')
  await expectMatchClear(page, true)
  await field(page).press('F3')
  await expect(counter(page)).toHaveText('1/3')
  await control(page, '上一处').click()
  await expect(counter(page)).toHaveText('3/3')
  await control(page, '下一处').click()
  await expect(counter(page)).toHaveText('1/3')
  await expectMatchClear(page)

  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight / 2, behavior: 'instant' }))
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(700)
  await expect.poll(() => viewportBounds(field(page))).toEqual({ fullyInside: true, hit: true })
  await control(page, '下一处').click()
  await expect(counter(page)).toHaveText('2/3')
  await expectMatchClear(page, true)
})

test('全书按章计数，点击章节跳到第一处并保存正在编辑的正文 @webkit', async ({ page }) => {
  await seedBook(page, fourChapters)
  await openFind(page, '灯塔', true)
  await expect(book(page)).toHaveAttribute('aria-busy', 'false')
  await expect(total(page)).toHaveText('共 5 处')
  await expect(chapters(page).locator('li')).toHaveText(['雾港2', '归航2', '远方1'])
  await expect(counter(page)).toHaveText('1/5')

  const statusAtClick = await chapterText(page).evaluate((body) => {
    body.editor.commands.insertContentAt(body.editor.state.doc.content.size - 1, '补写的灯塔。')
    const status = document.querySelector('.save-status').textContent
    Array.from(document.querySelectorAll('.find-chapter-jump')).find((row) => row.innerText.includes('归航')).click()
    return status
  })
  expect(statusAtClick).toBe('未保存')
  await expect(page.locator('.writing-header h3')).toHaveText('归航')
  await expect(chapters(page).locator('li')).toHaveText(['雾港3', '归航2', '远方1'])
  await expect(counter(page)).toHaveText('4/6')
  await expect(active(page).locator('..')).toHaveText('归来的灯塔。结尾是灯塔。')
  await expect(matches(page).first()).toHaveClass(/found-text-current/)
  await expectMatchClear(page)
  await chapters(page).getByRole('button', { name: /雾港/ }).click()
  await expect(chapterText(page)).toContainText('补写的灯塔。')
  await page.reload()
  await expect(chapterText(page)).toContainText('补写的灯塔。')
})

test('全书前后导航越过空章并按章节顺序绕回 @webkit', async ({ page }) => {
  await seedBook(page, fourChapters)
  await openFind(page, '灯塔', true)
  await expect(counter(page)).toHaveText('1/5')
  await field(page).press('Enter')
  await expect(counter(page)).toHaveText('2/5')
  await field(page).press('Enter')
  await expect(page.locator('.writing-header h3')).toHaveText('归航')
  await expect(counter(page)).toHaveText('3/5')
  await expectMatchClear(page)
  await field(page).press('Shift+Enter')
  await expect(page.locator('.writing-header h3')).toHaveText('雾港')
  await expect(counter(page)).toHaveText('2/5')
  await field(page).press('Shift+F3')
  await expect(counter(page)).toHaveText('1/5')
  await field(page).press('Shift+F3')
  await expect(page.locator('.writing-header h3')).toHaveText('远方')
  await expect(counter(page)).toHaveText('5/5')
  await field(page).press('F3')
  await expect(page.locator('.writing-header h3')).toHaveText('雾港')
  await expect(counter(page)).toHaveText('1/5')
})

test('大小写和全字匹配适用于英文和数字，中文支持子串 @webkit', async ({ page }) => {
  const mixed = { type: 'paragraph', content: [
    { type: 'text', text: 'cat CAT catalog xcat cat2 42 A42 421 猫咪 小猫 ' },
    { type: 'text', text: 'c', marks: [{ type: 'bold' }] },
    { type: 'text', text: 'at' },
  ] }
  await seedBook(page, [['词语', [mixed]], ['数字', [paragraph('cat 42 42a')]]])
  await openFind(page, 'cat')
  await expect(counter(page)).toHaveText('1/6')
  await control(page, '区分大小写').click()
  await expect(counter(page)).toHaveText('1/5')
  await control(page, '全字匹配').click()
  await expect(counter(page)).toHaveText('1/2')
  await control(page, '区分大小写').click()
  await expect(counter(page)).toHaveText('1/3')
  await control(page, '全书').click()
  await expect(total(page)).toHaveText('共 4 处')
  await field(page).fill('42')
  await expect(counter(page)).toHaveText('1/2')
  await expect(chapters(page).locator('li')).toHaveText(['词语1', '数字1'])
  await field(page).fill('猫')
  await expect(counter(page)).toHaveText('1/2')
  await expect(chapters(page).locator('li')).toHaveText(['词语2'])
})

test('全书模式也仅替换本章，全部替换可一次撤销 @webkit', async ({ page }) => {
  const original = '灯塔、灯塔和灯塔。'
  await seedBook(page, [['第一章', [paragraph(original)]], ['第二章', [paragraph('仍然是灯塔。')]]])
  await openFind(page, '灯塔', true)
  await expect(counter(page)).toHaveText('1/4')
  await replaceField(page).fill('航标')
  await control(page, '替换').click()
  await expect(chapterText(page)).toHaveText('航标、灯塔和灯塔。')
  await expect(counter(page)).toHaveText('1/3')
  await control(page, '全部替换').click()
  await expect(chapterText(page)).toHaveText('航标、航标和航标。')
  await expect(total(page)).toHaveText('共 1 处')
  await expect(chapters(page).locator('li')).toHaveText(['第二章1'])
  await chapterText(page).evaluate((body) => body.editor.view.focus())
  await page.keyboard.press('ControlOrMeta+z')
  await expect(chapterText(page)).toHaveText('航标、灯塔和灯塔。')
  await expect(total(page)).toHaveText('共 3 处')
  await chapters(page).getByRole('button', { name: /第二章/ }).click()
  await expect(chapterText(page)).toHaveText('仍然是灯塔。')
})

test('Esc 清除高亮并把光标放在当前匹配开头，减少动态效果时立即关闭 @webkit', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await seedBook(page, fourChapters)
  await openFind(page, '灯塔')
  await expect(counter(page)).toHaveText('1/2')
  expect(await panel(page).evaluate((node) => node.getAnimations().length)).toBe(0)
  await field(page).press('Enter')
  await expect(counter(page)).toHaveText('2/2')
  const position = await active(page).evaluate((mark) => mark.closest('.novel-body').editor.view.posAtDOM(mark.firstChild, 0))
  const closed = await field(page).evaluate((input) => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const body = document.querySelector('.novel-body')
    const selection = body.editor.state.selection
    return {
      hidden: document.querySelector('.search-panel').hidden,
      focus: document.activeElement === body,
      from: selection.from, to: selection.to,
    }
  })
  expect(closed).toEqual({ hidden: true, focus: true, from: position, to: position })
  await expect(matches(page)).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+f')
  await expect(counter(page)).toHaveText('1/2')
  await chapterText(page).evaluate((body) => body.editor.view.focus())
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
  await expect(matches(page)).toHaveCount(0)
})

test('拼音组字保留拼写框，查找在上屏后执行 @webkit', async ({ page }) => {
  await seedBook(page, [['雾港', [paragraph('灯塔与码头 deng deng deng')]], ['归航', [paragraph('航标和航标')]]])
  await openFind(page, '灯塔', true)
  await expect(counter(page)).toHaveText('1/1')
  await field(page).evaluate((input) => input.select())
  await beginComposition(field(page))
  await updateComposition(field(page), 'deng')
  await expectReadingBox(page, field(page), 'deng')
  await page.waitForTimeout(320)
  await expect(matches(page)).toHaveText(['灯塔'])
  await expect(total(page)).toHaveText('共 0 处')
  await field(page).dispatchEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })
  await expect(field(page)).toBeVisible()
  await endComposition(field(page), '航标')
  await expect(readingBoxes(page)).toHaveCount(0)
  await expect(total(page)).toHaveText('共 2 处')
  await expect(chapters(page).locator('li')).toHaveText(['归航2'])
  await replaceField(page).focus()
  await beginComposition(replaceField(page))
  await updateComposition(replaceField(page), 'biao')
  await expectReadingBox(page, replaceField(page), 'biao')
  await endComposition(replaceField(page), '标')
  await expect(replaceField(page)).toHaveValue('标')
})

test.describe('iPhone 尺寸', () => {
  test.use({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 })

  test('滚动、输入和缩小视口后，查找框与导航仍在可视区域并可点按 @webkit', async ({ page }) => {
    const filler = Array.from({ length: 22 }, () => paragraph('海风越过防波堤。'))
    await seedBook(page, [['雾港', [paragraph('灯塔在港口。'), ...filler, paragraph('灯塔在海上。'), ...filler]],
      ...fourChapters.slice(1)])
    await page.getByRole('button', { name: '查找／替换', exact: true }).tap()
    await control(page, '全书').tap()
    await field(page).fill('灯塔')
    await expect(counter(page)).toHaveText('1/5')
    await expectMatchClear(page)
    await page.evaluate(() => window.scrollBy({ top: 480, behavior: 'instant' }))
    await expect.poll(() => viewportBounds(panel(page))).toEqual({ fullyInside: true, hit: true })
    await page.setViewportSize({ width: 390, height: 332 })
    await expect.poll(() => viewportBounds(panel(page))).toEqual({ fullyInside: true, hit: true })
    for (const target of [field(page), control(page, '下一处'), control(page, '关闭查找')]) {
      await expect.poll(() => viewportBounds(target)).toEqual({ fullyInside: true, hit: true })
    }
    await control(page, '下一处').tap()
    await expect(counter(page)).toHaveText('2/5')
    await expectMatchClear(page)
    await field(page).tap()
    await expect(field(page)).toBeFocused()
    await control(page, '关闭查找').tap()
    await expect(panel(page)).toBeHidden()
  })
})

test('200 章各 5000 字，分批更新且输入取消上一轮全书查找 @webkit', async ({ page }, testInfo) => {
  await seedBook(page, Array.from({ length: 200 }, (_, i) => {
    const prefix = i % 2 ? '灯塔航标' : '灯塔潮汐'
    return [`第 ${i + 1} 章`, [paragraph(prefix + '海'.repeat(5000 - prefix.length))]]
  }))
  await openFind(page, '', true)
  await expect(book(page)).toHaveAttribute('aria-busy', 'false')
  // Feed the next term on the first progressive result, while the first scan still owns the list.
  // The animation frame measures input-to-frame delay separately from full-query completion.
  const timing = await panel(page).evaluate((panel) => new Promise((resolve, reject) => {
    const input = panel.querySelector('input')
    const book = panel.querySelector('.find-book')
    const total = book.querySelector('.find-total')
    let start, updated, inputFrame, firstPartial
    const write = (value) => {
      input.focus({ preventScroll: true })
      input.value = value
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    }
    const observer = new MutationObserver(() => {
      const hits = Number(total.textContent.match(/\d+/)?.[0])
      const busy = book.getAttribute('aria-busy') === 'true'
      if (!updated && busy && hits > 1 && hits < 200) {
        firstPartial = hits
        updated = performance.now()
        write('航标')
        requestAnimationFrame(() => { inputFrame = performance.now() - updated })
      } else if (updated && !busy && hits === 100) {
        window.clearTimeout(deadline)
        observer.disconnect()
        resolve({ firstPartial, toFirstBatchMs: updated - start, inputToFrameMs: inputFrame, toCompleteMs: performance.now() - updated })
      }
    })
    const deadline = window.setTimeout(() => {
      observer.disconnect()
      reject(new Error(`Search did not finish: ${input.value}, ${total.textContent}`))
    }, 10000)
    observer.observe(book, { attributes: true, childList: true, subtree: true })
    start = performance.now()
    write('灯塔')
  }))
  await expect(chapters(page).locator('li')).toHaveCount(100)
  await expect(chapters(page).locator('li').first()).toHaveText('第 2 章1')
  await expect(chapters(page).locator('li').last()).toHaveText('第 200 章1')
  expect(timing.inputToFrameMs).toBeLessThan(150)
  expect(timing.toCompleteMs).toBeLessThan(5000)
  await testInfo.attach('全书查找耗时（毫秒）', { body: JSON.stringify(timing), contentType: 'application/json' })
})
