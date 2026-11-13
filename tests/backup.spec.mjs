import { readFile, writeFile } from 'node:fs/promises'
import { TextWriter, Uint8ArrayReader, ZipReader } from '@zip.js/zip.js'
import { expect, test } from './app-test.mjs'
import { bookAction } from './fixtures.mjs'

const textArea = (page) => page.getByRole('textbox', { name: '章节正文' })
const settings = (page) => page.getByRole('dialog', { name: '设置' })
const backupSection = (page) => settings(page).getByRole('region', { name: '备份', exact: true })

async function newNovel(page, name, text) {
  await page.goto('/#/original')
  await page.getByRole('button', { name: '新建小说' }).click()
  await page.getByRole('textbox', { name: '作品名' }).fill(name)
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(textArea(page)).toBeVisible()
  await textArea(page).fill(text)
  await page.getByRole('button', { name: '手动保存' }).click()
  await expect(page.locator('.save-status')).toHaveText('已保存')
}

async function backUp(page, testInfo, name, password) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const download = page.waitForEvent('download')
  await backupSection(page).getByRole('button', { name: '立即备份' }).click()
  if (password) {
    const dialog = page.getByRole('dialog', { name: '为这份备份设置密码' })
    await dialog.getByLabel('密码', { exact: true }).fill(password)
    await dialog.getByLabel('再次输入密码').fill(password)
    await dialog.getByRole('button', { name: '设置密码' }).click()
  }
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^New-World-backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/)
  const path = testInfo.outputPath(name)
  await file.saveAs(path)
  await expect(backupSection(page).locator('.backup-state')).toContainText('已备份 1 部作品')
  await settings(page).getByRole('button', { name: '关闭', exact: true }).click()
  return path
}

async function keepIdea(page, text) {
  await page.goto('/#/ideas')
  await page.getByRole('textbox', { name: '灵感' }).fill(text)
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('list', { name: '灵感列表' })).toContainText(text)
}

async function chooseBackup(page, path) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const chooser = page.waitForEvent('filechooser')
  await backupSection(page).getByRole('button', { name: '从备份恢复…' }).click()
  await (await chooser).setFiles(path)
}

test('作品可以归档、撤销归档，在归档页打开和放回书库', async ({ page }) => {
  await newNovel(page, '旧港口', '码头上的灯一盏盏灭了。')
  await page.goto('/#/original')
  await bookAction(page, '归档')
  await expect(page.getByText('还没有原创作品')).toBeVisible()
  await page.getByRole('status').filter({ hasText: '已归档「旧港口」' }).getByRole('button', { name: '撤销' }).click()
  await expect(page.getByRole('link', { name: '查看 旧港口', exact: true })).toBeVisible()

  await bookAction(page, '归档')
  await page.goto('/#/')
  await expect(page.locator('.shelf-original .card-count')).toHaveText('0 部作品')
  await page.getByRole('link', { name: '归档', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: '归档' })).toBeVisible()
  const row = page.getByRole('list', { name: '归档的作品' }).getByRole('listitem').filter({ hasText: '旧港口' })
  await expect(row).toContainText('原创库')
  await row.getByRole('link', { name: '旧港口' }).click()
  await expect(textArea(page)).toHaveText('码头上的灯一盏盏灭了。')

  await page.goto('/#/archive')
  await row.getByRole('button', { name: '取消归档' }).click()
  await expect(page.getByText('还没有归档的作品')).toBeVisible()
  await page.goto('/#/original')
  await expect(page.getByRole('link', { name: '查看 旧港口', exact: true })).toBeVisible()
})

