import { expect, test } from './app-test.mjs'
import { startWork } from './navigation-helpers.mjs'
import { annotationNovel, selectReading } from './annotation-helpers.mjs'
import { chapterText, newWritingNovel } from './writing-motion-helpers.mjs'
import {
  beginComposition, composeInField, endComposition, expectCaretAtReadingEnd, expectFieldCaretAligned, expectFieldTyping, expectReadingBox,
  fieldCaret, readingBoxes, settleFieldCaret, updateComposition,
} from './typing-helpers.mjs'

test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'no-preference' }) })

async function quickTask(page, title) {
  await page.goto('/#/notes/tasks')
  await page.getByRole('textbox', { name: '快速添加任务', exact: true }).fill(title)
  await page.locator('.task-quick').getByRole('button', { name: '添加任务', exact: true }).click()
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible()
}

test('接入点：灵感页的新建框、正文搜索框和 Ctrl+Alt+N 弹窗 @webkit', async ({ page }) => {
  await page.goto('/#/ideas')
  await expectFieldTyping(page, page.getByRole('textbox', { name: '灵感', exact: true }))
  await expectFieldTyping(page, page.getByLabel('搜索灵感正文'))
  await page.keyboard.press('Control+Alt+n')
  const dialog = page.getByRole('dialog', { name: '记灵感' })
  await expect(dialog).toBeVisible()
  // The dialog is in the top layer; the overlay must be drawn inside it to stay visible.
  await expectFieldTyping(page, dialog.getByRole('textbox', { name: '灵感', exact: true }))
  expect(await page.locator('.typing-overlay').evaluate((node) => !!node.closest('dialog'))).toBe(true)
})

test('接入点：桌面速记小窗的灵感和提醒两种模式 @webkit', async ({ page }) => {
  await page.addInitScript(() => {
    window.newWorldDesktop = { hideCapture: () => {}, onCaptureShown: () => {} }
  })
  await page.goto('/#/capture')
  const idea = page.getByRole('textbox', { name: '灵感', exact: true })
  await expect(idea).toBeFocused()
  await expectFieldTyping(page, idea)
  await page.getByRole('button', { name: '提醒', exact: true }).click()
  await expectFieldTyping(page, page.getByRole('textbox', { name: '想提醒自己做什么？' }))
  // Date and time pickers stay native.
  await page.getByLabel('计划日期').focus()
  await expect(page.locator('.typing-overlay')).toHaveCount(0)
  await expect(page.getByLabel('计划日期')).not.toHaveAttribute('data-typing-caret')
})

test('接入点：任务的快速添加、标题、描述、评论和搜索 @webkit', async ({ page }) => {
  await quickTask(page, '写第一章')
  await expectFieldTyping(page, page.getByRole('textbox', { name: '快速添加任务', exact: true }))
  await page.getByRole('searchbox', { name: '搜索任务', exact: true }).fill('')
  await expectFieldTyping(page, page.getByRole('searchbox', { name: '搜索任务', exact: true }))
  await page.getByRole('searchbox', { name: '搜索任务', exact: true }).fill('')
  await page.getByRole('button', { name: '写第一章', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑任务', exact: true })
  await expectFieldTyping(page, dialog.getByLabel('任务标题', { exact: true }))
  await expectFieldTyping(page, dialog.getByLabel('任务描述', { exact: true }))
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '评论与附件', exact: true }).first().click()
  const extras = page.getByRole('dialog', { name: '评论与附件', exact: true })
  await extras.getByRole('button', { name: '添加评论', exact: true }).click()
  await expectFieldTyping(page, page.getByRole('dialog', { name: '添加评论', exact: true }).getByLabel('评论内容', { exact: true }))
})

test('接入点：新建作品时的作品名和作品信息、重命名框、书名搜索 @webkit', async ({ page }) => {
  await page.goto('/#/original')
  await startWork(page)
  const form = page.getByRole('dialog')
  await expectFieldTyping(page, form.getByLabel('作品名', { exact: true }))
  await expectFieldTyping(page, form.getByLabel('作者', { exact: true }))
  await expectFieldTyping(page, form.getByLabel('作品简介', { exact: true }))
  await form.getByLabel('作品名', { exact: true }).fill('雾港')
  await form.getByRole('button', { name: '创建小说', exact: true }).click()
  await expect(chapterText(page)).toBeVisible()
  await page.goto('/#/original')
  await expectFieldTyping(page, page.getByRole('searchbox', { name: '搜索书名', exact: true }))
  await page.getByRole('searchbox', { name: '搜索书名', exact: true }).fill('')
  await page.locator('.book-card').filter({ hasText: '雾港' }).locator('.book-menu-toggle').click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  await expectFieldTyping(page, page.getByRole('dialog').getByLabel('作品名', { exact: true }))
})

