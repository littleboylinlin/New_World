import { expect } from '@playwright/test'

export const chapterText = (page) => page.getByRole('textbox', { name: '章节正文', exact: true })
export const caret = (page) => page.locator('.writing-caret')

export async function newWritingNovel(page, title = '平滑写作') {
  await page.goto(new URL('#/original', page.url()).href)
  await page.getByRole('button', { name: '新建小说', exact: true }).click()
  await page.getByRole('textbox', { name: '作品名', exact: true }).fill(title)
  await page.getByRole('button', { name: '创建小说', exact: true }).click()
  await expect(chapterText(page)).toBeVisible()
}

export async function expectCaretAligned(page) {
  await expect(caret(page)).toBeVisible()
  await expect.poll(() => chapterText(page).evaluate((body) => {
    const { view, state } = body.editor
    const coords = view.coordsAtPos(state.selection.head)
    const rect = document.querySelector('.writing-caret').getBoundingClientRect()
    return Math.max(Math.abs(rect.left - coords.left), Math.abs(rect.top - coords.top), Math.abs(rect.height - (coords.bottom - coords.top)))
  })).toBeLessThan(2)
}

export async function setTypewriter(page, enabled) {
  await page.getByRole('link', { name: '设置', exact: true }).click()
  await page.locator('.settings-nav-item[data-category="appearance"]').click()
  const toggle = page.getByRole('checkbox', { name: '打字机模式', exact: true })
  await toggle.setChecked(enabled)
  await page.locator('.settings-back').click()
  await expect(chapterText(page)).toBeVisible()
}

export async function centerError(page) {
  return chapterText(page).evaluate((body) => {
    let scroller = body.parentElement.parentElement
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    const rect = scroller?.getBoundingClientRect()
    const toolbar = document.querySelector('.editor-tools-row')
    const top = (rect ? rect.top + scroller.clientTop : 0) + toolbar.offsetHeight
    const bottom = rect ? rect.top + scroller.clientTop + scroller.clientHeight : innerHeight
    const coords = body.editor.view.coordsAtPos(body.editor.state.selection.head)
    return Math.abs((coords.top + coords.bottom - top - bottom) / 2)
  })
}

/** Shared assertions run against Chromium and the installed Windows/macOS apps. */
export async function writingMotionFlow(page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await newWritingNovel(page)
  const text = chapterText(page)
  await text.fill('灯塔旁的一封信。')
  await text.evaluate((node) => node.editor.commands.focus('end'))
  await expectCaretAligned(page)
  await expect(text).toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)')
  await page.evaluate(() => Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished)))
  const before = await caret(page).evaluate((node) => node.style.transform)
  await page.keyboard.insertText('夜')
  await expectCaretAligned(page)
  expect(await caret(page).evaluate((node) => node.style.transform)).not.toBe(before)
  await expect(caret(page)).toHaveCSS('transition-duration', '0.075s')
  await text.evaluate((node) => node.editor.commands.setTextSelection({ from: 1, to: 3 }))
  await expect(caret(page)).toBeHidden()
  await text.evaluate((node) => node.editor.commands.focus('end'))
  await expectCaretAligned(page)
  await page.getByRole('button', { name: '手动保存', exact: true }).focus()
  await expect(caret(page)).toBeHidden()
  await text.evaluate((node) => node.editor.commands.focus('end'))
  await expectCaretAligned(page)

  const committed = await caret(page).evaluate((node) => node.style.transform)
  await text.dispatchEvent('compositionstart', { data: '' })
  await text.evaluate((node) => node.editor.commands.insertContent('中文'))
  await expect(text).toContainText('中文')
  await page.waitForTimeout(550)
  expect(await caret(page).evaluate((node) => node.style.transform)).toBe(committed)
  await text.dispatchEvent('compositionend', { data: '中文' })
  await expectCaretAligned(page)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.keyboard.insertText('字')
  await expectCaretAligned(page)
  await expect(caret(page)).toHaveCSS('transition-duration', '0s')
  await setTypewriter(page, true)
  await expect(page.locator('.editor-paper')).toHaveClass(/typewriter-writing/)
  await text.evaluate((node) => node.editor.commands.focus('end'))
  await expectCaretAligned(page)
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('居中的下一行')
  await expect.poll(() => centerError(page)).toBeLessThan(6)
  await expectCaretAligned(page)
  // Wheel browsing must not be followed by an automatic return to the caret.
  await text.hover()
  await page.mouse.wheel(0, -160)
  await expect.poll(() => centerError(page)).toBeGreaterThan(70)
  const browsed = await centerError(page)
  await page.waitForTimeout(550)
  expect(Math.abs(await centerError(page) - browsed)).toBeLessThan(3)
  expect(await text.evaluate((node) => node.editor.view.hasFocus())).toBe(true)
  await page.keyboard.insertText('继续')
  await expect.poll(() => centerError(page)).toBeLessThan(6)
  await setTypewriter(page, false)
  await expect(page.locator('.editor-paper')).not.toHaveClass(/typewriter-writing/)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
}

/** Measures complete dispatches and their following frame work with a 115,000-character chapter. */
export async function measureTyping(page) {
  const text = chapterText(page)
  await text.evaluate((node) => {
    const paragraph = '灯塔旁的海风吹过窗台，守望者继续写下一封长信。'.repeat(5)
    node.editor.commands.setContent({ type: 'doc', content: Array.from({ length: 1000 }, () => ({
      type: 'paragraph', content: [{ type: 'text', text: paragraph }],
    })) })
    node.editor.commands.focus('end')
  })
  await expect(page.locator('.word-count')).toHaveText('本章 115,000 字')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  return text.evaluate(async (node) => {
    const editor = node.editor
    const prototype = Object.getPrototypeOf(editor.state.doc)
    const originalText = prototype.textBetween, originalJSON = prototype.toJSON
    let fullCounts = 0, snapshots = 0
    prototype.textBetween = function (...args) {
      if (this.type.name === 'doc' && args[0] === 0 && args[1] === this.content.size) fullCounts++
      return originalText.apply(this, args)
    }
    prototype.toJSON = function (...args) {
      if (this.type.name === 'doc') snapshots++
      return originalJSON.apply(this, args)
    }
    const dispatches = [], frames = []
    try {
      for (let i = 0; i < 60; i++) {
        const start = performance.now()
        editor.view.dispatch(editor.state.tr.insertText('字'))
        dispatches.push(performance.now() - start)
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        frames.push(performance.now() - start)
      }
      const stats = (values) => {
        const sorted = values.toSorted((a, b) => a - b)
        return { median: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) }
      }
      return { characters: 115000, samples: dispatches.length, dispatch: stats(dispatches), frames: stats(frames), fullCounts, snapshots }
    } finally {
      prototype.textBetween = originalText
      prototype.toJSON = originalJSON
    }
  })
}
