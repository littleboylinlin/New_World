import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js'
import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { editWorkInformation, editorAction, openVersion } from '../editor-helpers.mjs'

export async function expectDesktopWorkInformation(page) {
  await editWorkInformation(page)
  const form = page.getByRole('dialog', { name: '编辑作品信息', exact: true })
  await expect(form.getByLabel('作者', { exact: true })).toHaveValue('Desktop Author')
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
  await editWorkInformation(page)
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
  await openVersion(page, '初稿')
  const editor = page.getByRole('textbox', { name: '章节正文', exact: true })
  await expect(editor).toContainText('灯塔亮了。')
  const workId = new URL(page.url()).hash.split('/')[2]
  await editorAction(page, '从当前章节创建任务')
  const taskForm=page.getByRole('dialog',{name:'添加任务',exact:true})
  await taskForm.getByLabel('任务标题',{exact:true}).fill('Desktop linked task')
  await taskForm.getByLabel('任务备注',{exact:true}).fill('Desktop linked note')
  await taskForm.getByRole('button',{name:'保存任务',exact:true}).click();await expect(taskForm).toBeHidden()
  await page.goto('new-world://app/#/tasks');await page.getByLabel('快速添加任务',{exact:true}).fill('PRIVATE Desktop personal task');await page.locator('.task-quick button').click();await expect(page.getByRole('button',{name:'PRIVATE Desktop personal task',exact:true})).toBeVisible()
  await page.goto('new-world://app/#/original')
  const card = page.locator('.book-card').filter({ has: page.locator(`a[href="#/original/${workId}"]`) })
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, output)
  await card.locator('.book-menu-toggle').click()
  await page.getByRole('menuitem', { name: '导出 New_World 工程（.newworld）' }).click()
  await page.getByRole('button', { name: '保存工程', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '导出 New_World 工程（.newworld）' })).toBeHidden()
  expect((await readFile(output)).subarray(0, 2).toString()).toBe('PK')
  const taskZip=new ZipReader(new Uint8ArrayReader(await readFile(output)),{useWebWorkers:false});const zipEntries=await taskZip.getEntries();const manifest=JSON.parse(Buffer.from(await zipEntries.find(e=>e.filename==='manifest.json').getData(new Uint8ArrayWriter())).toString());expect(manifest.schemaVersion).toBe(3);const exportedTasks=JSON.parse(Buffer.from(await zipEntries.find(e=>e.filename===manifest.records.tasks).getData(new Uint8ArrayWriter())).toString());expect(exportedTasks.map(t=>t.title)).toEqual(['Desktop linked task']);await taskZip.close()
  await card.getByRole('link', { name: '查看 雾港 · 原创验收', exact: true }).click()
  await openVersion(page, '初稿')
  await expect(editor).toBeVisible()
  await editor.fill('Desktop project manuscript.')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  const pdfPath = output + '.pdf'
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, pdfPath)
  await editorAction(page, '导出')
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
  const editorUrl=page.url();await page.goto('new-world://app/#/tasks/all');await expect(page.getByRole('button',{name:'Desktop linked task',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'PRIVATE Desktop personal task',exact:true})).toBeVisible();await page.getByRole('button',{name:'Desktop linked task',exact:true}).click();const taskCard=page.locator('.task-card');await expect(taskCard.getByLabel('任务备注',{exact:true})).toHaveValue('Desktop linked note');await taskCard.getByRole('button',{name:'收起',exact:true}).first().click();await page.reload();await expect(page.getByRole('button',{name:'Desktop linked task',exact:true})).toBeVisible();await page.goto(editorUrl);await expect(editor).toHaveText('文件关联打开时仍在编辑的正文。')
  expect(app.windows()).toHaveLength(1)
  return page.url()
}
