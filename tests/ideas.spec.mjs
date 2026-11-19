import { startWork, chooseImportType } from './navigation-helpers.mjs'
import { expect, test } from './app-test.mjs'
import { saveNow } from './editor-helpers.mjs'
import { file } from './fixtures.mjs'

const textArea = (page) => page.getByRole('textbox', { name: '章节正文' })
const ideaList = (page) => page.getByRole('list', { name: '灵感列表' })
const ideaRow = (page, text) => ideaList(page).getByRole('listitem').filter({ hasText: text })

async function newNovel(page, name, text) {
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill(name)
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(textArea(page)).toBeVisible()
  if (text) {
    await textArea(page).fill(text)
    await saveNow(page)
    await expect(page.locator('.save-status')).toHaveText('已保存')
  }
}

test('灵感页可以记下、标记已用、关联作品、删除和撤销', async ({ page }, testInfo) => {
  await page.goto('/#/')
  await page.getByRole('link', { name: '灵感与任务', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: '灵感与任务' })).toBeVisible()
  await expect(page.getByText('还没有灵感')).toBeVisible()

  const box = page.getByRole('textbox', { name: '灵感' })
  await box.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: '先写点什么再保存吧。' })).toBeVisible()
  await box.fill('雾里有人在敲钟')
  await box.press('Shift+Enter')
  await box.pressSequentially('钟声是倒着响的')
  await box.press('Enter')
  await expect(box).toHaveValue('')
  await expect(ideaRow(page, '雾里有人在敲钟').locator('.idea-text')).toHaveText('雾里有人在敲钟\n钟声是倒着响的')
  await expect(ideaRow(page, '雾里有人在敲钟')).toContainText('未关联')
  await box.fill('灯塔守望者其实是鸟')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  // Newest first.
  await expect(ideaList(page).locator('.idea-text').first()).toHaveText('灯塔守望者其实是鸟')
  await page.screenshot({ path: testInfo.outputPath('ideas-page.png') })

  // The arrow opens the actions; marking one used moves it below.
  const first = ideaRow(page, '灯塔守望者其实是鸟')
  await first.getByRole('button', { name: '灵感操作' }).click()
  const menu = page.getByRole('menu', { name: '灵感操作' })
  await expect(menu.getByRole('menuitem')).toHaveText(['标记已用', '关联作品…', '将灵感转换为任务', '复制', '删除'])
  await menu.getByRole('menuitem', { name: '标记已用' }).click()
  await expect(first).toContainText('已用')
  await expect(ideaList(page).locator('.idea-text').last()).toHaveText('灯塔守望者其实是鸟')

  // Right click offers the same menu.
  await first.locator('.idea-text').click({ button: 'right' })
  await expect(menu.getByRole('menuitem', { name: '标为未用' })).toBeVisible()
  await menu.getByRole('menuitem', { name: '删除' }).click()
  await expect(first).toHaveCount(0)
  await page.getByRole('status').filter({ hasText: '灵感已删除' }).getByRole('button', { name: '撤销' }).click()
  await expect(first).toHaveCount(1)
  await expect(first).toContainText('已用')

  // Link an idea to a work.
  await newNovel(page, '雾钟')
  await page.goto('/#/ideas')
  const bell = ideaRow(page, '雾里有人在敲钟')
  await bell.getByRole('button', { name: '灵感操作' }).click()
  await menu.getByRole('menuitem', { name: '关联作品…' }).click()
  const dialog = page.getByRole('dialog', { name: '关联到作品' })
  await dialog.getByRole('combobox', { name: '关联作品' }).selectOption({ label: '雾钟' })
  await dialog.getByRole('button', { name: '关联', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(bell.getByRole('link', { name: '雾钟' })).toBeVisible()

  // The combined entry returns to the same section and its used state.
  await page.goto('/#/')
  await page.locator('#notes-link').click()
  await expect(page.locator('.idea-row:not(.idea-used)')).toHaveCount(1)
})

test('网页版 Ctrl+Alt+N 弹出记灵感，默认关联最近打开的作品', async ({ page }) => {
  await newNovel(page, '北方来信')
  await page.goto('/#/')
  // The shortcut is listened for once the app has started.
  await expect(page.getByRole('link', { name: '灵感与任务', exact: true })).toBeVisible()
  await page.keyboard.press('Control+Alt+KeyN')
  const dialog = page.getByRole('dialog', { name: '记灵感' })
  await expect(dialog).toBeVisible()
  const box = dialog.getByRole('textbox', { name: '灵感' })
  await expect(box).toBeFocused()
  await expect(dialog.getByRole('combobox', { name: '关联作品' })).toHaveValue(/^original:/)
  await expect(dialog.getByRole('combobox', { name: '关联作品' }).locator('option:checked')).toHaveText('北方来信')
  await box.press('Escape')
  await expect(dialog).toHaveCount(0)

  await page.keyboard.press('Control+Alt+KeyN')
  await box.fill('信是从未来寄出的')
  await box.press('Enter')
  await expect(dialog).toHaveCount(0)
  await page.goto('/#/ideas')
  await expect(ideaRow(page, '信是从未来寄出的').getByRole('link', { name: '北方来信' })).toBeVisible()
})