test('立即备份后可从备份恢复整个书库，包括归档和回收站', async ({ page }, testInfo) => {
  await newNovel(page, '雾中灯塔', 'The keeper climbed the stairs. 灯塔守望者。')
  await page.goto('/#/original')
  await bookAction(page, '归档')
  await keepIdea(page, '灯塔下埋着一封信')
  const path = await backUp(page, testInfo, 'plain-backup.zip')
  const zip = await readFile(path)
  expect(zip.subarray(0, 2).toString()).toBe('PK')
  // Bit 0 of the general purpose flags marks an encrypted entry.
  expect(zip[6] & 1).toBe(0)
  const reader = new ZipReader(new Uint8ArrayReader(zip))
  const entry = (await reader.getEntries()).find((item) => item.filename === 'new-world-backup.json')
  const manifest = JSON.parse(await entry.getData(new TextWriter()))
  await reader.close()
  // The heatmap's writing history travels with the library.
  expect(manifest.writingDays.reduce((sum, day) => sum + day.words, 0)).toBeGreaterThan(0)
  expect(manifest.ideas.map((idea) => idea.text)).toEqual(['灯塔下埋着一封信'])

  // Change the library, then restore.
  await page.goto('/#/archive')
  await page.getByRole('button', { name: '取消归档' }).click()
  await newNovel(page, '备份之后', '这部不在备份里。')
  await keepIdea(page, '备份之后的灵感')
  await chooseBackup(page, path)
  const confirm = page.getByRole('dialog', { name: '从备份恢复' })
  await expect(confirm).toContainText('1 部作品')
  await confirm.getByRole('button', { name: '替换当前书库' }).click()
  await expect(page.getByText('已从备份恢复 1 部作品。')).toBeVisible()
  await expect(page.locator('.shelf-original .card-count')).toHaveText('0 部作品')
  await page.goto('/#/archive')
  await page.getByRole('link', { name: '雾中灯塔' }).click()
  await expect(textArea(page)).toHaveText('The keeper climbed the stairs. 灯塔守望者。')
  await page.goto('/#/ideas')
  await expect(page.getByRole('list', { name: '灵感列表' }).locator('.idea-text')).toHaveText(['灯塔下埋着一封信'])
})

test('加密备份需要正确密码才能恢复，损坏的文件会被拒绝', async ({ page }, testInfo) => {
  await newNovel(page, '密封的信', '只有知道密码的人才能读到。')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await backupSection(page).getByRole('radio', { name: '用密码加密' }).check()
  await expect(backupSection(page).locator('.backup-state')).toHaveText('之后每次备份时会请你设置密码。')
  await settings(page).getByRole('button', { name: '关闭', exact: true }).click()

  // Mismatched passwords are caught before anything is written.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await backupSection(page).getByRole('button', { name: '立即备份' }).click()
  const ask = page.getByRole('dialog', { name: '为这份备份设置密码' })
  await ask.getByLabel('密码', { exact: true }).fill('lighthouse')
  await ask.getByLabel('再次输入密码').fill('lighthous')
  await ask.getByRole('button', { name: '设置密码' }).click()
  await expect(ask.getByRole('alert')).toHaveText('两次输入的密码不一致。')
  await ask.getByRole('button', { name: '取消' }).click()
  await settings(page).getByRole('button', { name: '关闭', exact: true }).click()

  const path = await backUp(page, testInfo, 'encrypted-backup.zip', 'lighthouse')
  expect((await readFile(path))[6] & 1).toBe(1)

  await page.goto('/#/original')
  await bookAction(page, '删除')
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByText('还没有原创作品')).toBeVisible()

  await chooseBackup(page, path)
  const password = page.getByRole('dialog', { name: '输入备份密码' })
  await password.getByLabel('密码', { exact: true }).fill('wrong')
  await password.getByRole('button', { name: '打开' }).click()
  await expect(password.getByRole('alert')).toHaveText('密码不正确。')
  await password.getByLabel('密码', { exact: true }).fill('lighthouse')
  await password.getByRole('button', { name: '打开' }).click()
  await page.getByRole('dialog', { name: '从备份恢复' }).getByRole('button', { name: '替换当前书库' }).click()
  await expect(page.getByText('已从备份恢复 1 部作品。')).toBeVisible()
  await page.goto('/#/original')
  await page.getByRole('link', { name: '查看 密封的信', exact: true }).click()
  await expect(textArea(page)).toHaveText('只有知道密码的人才能读到。')

  const broken = testInfo.outputPath('broken.zip')
  await writeFile(broken, 'not a zip at all')
  await chooseBackup(page, broken)
  await expect(backupSection(page).getByRole('alert')).toHaveText('这不是 New World 备份文件，或文件已损坏。')
})
