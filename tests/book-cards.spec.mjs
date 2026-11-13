import { expect, test } from './app-test.mjs'
import { pixel } from './fixtures.mjs'

async function newNovel(page, name) {
  await page.goto('/#/original')
  await page.getByRole('button', { name: '新建小说' }).click()
  await page.getByRole('textbox', { name: '作品名' }).fill(name)
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(page.getByRole('textbox', { name: '章节正文' })).toBeVisible()
  await page.goto('/#/original')
}

const card = (page, title) => page.getByRole('list', { name: '全部作品' }).getByRole('listitem').filter({ hasText: title })

test('作品卡片书名在封面下方，箭头和右键都能打开操作菜单', async ({ page }, testInfo) => {
  await newNovel(page, '灯塔与雾')
  const item = card(page, '灯塔与雾')
  await expect(item.locator('.book-name')).toHaveText('灯塔与雾')
  await expect(item.getByRole('button', { name: '重命名' })).toHaveCount(0)

  const toggle = page.getByRole('button', { name: '「灯塔与雾」的操作' })
  await toggle.click()
  const menu = page.getByRole('menu', { name: '「灯塔与雾」的操作' })
  await expect(menu.getByRole('menuitem')).toHaveText(['打开', '重命名', '更换封面…', '归档', '删除'])
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(menu.getByRole('menuitem', { name: '打开' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: '重命名' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(toggle).toBeFocused()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  await item.locator('.book-cover').click({ button: 'right' })
  await expect(menu).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('shelf-card-menu.png') })
  await menu.getByRole('menuitem', { name: '重命名' }).click()
  const dialog = page.getByRole('dialog', { name: '重命名作品' })
  await dialog.getByRole('textbox', { name: '作品名' }).fill('雾中的灯塔')
  await dialog.getByRole('button', { name: '保存名称' }).click()
  await expect(card(page, '雾中的灯塔').locator('.book-name')).toHaveText('雾中的灯塔')
})

test('可以上传原图作为封面，不压缩，也能恢复默认封面', async ({ page }) => {
  await newNovel(page, '封面测试')
  const item = card(page, '封面测试')

  const wrong = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '「封面测试」的操作' }).click()
  await page.getByRole('menuitem', { name: '更换封面…' }).click()
  await (await wrong).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') })
  await expect(page.getByRole('alert')).toContainText('封面只支持')

  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '「封面测试」的操作' }).click()
  await page.getByRole('menuitem', { name: '更换封面…' }).click()
  await (await chooser).setFiles({ name: 'cover.png', mimeType: 'image/png', buffer: pixel })
  const image = item.locator('.book-cover img')
  await expect(image).toBeVisible()
  const stored = await image.evaluate(async (node) => Array.from(new Uint8Array(await (await fetch(node.src)).arrayBuffer())))
  expect(Buffer.from(stored).equals(pixel)).toBe(true)

  await page.reload()
  await expect(item.locator('.book-cover img')).toBeVisible()
  await page.getByRole('button', { name: '「封面测试」的操作' }).click()
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['打开', '重命名', '更换封面…', '恢复默认封面', '归档', '删除'])
  await page.getByRole('menuitem', { name: '恢复默认封面' }).click()
  await expect(item.locator('.book-cover img')).toHaveCount(0)
  await expect(item.locator('.book-cover .book-title')).toHaveText('封面测试')
})
