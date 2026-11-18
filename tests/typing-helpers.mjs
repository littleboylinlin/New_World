import { expect } from '@playwright/test'

/** The smooth caret drawn over the focused native field. */
export const fieldCaret = (page) => page.locator('.typing-overlay .typing-caret')
export const readingBoxes = (page) => page.locator('.typing-overlay .typing-composition-box')

/**
 * Where the native caret of a single-line field really is, measured with the field's own font
 * in a plain span, so the check does not share any code with the overlay it verifies.
 */
export function nativeFieldCaret(field) {
  return field.evaluate((node) => {
    const style = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    const textWidth = (text) => { const span = document.createElement('span'); span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'; for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'letterSpacing', 'fontKerning', 'fontFeatureSettings', 'textTransform']) span.style[name] = style[name]; span.textContent = text; document.body.append(span); const width = span.getBoundingClientRect().width; span.remove(); return width }
    const caret = node.selectionDirection === 'backward' ? node.selectionStart : node.selectionEnd
    const value = node.value
    const lineStart = node instanceof HTMLTextAreaElement ? value.lastIndexOf('\n', caret - 1) + 1 : 0
    const width = textWidth(value.slice(lineStart, caret))
    return {
      x: rect.left + node.clientLeft + parseFloat(style.paddingLeft) + width - node.scrollLeft,
      top: rect.top + node.clientTop,
      bottom: rect.top + node.clientTop + node.clientHeight,
      fontSize: parseFloat(style.fontSize),
    }
  })
}

export async function expectFieldCaretAligned(page, field) {
  await expect(fieldCaret(page)).toBeVisible()
  await expect.poll(async () => {
    const expected = await nativeFieldCaret(field)
    const box = await fieldCaret(page).boundingBox()
    if (!box) return Infinity
    // The caret is two pixels wide and centred on the boundary between characters.
    const horizontal = Math.abs(box.x - expected.x)
    const vertical = box.y < expected.top - 1 || box.y + box.height > expected.bottom + 1 ? Infinity : 0
    const height = box.height < expected.fontSize * .8 ? Infinity : 0
    return horizontal + vertical + height
  }).toBeLessThan(1.5)
}

/** Waits until neither the caret nor any animation it depends on is moving. */
export async function settleFieldCaret(page) {
  await fieldCaret(page).evaluate(async (node) => {
    let stable = 0
    for (let i = 0; i < 60 && stable < 3; i++) {
      const before = node.style.transform
      await new Promise(requestAnimationFrame)
      stable = node.style.transform === before ? stable + 1 : 0
    }
  })
}

/**
 * Plays an input-method session with real CompositionEvent objects: compositionstart, then
 * compositionupdate and an isComposing input for each reading, then the final text and
 * compositionend. An empty final text cancels, like pressing Esc in the candidate window.
 * Each step waits for a frame, as an input method would between key presses.
 */
export function composeInField(field, readings, final) {
  return field.evaluate(async (node, { readings, final }) => {
    const frame = () => new Promise(requestAnimationFrame)
    const start = Math.min(node.selectionStart, node.selectionEnd)
    let end = Math.max(node.selectionStart, node.selectionEnd)
    const replace = (text, type, composing) => {
      node.setRangeText(text, start, end, 'end')
      end = start + text.length
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: type, data: text, isComposing: composing }))
    }
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    const states = []
    for (const reading of readings) {
      node.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: reading }))
      replace(reading, 'insertCompositionText', true)
      await frame(); await frame()
      states.push(readState(node))
    }
    if (final !== undefined) {
      node.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: final }))
      replace(final, 'insertCompositionText', true)
      node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: final }))
    }
    return states

    function readState(field) {
      const caret = document.querySelector('.typing-overlay .typing-caret')
      const boxes = [...document.querySelectorAll('.typing-overlay .typing-composition-box')].map((box) => box.getBoundingClientRect().toJSON())
      // Where the native caret is on a single line, measured independently in a plain span.
      const style = getComputedStyle(field), rect = field.getBoundingClientRect()
      const textWidth = (text) => { const span = document.createElement('span'); span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'; for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'letterSpacing', 'fontKerning', 'fontFeatureSettings', 'textTransform']) span.style[name] = style[name]; span.textContent = text; document.body.append(span); const width = span.getBoundingClientRect().width; span.remove(); return width }
      const native = rect.left + field.clientLeft + parseFloat(style.paddingLeft) + textWidth(field.value.slice(0, field.selectionEnd)) - field.scrollLeft
      return { value: field.value, caret: caret && !caret.hidden ? caret.getBoundingClientRect().toJSON() : null, native, boxes }
    }
  }, { readings, final })
}