test('编辑器侧边的灵感可以插入正文，章节目录右键有章节操作', async ({ page }) => {
  await newNovel(page, '潮汐', '第一段。')
  // The ideas sit in the side panel, open where there is room, and the toolbar button folds it.
  const toggle = page.locator('.side-toggle')
  const panel = page.getByRole('region', { name: '这部作品的灵感' })
  await expect(panel).toContainText('这部作品还没有灵感。')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.click()
  await expect(panel).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: '记灵感' }).click()
  const dialog = page.getByRole('dialog', { name: '记灵感' })
  await expect(dialog.getByRole('combobox', { name: '关联作品' }).locator('option:checked')).toHaveText('潮汐')
  await dialog.getByRole('textbox', { name: '灵感' }).fill('月亮把海拉走了')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.ideas-count')).toHaveText('1')

  // Write a long chapter: the ideas stay in view at its end, and go in where the cursor is.
  await textArea(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  for (let line = 0; line < 40; line += 1) await page.keyboard.press('Enter')
  await page.keyboard.type('结尾。')
  await expect(panel.getByRole('button', { name: '插入' })).toBeInViewport()
  await panel.getByRole('button', { name: '插入' }).click()
  await expect(textArea(page)).toHaveText(/结尾。\s*月亮把海拉走了\s*$/)
  await expect(panel.getByRole('button', { name: '标为未用' })).toBeVisible()
  await expect(page.locator('.ideas-count')).toHaveText('')

  // Chapter actions on right click.
  await page.getByRole('button', { name: '新建章节' }).click()
  await page.getByRole('textbox', { name: '章节名' }).fill('退潮')
  await page.getByRole('button', { name: '创建章节' }).click()
  const chapters = page.getByRole('list', { name: '章节' })
  await chapters.getByRole('button').first().click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveText([/^重命名章节/, '删除章节'])
  await menu.getByRole('menuitem', { name: '重命名章节' }).click()
  await page.getByRole('textbox', { name: '章节名' }).fill('涨潮')
  await page.getByRole('button', { name: '保存章节名' }).click()
  await expect(chapters.getByRole('button').first()).toContainText('涨潮')
})

test('作品列表延迟加载、快速切换、刷新重进与手动改选时自动关联保持一致', async ({ page }) => {
  await newNovel(page, '山海', '山海正文。')
  const urlA = page.url()
  await newNovel(page, '星辰', '星辰正文。')
  const urlB = page.url()

  const panel = page.getByRole('region', { name: '这部作品的灵感' })
  const toggle = page.locator('.side-toggle')
  const dialog = page.getByRole('dialog', { name: '记灵感' })
  const select = dialog.getByRole('combobox', { name: '关联作品' })

  // Rapid collapse/expand immediately followed by 记灵感 must open and auto-link current work.
  for (let round = 0; round < 3; round += 1) {
    await toggle.click()
    await expect(panel).toBeHidden()
    await toggle.click()
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: '记灵感' }).click()
    await expect(dialog).toBeVisible()
    await expect(select.locator('option:checked')).toHaveText('星辰')
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)
  }

  // Delayed works list: quick submit before IDB finishes still keeps current work linked.
  await page.evaluate(() => {
    window.__booksDelayMs = 350
    const orig = IDBIndex.prototype.getAll
    IDBIndex.prototype.getAll = function (...args) {
      const req = orig.apply(this, args)
      if (this.objectStore?.name === 'books') {
        const desc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess')
        let handler = null
        Object.defineProperty(req, 'onsuccess', {
          configurable: true,
          get: () => handler,
          set: (fn) => {
            handler = fn
            desc.set.call(req, function (ev) {
              const delayMs = window.__booksDelayMs || 0
              if (delayMs > 0) setTimeout(() => fn && fn.call(this, ev), delayMs)
              else fn && fn.call(this, ev)
            })
          },
        })
      }
      return req
    }
  })

  await panel.getByRole('button', { name: '记灵感' }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: '灵感' }).fill('延迟加载仍应关联星辰')
  await dialog.getByRole('textbox', { name: '灵感' }).press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(panel).toContainText('延迟加载仍应关联星辰')

  await page.evaluate(() => { window.__booksDelayMs = 0 })

  // Rapid work switching settles on the active work.
  await page.evaluate(({ first, second }) => {
    location.hash = new URL(first).hash
    location.hash = new URL(second).hash
    location.hash = new URL(first).hash
  }, { first: urlA, second: urlB })
  await expect(page.getByRole('heading', { level: 1, name: '山海' })).toBeVisible()
  await panel.getByRole('button', { name: '记灵感' }).click()
  await expect(select.locator('option:checked')).toHaveText('山海')

  // Manual selection overrides auto-link without breaking subsequent opens.
  await select.selectOption({ label: '星辰' })
  await dialog.getByRole('textbox', { name: '灵感' }).fill('手动改选到星辰')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(panel).not.toContainText('手动改选到星辰')

  // Re-opening inside 山海 auto-links 山海 again; manual unlinking also persists.
  await panel.getByRole('button', { name: '记灵感' }).click()
  await expect(select.locator('option:checked')).toHaveText('山海')
  await select.selectOption('')
  await dialog.getByRole('textbox', { name: '灵感' }).fill('手动取消关联')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  // Reload and re-entry preserve sidebar state and auto-link.
  await page.reload()
  await expect(textArea(page)).toBeVisible()
  await panel.getByRole('button', { name: '记灵感' }).click()
  await expect(select.locator('option:checked')).toHaveText('山海')
  await dialog.getByRole('button', { name: '取消' }).click()

  await page.goto('/#/')
  await page.goto(new URL(urlB).hash)
  await expect(textArea(page)).toBeVisible()
  await panel.getByRole('button', { name: '记灵感' }).click()
  await expect(select.locator('option:checked')).toHaveText('星辰')
  await dialog.getByRole('textbox', { name: '灵感' }).press('Escape')

  await page.goto('/#/ideas')
  await expect(ideaRow(page, '延迟加载仍应关联星辰').getByRole('link', { name: '星辰' })).toBeVisible()
  await expect(ideaRow(page, '手动改选到星辰').getByRole('link', { name: '星辰' })).toBeVisible()
  await expect(ideaRow(page, '手动取消关联')).toContainText('未关联')
})

