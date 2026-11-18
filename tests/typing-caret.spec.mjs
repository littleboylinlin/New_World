import { expect, test } from './app-test.mjs'
import { caret, chapterText, expectCaretAligned, newWritingNovel, traceCaretMotion, expectSmoothTrace, expectSnapTrace } from './writing-motion-helpers.mjs'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
})

async function ready(page, content = '灯塔旁的一封信。') {
  await newWritingNovel(page)
  const text = chapterText(page)
  await text.fill(content)
  await text.evaluate((node) => node.editor.commands.focus('end'))
  await expectCaretAligned(page)
  await page.evaluate(() => Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished)))
  return text
}

/** Real input-method events through Chromium's IME channel. */
async function ime(page) {
  const cdp = await page.context().newCDPSession(page)
  return {
    compose: (text, at = text.length) => cdp.send('Input.imeSetComposition', { text, selectionStart: at, selectionEnd: at }),
    commit: (text) => cdp.send('Input.insertText', { text }),
    cancel: () => cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }),
    detach: () => cdp.detach(),
  }
}

const reading = (page) => page.evaluate(() => {
  const highlight = CSS.highlights.get('typing-composition')
  if (!highlight) return null
  const range = [...highlight][0]
  return { text: range.toString(), rects: [...range.getClientRects()].map((rect) => rect.toJSON()) }
})

/** The reading box ends where the caret is and sits on the caret's line. */
async function expectReading(page, text) {
  await expect.poll(async () => (await reading(page))?.text).toBe(text)
  await expectCaretAligned(page)
  await expect.poll(async () => {
    const last = (await reading(page)).rects.at(-1)
    const box = await caret(page).boundingBox()
    const middle = box.y + box.height / 2
    return Math.abs(last.right - box.x) + (middle > last.top && middle < last.bottom ? 0 : Infinity)
  }).toBeLessThan(1.5)
  return (await reading(page)).rects
}

const plain = (text) => text.evaluate((node) => node.editor.getText())

