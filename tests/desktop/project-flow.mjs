import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

export async function expectDesktopWorkInformation(page) {
  await expect(page.getByRole('region', { name: '作品信息', exact: true })).toContainText('Desktop Author')
  await page.getByRole('button', { name: '编辑作品信息', exact: true }).click()
  const form = page.getByRole('dialog', { name: '编辑作品信息', exact: true })
  await expect(form.getByLabel('作品简介', { exact: true })).toHaveValue('Desktop introduction.\n\nSecond paragraph.')
  await expect(form.getByLabel('创作状态', { exact: true })).toHaveValue('serializing')
  await expect(form.getByLabel('标签', { exact: true })).toHaveValue('奇幻\nDesktop')
  await form.getByRole('button', { name: '取消', exact: true }).click()
}

export async function projectDesktopFlow({ app, page, output, openThroughOS }) {
  const preview = page.getByRole('dialog', { name: '导入工程预览' })
  // The cold-start file request must survive renderer initialization and show a preview.
  await expect(preview).toContainText('3 个章节 · 2 个编辑版本')
  await preview.getByLabel('导入方式').selectOption('copy')
  await preview.getByRole('button', { name: '确认导入' }).click()
  await expect(preview).toBeHidden()
  // Schema 1 has no fabricated author/status; the new UI stores only explicitly entered values.
  await page.getByRole('button', { name: '编辑作品信息', exact: true }).click()
  const information = page.getByRole('dialog', { name: '编辑作品信息', exact: true })
  await expect(information.getByLabel('作者', { exact: true })).toHaveValue('')
  await expect(information.getByLabel('创作状态', { exact: true })).toHaveValue('')
  await information.getByLabel('作者', { exact: true }).fill('Desktop Author')
  await information.getByLabel('副标题', { exact: true }).fill('Desktop subtitle')
  await information.getByLabel('作品简介', { exact: true }).fill('Desktop introduction.\n\nSecond paragraph.')
  await information.getByLabel('标签', { exact: true }).fill('奇幻\nDesktop')
  await information.getByLabel('创作状态', { exact: true }).selectOption('serializing')
  await information.getByRole('button', { name: '保存作品信息', exact: true }).click()
  await expect(information).toBeHidden()
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
  await editor.fill('Desktop project manuscript.')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  const pdfPath = output + '.pdf'
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, pdfPath)
  await page.getByRole('button', { name: '导出', exact: true }).click()
  const exportForm = page.getByRole('dialog', { name: '导出编辑稿' })
  await exportForm.getByRole('radio', { name: 'PDF', exact: true }).check()
  for (const label of ['作品标题及副标题', '作者', '作品简介']) {
    await expect(exportForm.getByRole('checkbox', { name: label, exact: true })).not.toBeChecked()
    await exportForm.getByRole('checkbox', { name: label, exact: true }).check()
  }
  await exportForm.getByRole('button', { name: '开始导出', exact: true }).click()
  await expect(exportForm).toBeHidden()
  const pdfBytes = await readFile(pdfPath)
  expect(pdfBytes.subarray(0, 4).toString()).toBe('%PDF')
  const loading = getDocument({ data: Uint8Array.from(pdfBytes) })
  try {
    const pdf = await loading.promise
    expect(pdf.numPages).toBeGreaterThanOrEqual(2)
    const text = async (number) => (await (await pdf.getPage(number)).getTextContent()).items.map(item => item.str ?? '').join(' ')
    const introduction = await text(1)
    expect(introduction).toContain('Desktop Author')
    expect(introduction).toContain('Desktop subtitle')
    expect(introduction).toContain('Second paragraph.')
    expect(introduction).not.toContain('Desktop project manuscript.')
    expect(await text(2)).toContain('Desktop project manuscript.')
  } finally { await loading.destroy() }
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
  return page.url()
}
