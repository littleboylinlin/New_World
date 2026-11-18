import { expect } from '@playwright/test'
// Shared steps for the editor page: its toolbar, the "⋯" menu, the work menu and the chapter list.

/** The open chapter's name in the toolbar. */
export const chapterHeading = (page) => page.locator('.chapter-name .toolbar-name-text')

/** Runs an entry of the toolbar's "⋯" menu, such as 阅读模式 or 导出. */
export async function editorAction(page, name) {
  await page.locator('.more-toggle').click()
  await page.getByRole('menuitem', { name }).first().click()
}

/** Runs an entry of the menu under the work's name, such as a version or 原创作品. */
export async function workAction(page, name, version = false) {
  const workName = page.locator('.work-name')
  await expect(page.locator('.work-name:visible, .more-toggle:visible').first()).toBeVisible()
  if (await workName.isVisible()) await workName.click()
  else {
    // On a phone the work menu sits inside "⋯".
    await page.locator('.more-toggle').click()
    await page.getByRole('menuitem', { name: /^(作品菜单|Work menu)/ }).click()
  }
  if (version) await page.getByRole('menuitem', { name: '切换版本' }).click()
  await page.getByRole('menuitemradio', { name, exact: true }).or(page.getByRole('menuitem', { name, exact: true })).click()
}

/** Saves the open chapter now with the keyboard shortcut and waits for it. */
export async function saveNow(page) {
  await page.keyboard.press('ControlOrMeta+s')
}

const chapterList = (page) => page.getByRole('list', { name: '章节' })

export function chapterItem(page, title) {
  return chapterList(page).locator('.chapter-item').filter({ has: page.getByRole('button', { name: title, exact: true }) })
}

/** Opens a chapter's own menu (hover "⋯") and runs 重命名章节 or 删除章节. */
export async function chapterAction(page, title, name) {
  const item = chapterItem(page, title)
  await item.hover()
  await item.locator('.chapter-more').click()
  await page.getByRole('menuitem', { name }).click()
}

/** Moves a chapter one place with the keyboard (Alt + Up/Down). */
export async function moveChapter(page, title, direction) {
  await chapterList(page).getByRole('button', { name: title, exact: true }).focus()
  await page.keyboard.press(direction === 'up' ? 'Alt+ArrowUp' : 'Alt+ArrowDown')
}

/** Titles of the chapters in list order. */
export async function chapterTitles(page) {
  return chapterList(page).locator('.chapter-title').allTextContents()
}

/** Opens the side panel on the named tab (灵感 or 批注). */
export async function openSidePanel(page, tab) {
  const toggle = page.locator('.side-toggle')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  if (tab) await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
}

/** Makes sure the chapter list beside the text is showing. */
export async function openChapterList(page) {
  const toggle = page.locator('.nav-toggle')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
}

/** The number shown beside 历史版本 in the "⋯" menu ('' when there is none). */
export async function historyCount(page) {
  await page.locator('.more-toggle').click()
  const item = page.getByRole('menuitem', { name: /^(历史版本|History)/ })
  const hint = item.locator('.shell-menu-hint')
  const text = await hint.count() ? (await hint.textContent()) ?? '' : ''
  await page.keyboard.press('Escape')
  await page.locator('.shell-menu').waitFor({ state: 'detached' })
  return text
}

/** Opens an editable version, from the work page's tabs or, inside the editor, from the work menu. */
export async function openVersion(page, name) {
  const tabs = page.locator('.version-navigation')
  await expect(page.locator('.version-navigation:visible, .more-toggle:visible').first()).toBeVisible()
  if (await tabs.isVisible()) await tabs.getByRole('link', { name, exact: true }).click()
  else await workAction(page, name, true)
}

/** Opens the work information form, from the work page or from the editor's work menu. */
export async function editWorkInformation(page) {
  const direct = page.getByRole('button', { name: '编辑作品信息', exact: true })
  await expect(direct.or(page.locator('.more-toggle:visible')).first()).toBeVisible()
  if (await direct.isVisible()) await direct.click()
  else await workAction(page, '编辑作品信息')
}