/** Samples the caret every frame while an action runs in the page, then until it settles. */
function typeAndWatch(text, characters, interval) {
  return text.evaluate(async (node, { characters, interval }) => {
    const cursor = document.querySelector('.writing-caret')
    const paper = cursor.parentElement
    const target = () => {
      const selection = getSelection(), range = document.createRange()
      range.setStart(selection.focusNode, selection.focusOffset)
      range.collapse(true)
      return range.getClientRects()[0] ?? range.getBoundingClientRect()
    }
    const widthBefore = () => {
      const { focusNode, focusOffset } = getSelection()
      const range = document.createRange()
      range.setStart(focusNode, Math.max(0, focusOffset - 1))
      range.setEnd(focusNode, focusOffset)
      return range.getBoundingClientRect().width
    }
    const samples = []
    let typing = true
    let lastKey = 0
    // Read after the frame's own callbacks have run, i.e. what was painted.
    const watch = (now) => setTimeout(() => {
      const goal = target(), rect = cursor.getBoundingClientRect()
      // Skip frames where a key arrived after the frame was laid out: not yet measured.
      if (lastKey <= now) samples.push({ now, typing, gap: Math.hypot(rect.left - goal.left, rect.top - goal.top), width: widthBefore(), dy: rect.top - paper.getBoundingClientRect().top })
      if (typing || Math.hypot(rect.left - goal.left, rect.top - goal.top) > .25) requestAnimationFrame(watch)
    })
    requestAnimationFrame(watch)
    for (const character of characters) {
      document.execCommand('insertText', false, character)
      lastKey = performance.now()
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
    typing = false
    await new Promise((resolve) => setTimeout(resolve, 400))
    const settled = samples.find((sample) => !sample.typing && sample.now > lastKey && sample.gap <= .25)
    return { samples, lastKey, settledAfter: settled ? settled.now - lastKey : Infinity }
  }, { characters, interval })
}

test('连打时光标在滑但落后不超过 1.5 个字符，停手后 150ms 内到位 @webkit', async ({ page }) => {
  const text = await ready(page)
  for (const [characters, interval] of [['ikilmnwqae', 35], ['雾里的灯塔照着海', 60], ['i', 0]]) {
    const { samples, settledAfter } = await typeAndWatch(text, [...characters], interval)
    const typing = samples.filter((sample) => sample.typing)
    // Visibly sliding: during typing the drawn caret trails its target on many frames.
    if (characters.length > 1) expect(typing.filter((sample) => sample.gap > 1).length).toBeGreaterThan(typing.length / 3)
    else expect(samples.some((sample) => sample.gap > 1)).toBe(true)
    for (const sample of samples) expect(sample.gap).toBeLessThanOrEqual(1.5 * Math.max(sample.width, 1) + 1)
    // 150ms after the last move, plus the frame that measures it.
    expect(settledAfter).toBeLessThanOrEqual(150 + 2 * 17)
    expect(settledAfter).toBeGreaterThan(40)
  }
  await expectCaretAligned(page)
})

test('打字自然折行时光标横向回到行首、纵向滑到下一行，不经过别处 @webkit', async ({ page }) => {
  const text = await ready(page, '')
  // Fill the line until one more character wraps.
  await text.evaluate((node) => {
    const { editor } = node
    const top = () => editor.view.coordsAtPos(editor.state.selection.head).top
    const first = top()
    while (true) {
      editor.commands.insertContent('w')
      if (top() > first) { editor.commands.deleteRange({ from: editor.state.selection.head - 1, to: editor.state.selection.head }); break }
    }
    editor.commands.focus('end')
  })
  await expectCaretAligned(page)
  const trace = await traceCaretMotion(page, () => page.keyboard.insertText('w'))
  expect(trace.target.y - trace.before.y).toBeGreaterThan(10)
  expect(trace.target.x).toBeLessThan(trace.before.x - 100)
  const moved = trace.samples.filter((point) => Math.hypot(point.x - trace.before.x, point.y - trace.before.y) > .5)
  expect(moved.length).toBeGreaterThan(2)
  let previousY = trace.before.y
  for (const point of moved) {
    // Already at the start of the new line horizontally, descending without overshoot.
    expect(Math.abs(point.x - trace.target.x)).toBeLessThan(1)
    expect(point.y).toBeGreaterThanOrEqual(previousY - .01)
    expect(point.y).toBeLessThanOrEqual(trace.target.y + .01)
    previousY = point.y
  }
  expect(moved.some((point) => point.y < trace.target.y - 2)).toBe(true)
})

test('长按删除、Home/End、全选后移动、远距离跳转、粘贴和工具改写都直接到位 @webkit', async ({ page }) => {
  const text = await ready(page, '灯塔旁的一封长信，写给远方。')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('第二段里还有很多字。')
  await expectCaretAligned(page)
  expectSnapTrace(await traceCaretMotion(page, () => page.keyboard.press('Home')))
  expectSnapTrace(await traceCaretMotion(page, () => page.keyboard.press('End')))
  const control = process.platform === 'darwin' ? 'Meta' : 'Control'
  expectSnapTrace(await traceCaretMotion(page, () => page.keyboard.press(`${control}+Home`)))
  expectSnapTrace(await traceCaretMotion(page, () => page.keyboard.press(`${control}+End`)))
  // Holding Backspace repeats the key; after the first press every repeat lands at once.
  await page.keyboard.down('Backspace')
  await expectCaretAligned(page)
  for (let i = 0; i < 3; i++) expectSnapTrace(await traceCaretMotion(page, () => page.keyboard.down('Backspace')))
  await page.keyboard.up('Backspace')
  await page.keyboard.press(`${control}+a`)
  await expect(caret(page)).toBeHidden()
  await page.keyboard.press('ArrowRight')
  await expectCaretAligned(page)
  expectSnapTrace(await traceCaretMotion(page, () => text.evaluate((node) => {
    const data = new DataTransfer()
    data.setData('text/plain', '粘贴进来的一大段文字，足够长。')
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })))
  expectSnapTrace(await traceCaretMotion(page, () => text.evaluate((node) => node.editor.commands.insertContent('工具插入的整句话。'))))
  expect(await plain(text)).toContain('粘贴进来的一大段文字，足够长。工具插入的整句话。')
})

test('系统减少动态效果时输入和上屏都直接到位', async ({ page }) => {
  const text = await ready(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expectSnapTrace(await traceCaretMotion(page, () => page.keyboard.insertText('wwww')))
  const input = await ime(page)
  try {
    await input.compose('zhongwen')
    await expectReading(page, 'zhongwen')
    expectSnapTrace(await traceCaretMotion(page, () => input.commit('中')))
  } finally { await input.detach() }
  expect(await plain(text)).toBe('灯塔旁的一封信。wwww中')
})

test('输入法：行中拼写、上屏后光标从拼音末尾滑到汉字末尾、一次撤销整词', async ({ page }) => {
  const text = await ready(page)
  await text.evaluate((node) => node.editor.commands.setTextSelection(3))
  await expectCaretAligned(page)
  await page.waitForTimeout(600)
  const input = await ime(page)
  try {
    await input.compose('d')
    await expectReading(page, 'd')
    await input.compose('deng')
    await expectReading(page, 'deng')
    await input.compose('dengguang')
    await expectReading(page, 'dengguang')
    // The caret keeps moving with the reading instead of freezing.
    const trace = await traceCaretMotion(page, () => input.commit('灯光'))
    await expect.poll(() => reading(page)).toBeNull()
    expect(await plain(text)).toBe('灯塔灯光旁的一封信。')
    const moved = trace.samples.filter((point) => Math.abs(point.x - trace.before.x) > .5)
    expect(moved.length).toBeGreaterThan(2)
    for (const point of moved) {
      expect(Math.abs(point.y - trace.target.y)).toBeLessThan(.5)
      expect(point.x).toBeLessThanOrEqual(Math.max(trace.before.x, trace.target.x) + .5)
      expect(point.x).toBeGreaterThanOrEqual(Math.min(trace.before.x, trace.target.x) - .5)
    }
    expect(Math.abs(moved[0].x - trace.target.x)).toBeGreaterThan(1)
    await expectCaretAligned(page)
    expect(await text.evaluate((node) => node.editor.state.selection.head)).toBe(5)
  } finally { await input.detach() }
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  expect(await plain(text)).toBe('灯塔旁的一封信。')
})

test('输入法：行尾折行、第二行、页面滚动后，拼写框和光标都贴着文字', async ({ page }) => {
  const text = await ready(page, '')
  await text.evaluate((node) => {
    const { editor } = node
    editor.commands.setContent(Array.from({ length: 30 }, (_, index) => `<p>第 ${index + 1} 段：灯塔旁的海风吹过窗台。</p>`).join(''))
    const top = () => editor.view.coordsAtPos(editor.state.selection.head).top
    editor.commands.focus('end')
    const first = top()
    // Leave a few characters of room at the end of the last line.
    while (top() === first) editor.commands.insertContent('风')
    for (let i = 0; i < 4; i++) editor.commands.deleteRange({ from: editor.state.selection.head - 1, to: editor.state.selection.head })
  })
  await expectCaretAligned(page)
  const lineTop = () => text.evaluate((node) => document.querySelector('.writing-caret').getBoundingClientRect().top - node.getBoundingClientRect().top)
  const before = await lineTop()
  const bodyTop = () => text.evaluate((node) => node.getBoundingClientRect().top)
  const input = await ime(page)
  try {
    await input.compose('haifengchuiguochuangtai')
    // The reading no longer fits: it continues on, or moves to, the next line, and so does the caret.
    const rects = await expectReading(page, 'haifengchuiguochuangtai')
    expect(rects.at(-1).top - await bodyTop()).toBeGreaterThan(before + 5)
    expect(await lineTop()).toBeGreaterThan(before + 5)
    await input.commit('海风吹过窗台')
    await expect.poll(() => reading(page)).toBeNull()
    await expectCaretAligned(page)
    expect(await plain(text)).toMatch(/风风风海风吹过窗台$/)
    expect(await plain(text)).not.toMatch(/haifeng|\s海风/)

    // A paragraph further up, after scrolling the page.
    await text.evaluate((node) => {
      let pos = 0
      node.editor.state.doc.forEach((child, offset, index) => { if (index === 1) pos = offset + child.nodeSize - 1 })
      node.editor.commands.setTextSelection(pos)
    })
    await text.evaluate((node) => node.querySelectorAll('p')[1].scrollIntoView({ block: 'center', behavior: 'instant' }))
    await expectCaretAligned(page)
    await input.compose('yu')
    await expectReading(page, 'yu')
    await page.mouse.wheel(0, 120)
    await expectReading(page, 'yu')
    await input.commit('雨')
    await expect.poll(() => reading(page)).toBeNull()
    await expectCaretAligned(page)
    expect(await text.evaluate((node) => node.querySelectorAll('p')[1].textContent)).toBe('第 2 段：灯塔旁的海风吹过窗台。雨')
  } finally { await input.detach() }
})

test('输入法：取消、连续上屏、在已有选区上开始拼写，都不留框、不多空格、不吞字', async ({ page }) => {
  const text = await ready(page)
  const input = await ime(page)
  try {
    await input.compose('zhong')
    await expectReading(page, 'zhong')
    await input.cancel()
    await expect.poll(() => reading(page)).toBeNull()
    expect(await plain(text)).toBe('灯塔旁的一封信。')
    await expectCaretAligned(page)

    for (const [pinyin, word] of [['zhong', '中'], ['wen', '文'], ['xie', '写'], ['zuo', '作']]) {
      await input.compose(pinyin)
      await expectReading(page, pinyin)
      await input.commit(word)
      await expect.poll(() => reading(page)).toBeNull()
    }
    expect(await plain(text)).toBe('灯塔旁的一封信。中文写作')
    await expectCaretAligned(page)

    await text.evaluate((node) => node.editor.commands.setTextSelection({ from: 2, to: 4 }))
    await expect(caret(page)).toBeHidden()
    await input.compose('guang')
    await expectReading(page, 'guang')
    expect(await plain(text)).toBe('灯guang的一封信。中文写作')
    await input.commit('光')
    await expect.poll(() => reading(page)).toBeNull()
    expect(await plain(text)).toBe('灯光的一封信。中文写作')
    expect(await text.evaluate((node) => node.editor.state.selection.head)).toBe(3)
    await expectCaretAligned(page)
  } finally { await input.detach() }
})

/**
 * Engines without Chromium's IME channel: the same session played with CompositionEvent objects
 * while the reading is written into the text node, as an input method does.
 */
function composeInEditor(text, readings, final) {
  return text.evaluate(async (body, { readings, final }) => {
    const frame = () => new Promise(requestAnimationFrame)
    const selection = getSelection()
    let node = selection.focusNode
    // WebKit reports the end of a paragraph as a position in the element; use its text node.
    if (!(node instanceof Text)) {
      const before = node.childNodes[selection.focusOffset - 1]
      if (!(before instanceof Text)) throw new Error('No text before the caret')
      node = before
      selection.collapse(node, node.length)
    }
    const start = selection.focusOffset
    let length = 0
    const write = (reading, composing) => {
      node.replaceData(start, length, reading)
      length = reading.length
      selection.collapse(node, start + length)
      body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: reading, isComposing: composing }))
    }
    body.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    const states = []
    for (const reading of readings) {
      body.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: reading }))
      write(reading, true)
      await frame(); await frame()
      const highlight = CSS.highlights.get('typing-composition')
      const range = highlight && [...highlight][0]
      const cursor = document.querySelector('.writing-caret').getBoundingClientRect()
      const end = range?.getClientRects()[range.getClientRects().length - 1]
      states.push({ reading: range?.toString() ?? null, end: end?.right, caret: cursor.left })
    }
    body.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: final }))
    write(final, true)
    body.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: final }))
    await frame(); await frame()
    return { states, after: CSS.highlights.has('typing-composition') }
  }, { readings, final })
}

