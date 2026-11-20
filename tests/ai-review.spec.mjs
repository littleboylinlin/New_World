import { startWork } from './navigation-helpers.mjs'
import { expect, test } from './app-test.mjs'
import { saveNow } from './editor-helpers.mjs'
import { fakeAiService } from './helpers/fake-ai.mjs'

const textArea = (page) => page.getByRole('textbox', { name: '章节正文' })

async function addProfile(page, baseUrl, contextTokens) {
  await page.goto('/#/settings/ai')
  const card = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'AI 服务', exact: true }) })
  await expect(page.getByText('还没有 AI 服务配置')).toBeVisible()
  await card.getByRole('button', { name: '新建配置' }).click()
  await card.getByRole('button', { name: 'OpenAI Chat Completions', exact: true }).click()
  await expect(card.locator('.aip-presets')).toBeHidden()
  await card.getByLabel('Base URL').fill(baseUrl)
  await card.getByLabel('API Key').fill('test-key')
  await card.getByLabel('模型', { exact: true }).fill('example')
  if (contextTokens) {
    await card.getByRole('button', { name: '生成参数' }).click()
    await card.getByLabel('上下文窗口 token').fill(String(contextTokens))
  }
  await card.getByRole('button', { name: '保存配置' }).click()
  await expect(card.getByRole('status').filter({ hasText: '配置已保存。' })).toBeVisible()
}

async function typeParagraphs(page, paragraphs) {
  await textArea(page).click()
  for (const [index, line] of paragraphs.entries()) {
    if (index) await page.keyboard.press('Enter')
    await page.keyboard.type(line)
  }
  await saveNow(page)
  await expect(page.locator('.save-status')).toHaveText('已保存')
}

async function novel(page, paragraphs) {
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill('公园')
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(textArea(page)).toBeVisible()
  await typeParagraphs(page, paragraphs)
}