test('接入点：编辑器的查找替换 @webkit', async ({ page }) => {
  await page.goto('/')
  await newWritingNovel(page)
  await chapterText(page).fill('灯塔旁的一封信。')
  await page.getByRole('button', { name: '查找／替换' }).click()
  await expectFieldTyping(page, page.getByRole('searchbox', { name: '查找文字' }))
  await expectFieldTyping(page, page.getByRole('textbox', { name: '替换为' }))
})

test('接入点：阅读模式里添加批注 @webkit', async ({ page }) => {
  await annotationNovel(page)
  await selectReading(page, 0, 4)
  await page.getByRole('button', { name: '添加批注', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加批注' })
  await expectFieldTyping(page, dialog.getByLabel('批注内容'))
})

test('接入点：设置里的 AI 配置名称和词典链接 @webkit', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { enabled: false, port: 47291, bridge: { running: false, port: 47291, error: null }, clients: [] }
    window.newWorldDesktop = {
      platform: 'win32', arch: 'x64', onUpdateProgress: () => {}, onCloseRequested: () => {},
      minimizeWindow: () => {}, toggleMaximizeWindow: () => {}, closeWindow: () => {},
      isMaximized: async () => false, onMaximizeChange: () => {},
      getStorageLocation: async () => ({ path: 'C:\\书库', defaultPath: 'C:\\书库', custom: false }),
      getCloseBehavior: async () => 'quit', setCloseBehavior: async (mode) => mode,
      getAiState: async () => state, listAiAudit: async () => [],
      getSpellingDictionaries: async () => ({ supported: true, bundled: ['en-US'], added: [] }),
    }
  })
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto('/#/settings/ai')
  await expectFieldTyping(page, page.locator('.settings-panel[data-category="ai"]').getByLabel('AI 配置名称'))
  await page.locator('.settings-nav-item[data-category="appearance"]').click()
  await expectFieldTyping(page, page.getByLabel('或从链接下载'), { text: 'https://a' })
})

