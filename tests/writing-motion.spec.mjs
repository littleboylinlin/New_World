import { expect, test } from './app-test.mjs'
import { pixel } from './fixtures.mjs'
import { caret, chapterText, expectCaretAligned, measureTyping, newWritingNovel, writingMotionFlow, setTypewriter, centerError, traceCaretMotion, expectBoundedTrace, expectSnapTrace } from './writing-motion-helpers.mjs'
import { chapterHeading, editorAction, saveNow } from './editor-helpers.mjs'

test.beforeEach(async ({ page }) => { await page.goto('/') })

test('平滑光标、选区、失焦、输入法、减少动态效果和打字机设置', async ({ page }) => {
  await writingMotionFlow(page)
})

test('快速输入时光标落后不超过 1.5 个字符宽度，滚动通知不中断追赶，停止后不跑循环', async ({ page }) => {
  await newWritingNovel(page)
  const text = chapterText(page)
  await text.fill('灯塔')
  await text.evaluate((node) => node.editor.commands.focus('end'))
  await expectCaretAligned(page)
  await page.evaluate(() => Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished)))
  const trace = await traceCaretMotion(page, async () => {
    await page.keyboard.insertText('i'.repeat(24))
    await page.evaluate(() => document.dispatchEvent(new Event('scroll')))
  })
  expect(Math.abs(trace.target.x - trace.before.x)).toBeGreaterThan(80)
  expectBoundedTrace(trace)
  await expect(caret(page)).toHaveCSS('transition-duration', '0s')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  const frames = await page.evaluate(async () => {
    const original = window.requestAnimationFrame
    let count = 0
    window.requestAnimationFrame = (...args) => { count++; return original(...args) }
    try { await new Promise((resolve) => setTimeout(resolve, 180)); return count }
    finally { window.requestAnimationFrame = original }
  })
  expect(frames).toBe(0)
})

for (const desktop of [false, true]) {
  test(`按住键连续输入并换行时光标瞬移且保持两行余量（${desktop ? '桌面滚动区' : '网页'}）`, async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 590 })
    if (desktop) await page.evaluate(() => document.documentElement.classList.add('desktop'))
    await newWritingNovel(page)
    const text = chapterText(page)
    await page.locator('#app-sidebar').evaluate((node) => Promise.all(node.getAnimations().map((a) => a.finished)))
    await text.fill('w'.repeat(650))
    await text.evaluate((node) => node.editor.commands.focus('end'))
    await expectCaretAligned(page)
    await page.keyboard.down('w')
    await expectCaretAligned(page)

    const sample = () => text.evaluate(async (node) => {
      await new Promise(requestAnimationFrame)
      const coords = node.editor.view.coordsAtPos(node.editor.state.selection.head)
      const paper = node.closest('.editor-paper')
      const cursor = paper.querySelector('.writing-caret')
      const rect = cursor.getBoundingClientRect()
      const footerTop = document.querySelector('.site-footer').getBoundingClientRect().top
      const toolbarBottom = document.querySelector('.editor-toolbar').getBoundingClientRect().bottom
      const margin = 2 * parseFloat(getComputedStyle(node).lineHeight)
      return {
        gap: Math.hypot(rect.left - coords.left, rect.top - coords.top),
        below: Math.min(footerTop, paper.getBoundingClientRect().bottom) - rect.bottom - margin,
        above: rect.top - toolbarBottom,
        scroll: document.scrollingElement.scrollTop + document.querySelector('#page').scrollTop + document.querySelector('.editor-scroll').scrollTop,
        head: node.editor.state.selection.head,
      }
    })
    const before = await sample()
    let last = before
    try {
      // Enough characters to wrap at least twice at this width, whether or not a scrollbar takes room.
      for (let i = 0; i < 110; i++) {
        await page.keyboard.down('w')
        last = await sample()
        expect(last.head).toBe(before.head + i + 1)
        expect(last.gap).toBeLessThan(1)
        expect(last.below).toBeGreaterThanOrEqual(-1)
        expect(last.above).toBeGreaterThanOrEqual(-1)
      }
    } finally {
      await page.keyboard.up('w')
    }
    expect(last.scroll - before.scroll).toBeGreaterThan(40)
    await expect(text.locator('p')).toHaveCount(1)
  })
}

