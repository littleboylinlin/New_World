import { expect, test } from './app-test.mjs'
import { chapterText } from './writing-motion-helpers.mjs'
import { editorAction, openSidePanel } from './editor-helpers.mjs'
import { paragraph, seedChapters } from './split-helpers.mjs'

// The editor's 灵感与待办 tab: the work's ideas and its tasks, switched at the top, with the tasks
// page's own list, rows and dialogs.

const chapters = [['第一章', [paragraph('灯塔下的第一章。')]], ['第二章', [paragraph('海雾里的第二章。')]]]
const parts = (page) => page.getByRole('tablist', { name: '灵感与待办' })
const tasksPanel = (page) => page.getByRole('region', { name: '这部作品的待办' })
const outerTab = (page) => page.getByRole('tab', { name: /^灵感与待办/ })

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1400, height: 900 }) })

test('灵感和待办合在一个标签里，顶部切换；新建的待办关联本作品，数字分开也合计', async ({ page }) => {
  await seedChapters(page, chapters)
  await openSidePanel(page)
  await outerTab(page).click()
  await expect(parts(page).getByRole('tab', { name: /^灵感/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: '这部作品的灵感' })).toBeVisible()

  await parts(page).getByRole('tab', { name: /^待办/ }).click()
  const panel = tasksPanel(page)
  await expect(panel).toBeVisible()
  await expect(page.getByRole('region', { name: '这部作品的灵感' })).toBeHidden()
  await expect(panel.getByRole('button', { name: '本作品' })).toHaveAttribute('aria-pressed', 'true')
  await panel.getByRole('textbox', { name: '快速添加任务' }).fill('统一人名')
  await panel.getByRole('textbox', { name: '快速添加任务' }).press('Enter')
  await expect(panel.locator('.task-row')).toHaveCount(1)
  await expect(panel.locator('.task-row')).toContainText('统一人名')
  const link = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('new-world-library')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tasks = await new Promise((resolve, reject) => {
      const request = db.transaction('tasks').objectStore('tasks').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return tasks[0]?.link
  })
  expect(link).toMatchObject({ title: '分块样书', bookId: new URL(page.url()).hash.split('/')[2] })

  // The tab counts both, each half its own, and the tooltip tells them apart.
  await expect(parts(page).getByRole('tab', { name: /^待办/ }).locator('.shell-tab-count')).toHaveText('1')
  await expect(outerTab(page).locator('.shell-tab-count')).toHaveText('1')
  await expect(page.locator('.ideas-count')).toHaveText('1')
  await expect(outerTab(page)).toHaveAttribute('title', '0 条灵感 · 1 项待办')

  // The tasks page's own rows: the title expands an inline card, and completing takes it off.
  await panel.getByRole('button', { name: '统一人名' }).click()
  const card = panel.locator('.task-card')
  await expect(card.getByLabel('任务标题', { exact: true })).toHaveValue('统一人名')
  await card.getByRole('button', { name: '收起', exact: true }).first().click()
  await panel.getByRole('checkbox', { name: '完成任务' }).click()
  await expect(panel.locator('.task-row')).toHaveCount(0)
  await expect(page.locator('.ideas-count')).toHaveText('')
})

test('「从当前章节创建任务」建完马上在这里看到，本章的排在最前', async ({ page }) => {
  await seedChapters(page, chapters)
  await openSidePanel(page, '待办')
  const panel = tasksPanel(page)
  await panel.getByRole('textbox', { name: '快速添加任务' }).fill('整部作品的事')
  await panel.getByRole('textbox', { name: '快速添加任务' }).press('Enter')
  await expect(panel.locator('.task-row')).toHaveCount(1)
  // Away on another tab: making a chapter task brings the tasks back into view.
  await openSidePanel(page, '灵感')
  await chapterText(page).click()
  await editorAction(page, '从当前章节创建任务')
  const dialog = page.getByRole('dialog', { name: '添加任务' })
  await dialog.getByLabel('任务标题', { exact: true }).fill('改开篇节奏')
  await dialog.getByRole('button', { name: '保存任务', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(panel).toBeVisible()
  await expect(parts(page).getByRole('tab', { name: /^待办/ })).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('list', { name: '本章' })).toContainText('改开篇节奏')
  await expect(panel.getByRole('list', { name: '本作品其他' })).toContainText('整部作品的事')
  await expect(panel.locator('.task-group-heading')).toHaveText(['本章', '本作品其他'])

  // In another chapter, the first chapter's task is one of the rest.
  await page.getByRole('list', { name: '章节' }).getByRole('button', { name: '第二章', exact: true }).click()
  await expect(chapterText(page)).toContainText('海雾里的第二章。')
  await expect(panel.locator('.task-group-heading')).toHaveCount(0)
  await expect(panel.locator('.task-row')).toHaveCount(2)
})

test('一键切换看全部待办，切换和所在的一半都记住', async ({ page }) => {
  await page.goto('/#/notes/tasks/inbox')
  const quick = page.getByRole('textbox', { name: '快速添加任务' })
  await quick.fill('交房租')
  await quick.press('Enter')
  await expect(page.locator('.task-row')).toContainText('交房租')
  await seedChapters(page, chapters, '分块样书', false)
  await openSidePanel(page, '待办')
  const panel = tasksPanel(page)
  await panel.getByRole('textbox', { name: '快速添加任务' }).fill('统一人名')
  await panel.getByRole('textbox', { name: '快速添加任务' }).press('Enter')
  await expect(panel.locator('.task-row')).toHaveCount(1)
  await expect(panel).not.toContainText('交房租')

  await panel.getByRole('button', { name: '全部' }).click()
  await expect(panel.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.locator('.task-row')).toHaveCount(2)
  await expect(panel).toContainText('交房租')
  // Only this work's open tasks are counted, whichever list shows.
  await expect(page.locator('.ideas-count')).toHaveText('1')

  await page.reload()
  await expect(chapterText(page)).toBeVisible()
  await openSidePanel(page)
  await expect(outerTab(page)).toHaveAttribute('aria-selected', 'true')
  await expect(parts(page).getByRole('tab', { name: /^待办/ })).toHaveAttribute('aria-selected', 'true')
  await expect(tasksPanel(page).getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true')
  await expect(tasksPanel(page)).toContainText('交房租')
})

test('切换两半时左右滑入；减少动态效果时直接切换', async ({ page }) => {
  await seedChapters(page, chapters)
  await openSidePanel(page, '灵感')
  const tasks = page.locator('.side-tasks-panel').locator('xpath=..')
  // The entering half starts shifted and faded, then settles.
  const start = await page.evaluate(() => new Promise((resolve) => {
    const panel = document.querySelector('.side-tasks-panel').parentElement
    new MutationObserver((_, observer) => {
      if (!panel.hidden) { observer.disconnect(); resolve(getComputedStyle(panel).transform) }
    }).observe(panel, { attributes: true })
    document.querySelector('.shell-tabs-segmented [role="tab"]:last-of-type').click()
  }))
  expect(start).not.toBe('none')
  await expect.poll(() => tasks.evaluate((node) => getComputedStyle(node).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await parts(page).getByRole('tab', { name: /^灵感/ }).click()
  await expect(page.getByRole('region', { name: '这部作品的灵感' })).toBeVisible()
  expect(await page.locator('.ideas-panel').locator('xpath=..').evaluate((node) => getComputedStyle(node).transitionDuration)).toMatch(/^0s/)
})