test('连打时输入框里的光标在滑但落后不超过 1.5 个字符，停手后 150ms 内到位，长按和跳转直接到位 @webkit', async ({ page }) => {
  await page.goto('/#/ideas')
  const box = page.getByRole('textbox', { name: '灵感', exact: true })
  await box.click()
  const result = await box.evaluate(async (node) => {
    const caret = document.querySelector('.typing-overlay .typing-caret')
    const style = getComputedStyle(node)
    const textWidth = (text) => { const span = document.createElement('span'); span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'; for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'letterSpacing', 'fontKerning', 'fontFeatureSettings', 'textTransform']) span.style[name] = style[name]; span.textContent = text; document.body.append(span); const width = span.getBoundingClientRect().width; span.remove(); return width }
    const goal = () => {
      const rect = node.getBoundingClientRect()
      return rect.left + node.clientLeft + parseFloat(style.paddingLeft) + textWidth(node.value.slice(0, node.selectionEnd))
    }
    const samples = []
    let typing = true, last = 0
    // Read what the frame painted; skip frames where a key arrived after the frame was laid out.
    const watch = (frame) => setTimeout(() => {
      const gap = Math.abs(caret.getBoundingClientRect().left - goal())
      if (last <= frame) samples.push({ now: performance.now(), typing, gap, left: caret.getBoundingClientRect().left, width: textWidth(node.value.slice(node.selectionEnd - 1, node.selectionEnd)) })
      if (typing || samples.length < 2 || performance.now() - last < 300) requestAnimationFrame(watch)
    })
    requestAnimationFrame(watch)
    for (const character of '雾里有人在敲钟wwmm') {
      document.execCommand('insertText', false, character)
      last = performance.now()
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    typing = false
    await new Promise((resolve) => setTimeout(resolve, 400))
    // Arrived: the first frame from which the caret no longer moves.
    const final = samples.at(-1).left
    const settled = samples.find((sample, index) => sample.now > last && samples.slice(index).every((later) => Math.abs(later.left - final) < .1))
    return { samples, settledAfter: settled ? settled.now - last : Infinity, finalGap: samples.at(-1).gap }
  })
  const typing = result.samples.filter((sample) => sample.typing)
  expect(typing.filter((sample) => sample.gap > 1).length).toBeGreaterThan(typing.length / 3)
  // WebKit sometimes paints a frame late or skips one, so a few pixels and frames of slack: the
  // caret still trails by at most about one and a half characters and settles well within 0.25 s.
  for (const sample of result.samples) expect(sample.gap).toBeLessThanOrEqual(1.5 * sample.width + 3)
  expect(result.settledAfter).toBeLessThanOrEqual(150 + 5 * 17)
  expect(result.finalGap).toBeLessThan(1)

  // Jumps, holding a key and reduced motion all land at once.
  const snaps = async (action) => {
    await settleFieldCaret(page)
    const trace = await fieldCaret(page).evaluate((node) => {
      const samples = []
      const observer = new MutationObserver(() => samples.push(node.getBoundingClientRect().left))
      observer.observe(node, { attributes: true, attributeFilter: ['style'] })
      node.trace = { samples, observer, before: node.getBoundingClientRect().left }
    })
    await action()
    await expectFieldCaretAligned(page, box)
    const { samples, before } = await fieldCaret(page).evaluate((node) => { node.trace.observer.disconnect(); return node.trace })
    const final = samples.at(-1) ?? before
    for (const x of samples.filter((x) => Math.abs(x - before) > 1)) expect(Math.abs(x - final)).toBeLessThan(1)
    return trace
  }
  await snaps(() => page.keyboard.press('Home'))
  await snaps(() => page.keyboard.press('End'))
  await snaps(() => page.keyboard.press('ArrowLeft'))
  await page.keyboard.press('End')
  await page.keyboard.down('w')
  for (let i = 0; i < 3; i++) await snaps(() => page.keyboard.down('w'))
  await page.keyboard.up('w')
  await page.keyboard.down('Backspace')
  for (let i = 0; i < 3; i++) await snaps(() => page.keyboard.down('Backspace'))
  await page.keyboard.up('Backspace')
  await snaps(() => box.evaluate((node) => { node.setRangeText('粘贴', 0, 0, 'end'); node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' })) }))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await snaps(() => page.keyboard.insertText('灯塔'))
  await page.keyboard.press('Control+a')
  await expect(fieldCaret(page)).toBeHidden()
})

test('多行输入框：自然折行像回车一样下滑，行尾折行和第二行的拼写框贴着文字 @webkit', async ({ page }) => {
  await page.goto('/#/ideas')
  const box = page.getByRole('textbox', { name: '灵感', exact: true })
  await box.click()
  // Fill the first line until one more character wraps.
  await box.evaluate((node) => {
    const style = getComputedStyle(node)
    const textWidth = (text) => { const span = document.createElement('span'); span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'; for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'letterSpacing', 'fontKerning', 'fontFeatureSettings', 'textTransform']) span.style[name] = style[name]; span.textContent = text; document.body.append(span); const width = span.getBoundingClientRect().width; span.remove(); return width }
    const room = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    let text = ''
    while (textWidth(text + '雾雾') < room) text += '雾'
    node.value = text
    node.setSelectionRange(text.length, text.length)
    node.dispatchEvent(new Event('select'))
  })
  await expectFieldCaretAligned(page, box)
  await settleFieldCaret(page)
  const trace = await fieldCaret(page).evaluate(async (node) => {
    const read = () => { const rect = node.getBoundingClientRect(); return { x: rect.left, y: rect.top } }
    const before = read(), samples = []
    const observer = new MutationObserver(() => samples.push(read()))
    observer.observe(node, { attributes: true, attributeFilter: ['style'] })
    document.execCommand('insertText', false, '雾雾')
    await new Promise((resolve) => setTimeout(resolve, 300))
    observer.disconnect()
    return { before, samples, after: read() }
  })
  expect(trace.after.y - trace.before.y).toBeGreaterThan(10)
  expect(trace.after.x).toBeLessThan(trace.before.x - 100)
  const moved = trace.samples.filter((point) => Math.hypot(point.x - trace.before.x, point.y - trace.before.y) > .5)
  expect(moved.length).toBeGreaterThan(2)
  for (const point of moved) {
    expect(Math.abs(point.x - trace.after.x)).toBeLessThan(1.5)
    expect(point.y).toBeLessThanOrEqual(trace.after.y + .01)
  }
  expect(moved.some((point) => point.y < trace.after.y - 2)).toBe(true)

  // A reading that runs past the end of the line wraps with the text, as one box per line.
  // Two characters before the end of the first line.
  await box.evaluate((node) => { node.setSelectionRange(node.value.length - 4, node.value.length - 4) })
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowLeft')
  await beginComposition(box)
  const firstLine = await box.evaluate((node) => node.getBoundingClientRect().top + node.clientTop + parseFloat(getComputedStyle(node).paddingTop))
  await updateComposition(box, 'haifengchuiguochuangtaiyoujianfengchuiguochuangtai')
  // Too long for what is left of the line: the reading continues on, or moves to, the next line.
  await expect.poll(async () => (await readingBoxes(page).last().boundingBox())?.y ?? 0).toBeGreaterThan(firstLine + 10)
  await expectCaretAtReadingEnd(page)
  await endComposition(box, '海风')
  await expect(readingBoxes(page)).toHaveCount(0)
  expect(await box.inputValue()).toMatch(/雾海风雾雾雾雾$/)

  // On the second line, after the page scrolls.
  await page.keyboard.press('Control+End')
  await page.evaluate(() => scrollBy(0, 40))
  await beginComposition(box)
  await updateComposition(box, 'deng')
  await expectReadingBox(page, box, 'deng')
  await endComposition(box, '灯')
  await expect(readingBoxes(page)).toHaveCount(0)
  expect(await box.inputValue()).toMatch(/雾海风雾雾雾雾灯$/)
})

test('输入框组合输入：行中、连续上屏、取消、在选区上开始，值和光标都对 @webkit', async ({ page }) => {
  await page.goto('/#/ideas')
  const field = page.getByLabel('搜索灵感正文')
  await field.click()
  await page.keyboard.insertText('灯塔旁的信')
  // In the middle of the text.
  await field.evaluate((node) => node.setSelectionRange(2, 2))
  await expectFieldCaretAligned(page, field)
  let states = await composeInField(field, ['p', 'pa', 'pang'], '旁')
  expect(states.map((state) => state.value)).toEqual(['灯塔p旁的信', '灯塔pa旁的信', '灯塔pang旁的信'])
  for (const state of states) {
    expect(state.boxes.length).toBe(1)
    // The box ends exactly at the reading's end; the drawn caret is never far behind.
    expect(Math.abs(state.boxes[0].right - state.native)).toBeLessThan(1.5)
    expect(Math.abs(state.caret.x - state.native)).toBeLessThan(1.5 * 16 + 1)
  }
  await expect(readingBoxes(page)).toHaveCount(0)
  await expect(field).toHaveValue('灯塔旁旁的信')
  expect(await field.evaluate((node) => node.selectionEnd)).toBe(3)
  await expectFieldCaretAligned(page, field)
  // One after another.
  await page.keyboard.press('End')
  for (const [reading, word] of [['zhong', '中'], ['wen', '文']]) {
    await composeInField(field, [reading], word)
    await expect(readingBoxes(page)).toHaveCount(0)
  }
  await expect(field).toHaveValue('灯塔旁旁的信中文')
  // Cancelled.
  states = await composeInField(field, ['x', 'xie'], '')
  expect(states.at(-1).boxes.length).toBe(1)
  await expect(readingBoxes(page)).toHaveCount(0)
  await expect(field).toHaveValue('灯塔旁旁的信中文')
  await expectFieldCaretAligned(page, field)
  // Over a selection: the reading replaces it.
  await field.evaluate((node) => node.setSelectionRange(1, 4))
  await expect(fieldCaret(page)).toBeHidden()
  states = await composeInField(field, ['guang'], '光')
  expect(states[0].value).toBe('灯guang的信中文')
  expect(states[0].boxes.length).toBe(1)
  await expect(field).toHaveValue('灯光的信中文')
  expect(await field.evaluate((node) => node.selectionEnd)).toBe(2)
  await expectFieldCaretAligned(page, field)
})

test('输入框的覆盖层不挡住点击、选中、复制粘贴和拖拽，失焦后清理 @webkit', async ({ page, context, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/#/ideas')
  const box = page.getByRole('textbox', { name: '灵感', exact: true })
  await box.click()
  await page.keyboard.insertText('雾里有人在敲钟')
  await expect(page.locator('.typing-overlay')).toHaveCount(1)
  await expect(page.locator('.typing-overlay')).toHaveAttribute('aria-hidden', 'true')
  expect(await page.locator('.typing-overlay').evaluate((node) => getComputedStyle(node).pointerEvents)).toBe('none')
  // A click on the caret itself still reaches the field and places the caret there.
  const caretBox = await fieldCaret(page).boundingBox()
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('aria-label'), { x: caretBox.x + 1, y: caretBox.y + caretBox.height / 2 })
  expect(hit).toBe('灵感')
  await box.dblclick({ position: { x: 30, y: 16 } })
  expect(await box.evaluate((node) => node.selectionEnd - node.selectionStart)).toBeGreaterThan(0)
  await expect(fieldCaret(page)).toBeHidden()
  await page.keyboard.press('End')
  await box.blur()
  await expect(page.locator('.typing-overlay')).toHaveCount(0)
  await expect(box).not.toHaveAttribute('data-typing-caret')
})