test('输入法（CompositionEvent）：正文拼写框随拼音更新，上屏后立刻消失 @webkit', async ({ page, browserName }) => {
  const text = await ready(page)
  const { states, after } = await composeInEditor(text, ['d', 'de', 'deng'], '灯')
  expect(states.map((state) => state.reading)).toEqual(['d', 'de', 'deng'])
  for (const state of states) expect(Math.abs(state.end - state.caret)).toBeLessThan(1.5 * 16 + 1)
  expect(after).toBe(false)
  await expect.poll(() => plain(text)).toBe('灯塔旁的一封信。灯')
  await expectCaretAligned(page)
  // Chromium already underlines a reading; elsewhere the box also gets a dashed underline.
  const decoration = await text.evaluate((node) => getComputedStyle(node.querySelector('p'), '::highlight(typing-composition)').textDecorationStyle)
  expect(decoration).toBe(browserName === 'chromium' ? 'solid' : 'dashed')
})

test.describe('触屏（iPhone 尺寸）@webkit', () => {
  test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })

  test('触屏正文打字时光标滑动，长按拖选时交给系统，拼写框仍生效', async ({ page }) => {
    await newWritingNovel(page)
    const text = chapterText(page)
    await text.fill('灯塔旁的一封信。')
    await text.evaluate((node) => node.editor.commands.focus('end'))
    await expectCaretAligned(page)
    const trace = await traceCaretMotion(page, () => page.keyboard.insertText('雾'))
    expectSmoothTrace(trace)
    expect(await text.evaluate((node) => getComputedStyle(node).caretColor)).toBe('rgba(0, 0, 0, 0)')

    // WebKit automation cannot render the OS magnifier. Drive the touch lifecycle and DOM
    // selection, then check the caret handoff in both directions.
    const touch = (type, x) => text.evaluate((node, { type, x }) => {
      if (type === 'touchmove') {
        const content = node.querySelector('p').firstChild
        getSelection().setBaseAndExtent(content, 0, content, 3)
      }
      const contact = { identifier: 1, target: node, clientX: x, clientY: 48 }
      const event = new Event(type, { bubbles: true })
      Object.defineProperties(event, {
        touches: { value: type === 'touchend' ? [] : [contact] },
        changedTouches: { value: [contact] },
      })
      node.dispatchEvent(event)
    }, { type, x })
    await touch('touchstart', 48)
    await expect(caret(page)).toBeHidden()
    await touch('touchmove', 96)
    expect(await text.evaluate((node) => getComputedStyle(node).caretColor)).not.toBe('rgba(0, 0, 0, 0)')
    await expect(caret(page)).toBeHidden()
    await touch('touchend', 96)
    await expect(caret(page)).toBeHidden()
    await text.evaluate((node) => node.editor.commands.focus('end'))
    await expectCaretAligned(page)
    expect(await text.evaluate((node) => getComputedStyle(node).caretColor)).toBe('rgba(0, 0, 0, 0)')
    const { states } = await composeInEditor(text, ['deng'], '灯')
    expect(states[0].reading).toBe('deng')
    await expect.poll(() => plain(text)).toBe('灯塔旁的一封信。雾灯')
  })

  test('触屏输入框保留平滑光标和拼写框', async ({ page }) => {
    await page.goto('/#/ideas')
    const box = page.getByRole('textbox', { name: '灵感', exact: true })
    await box.tap()
    await expect(box).toBeFocused()
    await expect(box).toHaveAttribute('data-typing-caret', '')
    expect(await box.evaluate((node) => getComputedStyle(node).caretColor)).toBe('rgba(0, 0, 0, 0)')
    await page.keyboard.insertText('雾里')
    await expect(page.locator('.typing-overlay .typing-caret')).toBeVisible()
    const { beginComposition, updateComposition, endComposition, readingBoxes, expectReadingBox } = await import('./typing-helpers.mjs')
    await beginComposition(box)
    await updateComposition(box, 'qiao')
    await expectReadingBox(page, box, 'qiao')
    await endComposition(box, '敲')
    await expect(readingBoxes(page)).toHaveCount(0)
    await expect(box).toHaveValue('雾里敲')
  })
})
