import { expect, test } from './app-test.mjs'
import { chapterText } from './writing-motion-helpers.mjs'
import { chapterAction } from './editor-helpers.mjs'
import { paragraph, seedChapters, seedTextWork } from './split-helpers.mjs'

// Notices never stand in the way: a plain one goes with the next click or key, which still does
// its job; one with an undo stays its time without blocking anything; both keep off web pages.

const toast = (page) => page.locator('.undo-toast:not(.leaving)')

/** A plain notice, from asking the shelf to open a work beside a version when none was written. */
async function plainNotice(page) {
  await page.locator('.book-card').filter({ hasText: '旧港札记' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在右侧打开' }).click()
  await expect(toast(page)).toContainText('最近编辑的稿件已不在了')
}

/** The writing shelf with one imported text work on it. */
async function shelfWith(page, title) {
  await page.goto('/#/writing')
  await expect(page.getByRole('button', { name: '导入', exact: true })).toBeVisible()
  await seedTextWork(page, title, '旧港的码头。')
  // A version opened once and since deleted, so asking to read beside it ends in a plain notice.
  await page.evaluate(() => localStorage.setItem('new-world:last-edition', JSON.stringify({ library: 'original', bookId: crypto.randomUUID(), id: crypto.randomUUID() })))
  await page.reload()
  await expect(page.locator('.book-card').filter({ hasText: title })).toBeVisible()
}

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 800 }) })

test('普通提示：点别处或按键就消失，那一下照常生效；点提示本身不消失', async ({ page }) => {
  await shelfWith(page, '旧港札记')
  await plainNotice(page)
  // Clicking the notice's own text keeps it.
  await toast(page).locator('p').click()
  await expect(toast(page)).toBeVisible()
  // A click elsewhere: the notice goes and the click does what it does.
  await page.getByRole('link', { name: '设置' }).click()
  await expect(toast(page)).toHaveCount(0)
  await expect(page).toHaveURL(/#\/settings/)

  await page.goto('/#/writing')
  await plainNotice(page)
  await page.keyboard.press('Shift')
  await expect(toast(page)).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(toast(page)).toHaveCount(0)
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true)
})

test('柔纸下带撤销的提示有暖灰底色，点别处或打字时仍可撤销', async ({ page }) => {
  await page.goto('/#/settings/appearance')
  await page.getByRole('radio', { name: '柔纸', exact: true }).check()
  await seedChapters(page, [['第一章', [paragraph('灯塔下的第一章。')]], ['第二章', [paragraph('海雾里的第二章。')]]])
  await chapterAction(page, '第二章', '删除章节')
  await page.getByRole('button', { name: '确认删除章节' }).click()
  await expect(toast(page)).toContainText('移入回收站')
  await expect(toast(page)).toHaveCSS('background-color', 'rgb(89, 84, 78)')
  await expect(toast(page)).toHaveCSS('color', 'rgb(238, 233, 226)')
  await chapterText(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type('又一句。')
  await expect(chapterText(page)).toContainText('灯塔下的第一章。又一句。')
  await expect(toast(page)).toBeVisible()
  await toast(page).getByRole('button', { name: '撤销' }).click()
  await expect(page.getByRole('list', { name: '章节' }).getByRole('button', { name: '第二章', exact: true })).toBeVisible()
  await expect(toast(page)).toHaveCount(0)
})

test('提示避开网页块：挪到旁边没有网页的地方，底部放不下时挪到顶部', async ({ page }) => {
  await shelfWith(page, '旧港札记')
  // Stand-ins for web pages, which only the desktop app draws.
  const addPage = (rect) => page.evaluate((rect) => {
    const stage = document.createElement('div')
    stage.className = 'web-stage test-stage'
    Object.assign(stage.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, pointerEvents: 'none' })
    document.body.append(stage)
  }, rect)
  const box = () => toast(page).evaluate((node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } })

  await addPage({ left: 640, top: 0, width: 640, height: 800 })
  await plainNotice(page)
  await expect.poll(async () => (await box()).right).toBeLessThanOrEqual(632)
  expect((await box()).bottom).toBeGreaterThan(600)

  // A page appearing under a notice already showing moves it too; with no room left, to the top.
  await addPage({ left: 0, top: 0, width: 640, height: 800 })
  await expect(toast(page)).toHaveClass(/undo-toast-top/)
  await page.evaluate(() => { for (const node of document.querySelectorAll('.web-stage')) { node.style.top = '120px'; node.style.height = '680px' } })
  await expect.poll(async () => (await box()).bottom).toBeLessThanOrEqual(120)
})