test('点击、方向键、撤销重做和跨行跳转直接定位，不经过中间位置', async ({ page }) => {
  await newWritingNovel(page)
  const text = chapterText(page)
  await text.fill('灯塔旁的一封长信。')
  await text.evaluate((node) => node.editor.commands.focus('end'))
  await expectCaretAligned(page)
  await page.evaluate(() => Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished)))
  await text.evaluate((node) => node.scrollIntoView({ block: 'center' }))
  await expectCaretAligned(page)
  await text.evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'instant' }))
  await expectCaretAligned(page)
  expectSnapTrace(await traceCaretMotion(page, async () => {
    const point = await text.evaluate((node) => {
      const coords = node.editor.view.coordsAtPos(1), rect = node.getBoundingClientRect()
      return { x: coords.left - rect.left + 1, y: (coords.top + coords.bottom) / 2 - rect.top }
    })
    await text.click({ position: point })
  }))
  expectSnapTrace(await traceCaretMotion(page, () => page.keyboard.press('ArrowRight')))
  await text.evaluate((node) => node.editor.commands.focus('end'))
  await expectCaretAligned(page)
  expectSnapTrace(await traceCaretMotion(page, () => page.keyboard.press('Enter')))
  await page.keyboard.insertText('新段落')
  await expectCaretAligned(page)
  expectSnapTrace(await traceCaretMotion(page, () => text.evaluate((node) => node.editor.commands.undo())))
  expectSnapTrace(await traceCaretMotion(page, () => text.evaluate((node) => node.editor.commands.redo())))
})

test('光标随字号、主题、窗口缩放、字体、滚动、图片和表格布局变化同步，切章后清理', async ({ page }) => {
  await newWritingNovel(page)
  const text = chapterText(page)
  await text.evaluate((node) => {
    node.editor.commands.setContent('<p>正文</p><table><tbody><tr><td><p>表格</p></td></tr></tbody></table><h1>标题</h1>')
    node.editor.state.doc.descendants((child, pos) => { if (child.type.name === 'heading') node.editor.commands.setTextSelection(pos + 1) })
    node.editor.commands.focus()
  })
  await expectCaretAligned(page)
  const tall = await caret(page).evaluate((node) => node.getBoundingClientRect().height)
  await text.evaluate((node) => node.editor.commands.setTextSelection(2))
  await expectCaretAligned(page)
  expect(await caret(page).evaluate((node) => node.getBoundingClientRect().height)).toBeLessThan(tall)
  await page.getByRole('button', { name: '外观', exact: true }).click()
  const panel = page.getByRole('group', { name: '外观', exact: true })
  const originalColor = await caret(page).evaluate((node) => getComputedStyle(node, '::after').backgroundColor)
  await panel.getByRole('radio', { name: '黑色' }).check()
  expect(await caret(page).evaluate((node) => getComputedStyle(node, '::after').backgroundColor)).not.toBe(originalColor)
  await panel.getByRole('button', { name: '放大字号' }).click()
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await text.evaluate((node) => node.editor.commands.focus('end'))
  await expectCaretAligned(page)
  await page.setViewportSize({ width: 900, height: 700 })
  await expectCaretAligned(page)
  await text.evaluate((node) => { node.style.zoom = '1.2' })
  await expectCaretAligned(page)
  await page.evaluate(async () => {
    document.documentElement.dataset.latinFont = 'lora'
    await document.fonts.load('18px "New World Lora"')
    await document.fonts.ready
    document.querySelector('.novel-body td p').style.paddingBlock = '60px'
  })
  await expectCaretAligned(page)
  await text.evaluate((node, src) => {
    node.editor.commands.insertContentAt(0, { type: 'image', attrs: { src, alt: '布局插图' } })
    node.editor.commands.focus('end')
  }, `data:image/png;base64,${pixel.toString('base64')}`)
  await expect(text.locator('img')).toBeVisible()
  await expectCaretAligned(page)
  await text.evaluate((node) => { node.querySelector('img').style.height = '150px' })
  await expectCaretAligned(page)
  await page.mouse.wheel(0, 180)
  await expectCaretAligned(page)
  await page.getByRole('button', { name: '新建章节', exact: true }).click()
  await page.getByRole('textbox', { name: '章节名', exact: true }).fill('第二章')
  await page.getByRole('button', { name: '创建章节', exact: true }).click()
  await expect(chapterHeading(page)).toHaveText('第二章')
  await expect(caret(page)).toHaveCount(1)
  await editorAction(page, '阅读模式')
  await expect(caret(page)).toBeHidden()
  await page.goto('/#/')
  await expect(caret(page)).toHaveCount(0)
})

