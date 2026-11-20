import { readFile } from 'node:fs/promises'
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js'
import { startWork } from './navigation-helpers.mjs'
import { expect, test } from './app-test.mjs'
import { saveNow } from './editor-helpers.mjs'
import { fakeAiService } from './helpers/fake-ai.mjs'

const textArea = (page) => page.getByRole('textbox', { name: '章节正文' })
const styleCard = (page) => page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: '写作风格', exact: true }) })

async function addProfile(page, baseUrl) {
  await page.goto('/#/settings/ai')
  const card = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'AI 服务', exact: true }) })
  await expect(page.getByText('还没有 AI 服务配置')).toBeVisible()
  await card.getByRole('button', { name: '新建配置' }).click()
  await card.getByRole('button', { name: 'OpenAI Chat Completions', exact: true }).click()
  await expect(card.locator('.aip-presets')).toBeHidden()
  await card.getByLabel('Base URL').fill(baseUrl)
  await card.getByLabel('API Key').fill('test-key')
  await card.getByLabel('模型', { exact: true }).fill('example')
  await card.getByRole('button', { name: '保存配置' }).click()
  await expect(card.getByRole('status').filter({ hasText: '配置已保存。' })).toBeVisible()
}

async function agree(page) {
  await page.getByRole('dialog', { name: '发送前确认' }).getByRole('button', { name: '知道了，继续' }).click()
}

async function novel(page, title, paragraphs) {
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill(title)
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(textArea(page)).toBeVisible()
  await textArea(page).click()
  for (const [index, line] of paragraphs.entries()) {
    if (index) await page.keyboard.press('Enter')
    await page.keyboard.type(line)
  }
  await saveNow(page)
  await expect(page.locator('.save-status')).toHaveText('已保存')
}

