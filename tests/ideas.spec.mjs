import { expect, test } from './app-test.mjs'

const textArea = (page) => page.getByRole('textbox', { name: '章节正文' })
const ideaList = (page) => page.getByRole('list', { name: '灵感列表' })
const ideaRow = (page, text) => ideaList(page).getByRole('listitem').filter({ hasText: text })

async function newNovel(page, name, text) {
  await page.goto('/#/original')
  await page.getByRole('button', { name: '新建小说' }).click()
  await page.getByRole('textbox', { name: '作品名' }).fill(name)
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(textArea(page)).toBeVisible()
  if (text) {
    await textArea(page).fill(text)
    await page.getByRole('button', { name: '手动保存' }).click()
    await expect(page.locator('.save-status')).toHaveText('已保存')
  }
}

test('灵感页可以记下、标记已用、关联作品、删除和撤销', async ({ page }, testInfo) => {
  await page.goto('/#/')
  await page.getByRole('link', { name: '灵感', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: '灵感' })).toBeVisible()
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
  await expect(menu.getByRole('menuitem')).toHaveText(['标记已用', '关联作品…', '复制', '删除'])
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

  // The home page counts ideas that are not used yet.
  await page.goto('/#/')
  await expect(page.getByRole('link', { name: '灵感', exact: true }).locator('.archive-count')).toHaveText('1')
})

test('网页版 Ctrl+Alt+N 弹出记灵感，默认关联最近打开的作品', async ({ page }) => {
  await newNovel(page, '北方来信')
  await page.goto('/#/')
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
  const toggle = page.locator('.ideas-toggle')
  await toggle.click()
  const panel = page.getByRole('region', { name: '这部作品的灵感' })
  await expect(panel).toContainText('这部作品还没有灵感。')
  await panel.getByRole('button', { name: '记灵感' }).click()
  const dialog = page.getByRole('dialog', { name: '记灵感' })
  await expect(dialog.getByRole('combobox', { name: '关联作品' }).locator('option:checked')).toHaveText('潮汐')
  await dialog.getByRole('textbox', { name: '灵感' }).fill('月亮把海拉走了')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.ideas-count')).toHaveText('1')

  await textArea(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await panel.getByRole('button', { name: '插入' }).click()
  await expect(textArea(page)).toContainText('月亮把海拉走了')
  await expect(panel.getByRole('button', { name: '标为未用' })).toBeVisible()
  await expect(page.locator('.ideas-count')).toHaveText('')

  // Chapter actions on right click.
  await page.getByRole('button', { name: '新建章节' }).click()
  await page.getByRole('textbox', { name: '章节名' }).fill('退潮')
  await page.getByRole('button', { name: '创建章节' }).click()
  const chapters = page.getByRole('list', { name: '章节' })
  await chapters.getByRole('button').first().click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['新建章节', '重命名章节', '下移', '删除章节'])
  await menu.getByRole('menuitem', { name: '重命名章节' }).click()
  await page.getByRole('textbox', { name: '章节名' }).fill('涨潮')
  await page.getByRole('button', { name: '保存章节名' }).click()
  await expect(chapters.getByRole('button').first()).toContainText('涨潮')
})