/** Starts a composition that is left open, for the steps a test checks in between. */
export function beginComposition(field) {
  return field.evaluate((node) => {
    node.compositionStart = Math.min(node.selectionStart, node.selectionEnd)
    node.compositionEnd = Math.max(node.selectionStart, node.selectionEnd)
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
  })
}

export function updateComposition(field, reading) {
  return field.evaluate((node, reading) => {
    node.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: reading }))
    node.setRangeText(reading, node.compositionStart, node.compositionEnd, 'end')
    node.compositionEnd = node.compositionStart + reading.length
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: reading, isComposing: true }))
  }, reading)
}

export function endComposition(field, final) {
  return field.evaluate((node, final) => {
    node.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: final }))
    node.setRangeText(final, node.compositionStart, node.compositionEnd, 'end')
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: final, isComposing: true }))
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: final }))
  }, final)
}

/** After a wrapped reading, the caret settles where the last line of the reading box ends. */
export async function expectCaretAtReadingEnd(page) {
  await expect.poll(async () => {
    const last = await readingBoxes(page).last().boundingBox()
    const caret = await fieldCaret(page).boundingBox()
    if (!last || !caret) return Infinity
    return Math.abs(last.x + last.width - caret.x) + Math.abs(last.y + last.height / 2 - (caret.y + caret.height / 2))
  }).toBeLessThan(2)
}

/** The reading box must sit on the reading: ending at the caret and as wide as the text. */
export async function expectReadingBox(page, field, reading) {
  await expect(readingBoxes(page).first()).toBeVisible()
  await expect.poll(async () => {
    const boxes = await readingBoxes(page).evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()))
    const caret = await fieldCaret(page).boundingBox()
    const width = await field.evaluate((node, reading) => {
      const style = getComputedStyle(node)
      const textWidth = (text) => { const span = document.createElement('span'); span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'; for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'letterSpacing', 'fontKerning', 'fontFeatureSettings', 'textTransform']) span.style[name] = style[name]; span.textContent = text; document.body.append(span); const width = span.getBoundingClientRect().width; span.remove(); return width }
      return textWidth(reading)
    }, reading)
    const total = boxes.reduce((sum, box) => sum + box.width, 0)
    const last = boxes.at(-1)
    const errors = [Math.abs(total - width)]
    if (caret) errors.push(Math.abs(last.right - caret.x), Math.abs(last.top - caret.y) > caret.height ? Infinity : 0)
    return Math.max(...errors)
  }).toBeLessThan(2)
}

/** Shared checks for one place where people type: caret, reading box, commit and cancel. */
export async function expectFieldTyping(page, field, { text = '灯a' } = {}) {
  await field.click()
  await expect(field).toBeFocused()
  await expect(field).toHaveAttribute('data-typing-caret', '')
  await expect(field).toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)')
  const before = await field.inputValue()
  await page.keyboard.press('End')
  await page.keyboard.insertText(text)
  await expectFieldCaretAligned(page, field)
  await beginComposition(field)
  await updateComposition(field, 'deng')
  await expectReadingBox(page, field, 'deng')
  await expectFieldCaretAligned(page, field)
  await endComposition(field, '灯')
  await expect(readingBoxes(page)).toHaveCount(0)
  await expect(field).toHaveValue(before + text + '灯')
  await expectFieldCaretAligned(page, field)
  await beginComposition(field)
  await updateComposition(field, 'ta')
  await expectReadingBox(page, field, 'ta')
  await endComposition(field, '')
  await expect(readingBoxes(page)).toHaveCount(0)
  await expect(field).toHaveValue(before + text + '灯')
  await expectFieldCaretAligned(page, field)
}