test('连续输入时统计和保存等待停笔，输入法期间不计数也不自动保存，手动保存立即生效', async ({ page }) => {
  await newWritingNovel(page)
  const text = chapterText(page)
  await text.evaluate((node) => node.editor.commands.focus('end'))
  await expectCaretAligned(page)
  await page.clock.install()
  for (const character of '灯塔旁') {
    await page.keyboard.insertText(character)
    await page.clock.runFor(200)
    await expect(page.locator('.word-count')).toHaveText('本章 0 字')
    await expect(page.locator('.save-status')).toHaveText('未保存')
  }
  await page.clock.runFor(210)
  await expect(page.locator('.word-count')).toHaveText('本章 3 字')
  await page.clock.runFor(100)
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await text.dispatchEvent('compositionstart', { data: '' })
  await text.evaluate((node) => node.editor.commands.insertContent('中文'))
  await page.clock.runFor(1000)
  await expect(page.locator('.word-count')).toHaveText('本章 3 字')
  await expect(page.locator('.save-status')).toHaveText('未保存')
  await text.dispatchEvent('compositionend', { data: '中文' })
  await page.clock.runFor(600)
  await expect(page.locator('.word-count')).toHaveText('本章 5 字')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await page.keyboard.insertText('信')
  await saveNow(page)
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await expect(page.locator('.word-count')).toHaveText('本章 6 字')
  await expect(page.locator('.chapter-words').first()).toHaveText('6')
  await page.reload()
  await expect(text).toHaveText('灯塔旁中文信')
})

test('停笔统计执行前切章，保存后的章节字数和全书字数仍正确', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await newWritingNovel(page)
  await page.getByRole('button', { name: '新建章节', exact: true }).click()
  await page.getByRole('textbox', { name: '章节名', exact: true }).fill('第二章')
  await page.getByRole('button', { name: '创建章节', exact: true }).click()
  await expect(chapterHeading(page)).toHaveText('第二章')
  await page.getByRole('button', { name: '第一章', exact: true }).click()
  await expect(chapterHeading(page)).toHaveText('第一章')
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await chapterText(page).evaluate((node) => {
    node.editor.commands.insertContent('灯塔')
    document.querySelectorAll('.chapter-jump')[1].click()
  })
  await expect(chapterHeading(page)).toHaveText('第二章')
  await expect(page.locator('.chapter-words')).toHaveText(['2', '0'])
  await expect(page.locator('.word-total')).toHaveText('全书 2 字')
})

test('打字机默认关闭，开关持久化；平滑滚动且不受光标布局同步干扰', async ({ page }) => {
  await newWritingNovel(page)
  await expect(page.locator('.editor-paper')).not.toHaveClass(/typewriter-writing/)
  await setTypewriter(page, true)
  await page.reload()
  await expect(page.locator('.editor-paper')).toHaveClass(/typewriter-writing/)
  const text = chapterText(page)
  await text.evaluate((node) => node.editor.commands.focus('end'))
  await expectCaretAligned(page)
  await page.keyboard.insertText('第一行')
  await expect.poll(() => centerError(page)).toBeLessThan(6)
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('第二行')
  await expect.poll(() => centerError(page)).toBeLessThan(6)
  await expectCaretAligned(page)
  await setTypewriter(page, false)
  await page.reload()
  await expect(page.locator('.editor-paper')).not.toHaveClass(/typewriter-writing/)
})

test('11.5 万字章节：连续 60 次输入的处理耗时，期间不扫描全文或序列化快照', async ({ page }, info) => {
  await newWritingNovel(page, '长章节')
  const result = await measureTyping(page)
  console.info('Typing performance:', JSON.stringify(result))
  await info.attach('typing-performance.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
  expect(result.fullCounts).toBe(0)
  expect(result.snapshots).toBe(0)
  expect(result.dispatch.median).toBeLessThan(16)
  expect(result.dispatch.p95).toBeLessThan(50)
  await expect(page.locator('.word-count')).toHaveText('本章 115,060 字')
  await expect(page.locator('.save-status')).toHaveText('已保存')
})