test('归档作品在编辑器中仍自动关联，读取失败时反馈错误而不静默失选', async ({ page }) => {
  await newNovel(page, '归档之卷', '旧章节。')
  await newNovel(page, '在写新篇', '新章节。')

  // Archive 归档之卷 from the original library shelf.
  await page.goto('/#/original')
  const card = page.locator('.book-list li', { hasText: '归档之卷' })
  await card.locator('.book-menu-toggle').click()
  await page.getByRole('menuitem', { name: '归档' }).click()
  await expect(card).toHaveCount(0)

  // Open archived work from #/archive into editor and capture an idea without rebuilding the button node.
  await page.goto('/#/archive')
  await page.locator('.book-list li', { hasText: '归档之卷' }).getByRole('link').first().click()
  await expect(textArea(page)).toBeVisible()
  const panel = page.getByRole('region', { name: '这部作品的灵感' })
  await expect(panel).toContainText('这部作品还没有灵感。')
  await page.evaluate(() => { window.__captureButtonNode = document.querySelector('.ideas-capture-button') })
  await panel.getByRole('button', { name: '记灵感' }).click()
  const dialog = page.getByRole('dialog', { name: '记灵感' })
  await expect(dialog.getByRole('combobox', { name: '关联作品' }).locator('option:checked')).toHaveText('归档之卷')
  await dialog.getByRole('textbox', { name: '灵感' }).fill('归档卷的补注灵感')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(panel).toContainText('归档卷的补注灵感')
  expect(await page.evaluate(() => window.__captureButtonNode === document.querySelector('.ideas-capture-button'))).toBe(true)

  // Reading a continuation child source file also resolves auto-link to its parent work.
  await page.goto('/#/reference')
  await page.locator('input[type=file]').setInputFiles(file('港湾.txt', '潮汐的岸边。'))
  await chooseImportType(page, 'reference')
  await page.getByRole('link', { name: '查看 港湾', exact: true }).click()
  await expect(page.getByRole('heading', { name: '续写列表' })).toBeVisible()
  await page.locator('input[type=file]').setInputFiles(file('港湾补篇.txt', '小船归港。'))
  await page.getByRole('link', { name: '查看原文 港湾补篇' }).click()
  await expect(page.getByRole('article')).toHaveText('小船归港。')
  await page.keyboard.press('Control+Alt+KeyN')
  await expect(dialog.getByRole('combobox', { name: '关联作品' }).locator('option:checked')).toHaveText('港湾')
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toHaveCount(0)

  // Return to editor and verify failures surface an error instead of silently saving unlinked.
  await page.goto('/#/archive')
  await page.locator('.book-list li', { hasText: '归档之卷' }).getByRole('link').first().click()
  await expect(textArea(page)).toBeVisible()
  await page.evaluate(() => {
    window.__failBooksLoad = true
    const orig = IDBIndex.prototype.getAll
    IDBIndex.prototype.getAll = function (...args) {
      if (window.__failBooksLoad && this.objectStore?.name === 'books') {
        throw new DOMException('读取作品列表失败', 'UnknownError')
      }
      return orig.apply(this, args)
    }
  })
  await panel.getByRole('button', { name: '记灵感' }).click()
  await expect(dialog.getByRole('status')).toHaveClass(/field-error/)
  await dialog.getByRole('textbox', { name: '灵感' }).fill('失败时不该静默保存')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('status')).toHaveClass(/field-error/)
  await page.evaluate(() => { window.__failBooksLoad = false })
  await dialog.getByRole('button', { name: '取消' }).click()
})
