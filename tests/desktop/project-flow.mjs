import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

export async function projectDesktopFlow({ app, page, output, openThroughOS }) {
  const preview = page.getByRole('dialog', { name: '导入工程预览' })
  // The cold-start file request must survive renderer initialization and show a preview.
  await expect(preview).toContainText('3 个章节 · 2 个编辑版本')
  await preview.getByLabel('导入方式').selectOption('copy')
  await preview.getByRole('button', { name: '确认导入' }).click()
  await expect(preview).toBeHidden()
  await page.locator('.version-navigation').getByRole('link', { name: '初稿', exact: true }).click()
  const editor = page.getByRole('textbox', { name: '章节正文', exact: true })
  await expect(editor).toContainText('灯塔亮了。')
  const workId = new URL(page.url()).hash.split('/')[2]
  await page.goto('new-world://app/#/original')
  const card = page.locator('.book-card').filter({ has: page.locator(`a[href="#/original/${workId}"]`) })
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, output)
  await card.locator('.book-menu-toggle').click()
  await page.getByRole('menuitem', { name: '导出 New_World 工程（.newworld）' }).click()
  await page.getByRole('button', { name: '保存工程', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '导出 New_World 工程（.newworld）' })).toBeHidden()
  expect((await readFile(output)).subarray(0, 2).toString()).toBe('PK')
  await card.getByRole('link', { name: '查看 雾港 · 原创验收', exact: true }).click()
  await page.locator('.version-navigation').getByRole('link', { name: '初稿', exact: true }).click()
  await expect(editor).toBeVisible()
  await editor.fill('文件关联打开时仍在编辑的正文。')
  await openThroughOS(output)
  await expect(preview).toContainText('ID 冲突')
  // The second launch opens a modal; it must not navigate, replace the editor or start another window.
  await expect(editor).toHaveText('文件关联打开时仍在编辑的正文。')
  await preview.getByRole('button', { name: '取消', exact: true }).click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await page.reload()
  await expect(editor).toHaveText('文件关联打开时仍在编辑的正文。')
  expect(app.windows()).toHaveLength(1)
}