async function askAi(page, action) {
  await textArea(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.locator('.selection-toolbar .selection-ai').click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

async function saveStyleForm(page, fields) {
  const card = styleCard(page)
  for (const [label, value] of Object.entries(fields)) await card.locator('.styles-editor').getByLabel(label, { exact: true }).fill(value)
  await card.getByRole('button', { name: '保存风格' }).click()
  await expect(card.getByRole('status')).toContainText('已保存风格')
}

test('风格库：内置示例只读并可复制，自建风格可编辑、导出、导入和删除 @webkit', async ({ page }) => {
  await page.goto('/#/settings/ai')
  const card = styleCard(page)
  const items = card.locator('.styles-item')
  await expect(items).toHaveCount(4)
  await expect(items.first()).toContainText('冷峻白描')
  await expect(items.first()).toContainText('内置示例')

  await card.getByRole('button', { name: '查看：冷峻白描' }).click()
  const editor = card.locator('.styles-editor')
  await expect(editor.getByLabel('名称', { exact: true })).not.toBeEditable()
  await editor.getByText('查看发给 AI 的提示词').click()
  await expect(editor.locator('.styles-preview-text')).toContainText('只模仿文风')
  await expect(editor.locator('.styles-preview-text')).toContainText('叙事视角')
  await editor.getByRole('button', { name: '复制为我的风格' }).click()
  await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('冷峻白描（副本）')
  await saveStyleForm(page, { 名称: '我的冷峻', 节奏: '更快一点。' })
  await expect(items).toHaveCount(5)
  await expect(items.first()).toContainText('我的冷峻')

  await card.getByRole('button', { name: '编辑：我的冷峻' }).click()
  await expect(editor.getByLabel('节奏', { exact: true })).toHaveValue('更快一点。')
  await saveStyleForm(page, { 简介: '改过的简介。' })
  await expect(items.first()).toContainText('改过的简介。')

  const download = page.waitForEvent('download')
  await card.getByRole('button', { name: '导出全部' }).click()
  const exported = JSON.parse(await readFile(await (await download).path(), 'utf8'))
  expect(exported.format).toBe('new-world-writing-styles')
  expect(exported.styles).toHaveLength(1)
  expect(exported.styles[0]).toMatchObject({ name: '我的冷峻', summary: '改过的简介。', rhythm: '更快一点。' })

  await card.locator('input[type=file]').setInputFiles({ name: 'styles.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) })
  await expect(card.getByRole('status')).toHaveText('已导入 1 个风格。')
  await expect(items).toHaveCount(6)

  await card.getByRole('button', { name: '删除：我的冷峻' }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: '删除' }).click()
  await expect(items).toHaveCount(5)
})

test('让 AI 仿作家或仿自己的章节生成风格草稿，检查后保存', async ({ page }) => {
  const reply = JSON.stringify({ name: '雨夜冷笔', summary: '冷静克制。', vocabulary: '短句。', rhythm: '紧凑。', perspective: '第三人称。', samples: ['雨停了。'] })
  const fake = await fakeAiService({ reply: () => '```json\n' + reply + '\n```' })
  try {
    await addProfile(page, `${fake.url}/v1`)
    await novel(page, '雨夜', ['雨下了一整夜，他没有睡。', '天亮的时候，门口多了一封信。'])
    await page.goto('/#/settings/ai')
    const card = styleCard(page)

    await card.getByRole('button', { name: '仿某位作家' }).click()
    const authorDialog = page.getByRole('dialog', { name: '仿某位作家' })
    await authorDialog.getByLabel('作家名或风格描述').fill('冷硬派侦探小说')
    await authorDialog.getByRole('button', { name: '生成' }).click()
    await agree(page)
    await expect(authorDialog).toBeHidden()
    const editor = card.locator('.styles-editor')
    await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('雨夜冷笔')
    await expect(editor.getByLabel('参照', { exact: true })).toHaveValue('冷硬派侦探小说')
    const authorRequest = fake.requests.at(-1).body.messages
    expect(authorRequest[0].content).toContain('不得引用')
    expect(authorRequest.at(-1).content).toContain('冷硬派侦探小说')
    await saveStyleForm(page, {})
    await expect(card.locator('.styles-item').first()).toContainText('仿作家')

    await card.getByRole('button', { name: '仿我的文笔' }).click()
    const ownDialog = page.getByRole('dialog', { name: '仿我的文笔' })
    await expect(ownDialog.getByLabel('作品')).toHaveValue(/.+/)
    await expect(ownDialog.getByRole('checkbox', { name: '第一章' })).toBeChecked()
    await ownDialog.getByRole('button', { name: '生成' }).click()
    await expect(ownDialog).toBeHidden()
    expect(fake.requests.at(-1).body.messages.at(-1).content).toContain('雨下了一整夜，他没有睡。')
    await expect(editor.getByLabel('参照', { exact: true })).toHaveValue('雨夜：第一章')
    await saveStyleForm(page, { 名称: '我的雨夜' })
    await expect(card.locator('.styles-item').first()).toContainText('我的文笔')
  } finally {
    await fake.close()
  }
})

test('润色时选用风格并设为作品默认，续写也用上默认风格', async ({ page }) => {
  const fake = await fakeAiService({ reply: (request) => request.body.messages[0].content.includes('紧接着它往下写') ? '门外传来脚步声。' : '雨下了一整夜，他一夜没睡。' })
  try {
    await addProfile(page, `${fake.url}/v1`)
    await novel(page, '雨夜', ['雨下了一整夜，他没有睡。'])
    await askAi(page, '润色')
    await agree(page)
    const panel = page.getByRole('dialog', { name: '润色' })
    await expect(panel).toContainText('还有')
    expect(fake.requests.at(-1).body.messages[0].content).not.toContain('写作时采用这种文风')

    // Choosing a style asks again with its instructions.
    const select = panel.getByLabel('风格')
    await select.selectOption({ label: '古典章回' })
    await expect.poll(() => fake.requests.length).toBe(2)
    const system = fake.requests.at(-1).body.messages[0].content
    expect(system).toContain('写作时采用这种文风「古典章回」')
    expect(system).toContain('不要照搬')
    await panel.getByRole('button', { name: '设为本作品默认' }).click()
    await expect(page.getByText('已把「古典章回」设为本作品的默认风格。')).toBeVisible()
    await expect(panel.getByRole('button', { name: '设为本作品默认' })).toBeHidden()
    await panel.getByRole('button', { name: '放弃' }).click()

    await askAi(page, '续写')
    const more = page.getByRole('dialog', { name: '续写' })
    await expect(more.getByLabel('风格')).toHaveValue(/builtin:/)
    await expect(more.locator('.ai-assist-text')).toHaveText('门外传来脚步声。')
    expect(fake.requests.at(-1).body.messages[0].content).toContain('古典章回')
    await more.getByRole('button', { name: '插入到选区后面' }).click()
    await expect(textArea(page).locator('p')).toHaveText(['雨下了一整夜，他没有睡。', '门外传来脚步声。'])
  } finally {
    await fake.close()
  }
})

test('写作风格随整库备份保存并恢复', async ({ page }) => {
  await novel(page, '雨夜', ['雨下了一整夜。'])
  await page.goto('/#/settings/ai')
  const card = styleCard(page)
  await card.getByRole('button', { name: '新建风格' }).click()
  await saveStyleForm(page, { 名称: '备份里的风格', 简介: '要被备份。' })

  await page.goto('/#/settings/backup')
  const section = page.locator('.settings-page').getByRole('region', { name: '备份与恢复', exact: true })
  const download = page.waitForEvent('download')
  await section.getByRole('button', { name: '立即备份' }).click()
  const bytes = await readFile(await (await download).path())
  const zip = new ZipReader(new BlobReader(new Blob([bytes])))
  const entries = await zip.getEntries()
  const manifest = JSON.parse(await entries.find((entry) => entry.filename === 'new-world-backup.json').getData(new TextWriter()))
  await zip.close()
  expect(manifest.writingStyles.filter((row) => row.type === 'style').map((row) => row.name)).toEqual(['备份里的风格'])

  await page.goto('/#/settings/ai')
  await card.getByRole('button', { name: '删除：备份里的风格' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除' }).click()
  await expect(card.locator('.styles-item')).toHaveCount(4)

  await page.goto('/#/settings/backup')
  const chooser = page.waitForEvent('filechooser')
  await section.getByRole('button', { name: '从备份恢复…' }).click()
  await (await chooser).setFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: bytes })
  await page.getByRole('dialog', { name: '从备份恢复' }).getByRole('button', { name: '替换当前书库' }).click()
  await expect(page.getByText('已从备份恢复 1 部作品。')).toBeVisible()
  await page.goto('/#/settings/ai')
  await expect(card.locator('.styles-item').first()).toContainText('备份里的风格')
})