async function chapterAi(page, name) {
  await page.locator('.more-toggle').click()
  await page.getByRole('menuitem', { name: 'AI 校对与总结' }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

async function agree(page) {
  await page.getByRole('dialog', { name: '发送前确认' }).getByRole('button', { name: '知道了，继续' }).click()
}

const kind = (request) => {
  const system = request.body.messages[0].content
  if (system.includes('校对编辑')) return 'proofread'
  if (system.includes('各章的摘要')) return 'book'
  return 'summary'
}

test('校对本章：按段落和前文定位，逐处显示原因，可全部采用 @webkit', async ({ page }) => {
  const fake = await fakeAiService({
    reply: () => JSON.stringify([
      { p: 1, before: '他', original: '门', replacement: '们', reason: '错别字：他们' },
      { p: 1, before: '去', original: '公圆', replacement: '公园', reason: '错别字' },
      // 「天」 appears twice in that paragraph and comes without context: it is left alone.
      { p: 2, original: '天', replacement: '日', reason: '无法定位' },
      { p: 9, original: '不存在', replacement: '不会用', reason: '超出段落' },
    ]),
  })
  try {
    await addProfile(page, `${fake.url}/v1`)
    await novel(page, ['他门一起去公圆。', '今天天气很好。'])
    await chapterAi(page, '校对本章')
    await agree(page)
    const panel = page.getByRole('dialog', { name: '校对本章' })
    await expect(panel).toContainText('还有 2 处修改待处理')
    expect(fake.requests.at(-1).body.messages.at(-1).content).toBe('[1] 他门一起去公圆。\n[2] 今天天气很好。')
    await expect(textArea(page).locator('.ai-sg-note')).toHaveText(['错别字：他们', '错别字'])
    await expect(textArea(page).getByRole('button', { name: '采用第 1 处修改：错别字：他们' })).toBeVisible()
    await panel.getByRole('button', { name: '全部采用' }).click()
    await expect(textArea(page).locator('p')).toHaveText(['他们一起去公园。', '今天天气很好。'])
  } finally {
    await fake.close()
  }
})

test('校对选区没有问题时如实告知；总结选区和本章可存为灵感', async ({ page }) => {
  const fake = await fakeAiService({ reply: (request) => kind(request) === 'proofread' ? '[]' : '- 他们去了公园。' })
  try {
    await addProfile(page, `${fake.url}/v1`)
    await novel(page, ['他们一起去公园。', '今天天气很好。'])
    await textArea(page).click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.locator('.selection-toolbar .selection-ai').click()
    await page.getByRole('menuitem', { name: '校对选区' }).click()
    await agree(page)
    const proofread = page.getByRole('dialog', { name: '校对选区' })
    await expect(proofread).toContainText('没有发现错别字、病句或标点问题。')
    await proofread.locator('.ai-assist-actions').getByRole('button', { name: '关闭' }).click()

    await chapterAi(page, '总结本章')
    const summary = page.getByRole('dialog', { name: '总结本章' })
    await expect(summary.locator('.ai-assist-text')).toHaveText('- 他们去了公园。')
    expect(fake.requests.at(-1).body.messages.at(-1).content).toContain('第一章')
    await summary.getByRole('button', { name: '存为灵感' }).click()
    await expect(page.getByText('已存为本作品的灵感。')).toBeVisible()
    await expect(summary.getByRole('button', { name: '存为灵感' })).toBeDisabled()
    await page.goto('/#/notes/ideas')
    await expect(page.locator('.idea-text').first()).toContainText('【第一章 总结】')
    await expect(page.locator('.idea-text').first()).toContainText('他们去了公园')
  } finally {
    await fake.close()
  }
})

test('总结整本按章缓存：只重算改过的章，清空缓存后全部重算', async ({ page }) => {
  const fake = await fakeAiService({ reply: (request) => kind(request) === 'book' ? '全书总结。' : '本章摘要。' })
  const count = () => fake.requests.filter((request) => request.method === 'POST').length
  try {
    await addProfile(page, `${fake.url}/v1`, 8000)
    await novel(page, ['第一章的内容。'])
    await page.getByRole('button', { name: '新建章节' }).click()
    await page.getByRole('textbox', { name: '章节名' }).fill('第二章')
    await page.getByRole('button', { name: '创建章节' }).click()
    await expect(page.locator('.chapter-name .toolbar-name-text')).toHaveText('第二章')
    await typeParagraphs(page, ['第二章的内容。'])

    const summarize = async (first = false) => {
      await chapterAi(page, '总结整本')
      if (first) await agree(page)
      const panel = page.getByRole('dialog', { name: '总结整本' })
      await expect(panel.locator('.ai-assist-text')).toHaveText('全书总结。')
      return panel
    }
    let panel = await summarize(true)
    expect(count()).toBe(3)
    await expect(panel).toContainText('0/2 章的摘要来自缓存')
    expect(fake.requests.at(-1).body.messages.at(-1).content).toContain('## 第二章\n本章摘要。')
    await panel.locator('.ai-assist-actions').getByRole('button', { name: '关闭' }).click()

    panel = await summarize()
    expect(count()).toBe(4)
    await expect(panel).toContainText('2/2 章的摘要来自缓存')
    await panel.locator('.ai-assist-actions').getByRole('button', { name: '关闭' }).click()

    await textArea(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('又多了一句。')
    await saveNow(page)
    panel = await summarize()
    expect(count()).toBe(6)
    await expect(panel).toContainText('1/2 章的摘要来自缓存')
    await panel.locator('.ai-assist-actions').getByRole('button', { name: '关闭' }).click()

    await page.goto('/#/settings/ai')
    await page.getByRole('button', { name: '清空章节摘要缓存' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '清空章节摘要缓存' }).click()
    await expect(page.getByText('章节摘要缓存已清空。')).toBeVisible()
    await page.goBack()
    await expect(textArea(page)).toBeVisible()
    panel = await summarize()
    expect(count()).toBe(9)
    await expect(panel).toContainText('0/2 章的摘要来自缓存')
  } finally {
    await fake.close()
  }
})

test('总结整本前提示需要填写上下文窗口，并可去设置', async ({ page }) => {
  const fake = await fakeAiService()
  try {
    await addProfile(page, `${fake.url}/v1`)
    await novel(page, ['第一章的内容。'])
    await chapterAi(page, '总结整本')
    await agree(page)
    const panel = page.getByRole('dialog', { name: '总结整本' })
    await expect(panel).toContainText('上下文窗口 token')
    await panel.getByRole('button', { name: '去设置' }).click()
    await expect(page).toHaveURL(/#\/settings\/ai$/)
    expect(fake.requests.filter((request) => request.method === 'POST')).toHaveLength(0)
  } finally {
    await fake.close()
  }
})
