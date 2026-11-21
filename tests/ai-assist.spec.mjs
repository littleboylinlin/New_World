import { startWork } from './navigation-helpers.mjs'
import { expect, test } from './app-test.mjs'
import { editorAction, historyCount, saveNow } from './editor-helpers.mjs'
import { fakeAiService } from './helpers/fake-ai.mjs'

const textArea = (page) => page.getByRole('textbox', { name: '章节正文' })

async function addProfile(page, baseUrl) {
  await page.goto('/#/settings/ai')
  const card = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'AI 服务', exact: true }) })
  // The page has read the saved profiles once this shows.
  await expect(page.getByText('还没有 AI 服务配置')).toBeVisible()
  await card.getByRole('button', { name: '新建配置' }).click()
  await card.getByRole('button', { name: 'OpenAI Chat Completions', exact: true }).click()
  // Wait for the preset list to fold away, so the form stops moving.
  await expect(card.locator('.aip-presets')).toBeHidden()
  await card.getByLabel('Base URL').fill(baseUrl)
  await card.getByLabel('API Key').fill('test-key')
  await card.getByLabel('模型', { exact: true }).fill('example')
  await card.getByRole('button', { name: '保存配置' }).click()
  await expect(card.getByRole('status').filter({ hasText: '配置已保存。' })).toBeVisible()
}

/** A novel whose first paragraph is plain then bold text, then a second paragraph. */
async function novelWithText(page, [plain, bold] = ['他慢慢的走', '进房间。']) {
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill('晴天')
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(textArea(page)).toBeVisible()
  await textArea(page).click()
  await page.keyboard.type(plain)
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.type(bold)
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.press('Enter')
  await page.keyboard.type('第二段没有改动。')
  await saveNow(page)
  await expect(page.locator('.save-status')).toHaveText('已保存')
}

async function askAi(page, action) {
  await textArea(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  const tool = page.locator('.selection-toolbar .selection-ai')
  await expect(tool).toBeVisible()
  await tool.click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

async function agree(page) {
  const dialog = page.getByRole('dialog', { name: '发送前确认' })
  await expect(dialog).toContainText('127.0.0.1')
  await expect(dialog).toContainText('中转站')
  await dialog.getByRole('button', { name: '知道了，继续' }).click()
}

const polished = '他慢慢地走进了房间。\n第二段没有改动。'

test('柔纸下润色结果可逐处采用或拒绝，保留加粗，可撤销并进入历史版本 @webkit', async ({ page }, testInfo) => {
  const fake = await fakeAiService({ reply: () => polished })
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/#/settings/appearance')
    await page.getByRole('radio', { name: '柔纸', exact: true }).check()
    await addProfile(page, `${fake.url}/v1`)
    await novelWithText(page)
    const before = await historyCount(page)
    await askAi(page, '润色')
    await agree(page)

    const panel = page.getByRole('dialog', { name: '润色' })
    await expect(panel).toContainText('还有 2 处修改待处理')
    // A change in the plain part and one in the bold part, each keeping its own format.
    await expect(textArea(page).locator('.ai-sg-del')).toHaveText(['的'])
    await expect(textArea(page).locator('.ai-sg-ins')).toHaveText(['地', '了'])
    const removed = textArea(page).locator('.ai-sg-del')
    const inserted = textArea(page).locator('.ai-sg-ins').first()
    await expect(removed).toHaveCSS('background-color', 'rgb(238, 219, 215)')
    await expect(removed).toHaveCSS('text-decoration-line', 'line-through')
    await expect(inserted).toHaveCSS('background-color', 'rgb(221, 231, 217)')
    await expect(inserted).toHaveCSS('text-decoration-line', 'underline')
    await page.screenshot({ path: testInfo.outputPath('editor-soft-paper-ai.png') })
    const request = fake.requests.at(-1)
    expect(request.body.messages.at(-1).content).toBe('他慢慢的走进房间。\n第二段没有改动。')

    await textArea(page).getByRole('button', { name: '采用第 1 处修改' }).click()
    await expect(panel).toContainText('已采用 1 处')
    await textArea(page).getByRole('button', { name: '拒绝第 1 处修改' }).click()
    await expect(panel).toContainText('已采用 1 处')
    await expect(textArea(page).locator('p').first()).toHaveText('他慢慢地走进房间。')
    await expect(textArea(page).locator('strong')).toHaveText('进房间。')
    await expect(textArea(page).locator('.ai-sg-del, .ai-sg-ins')).toHaveCount(0)

    // The chapter as it was went into history before the first change.
    await expect.poll(() => historyCount(page)).toBe(String(Number(before || 0) + 1))

    await panel.getByRole('button', { name: '撤销' }).click()
    await expect(textArea(page).locator('p').first()).toHaveText('他慢慢的走进房间。')
    await expect(textArea(page).locator('strong')).toHaveText('进房间。')
    await panel.locator('.ai-assist-actions').getByRole('button', { name: '关闭' }).click()
    await expect(panel).toBeHidden()
  } finally {
    await fake.close()
  }
})

test('全部采用保留格式；也可以作为新段插入并撤销', async ({ page }) => {
  const replies = [polished, '他走进房间。\n第二段。']
  const fake = await fakeAiService({ reply: () => replies.shift() })
  try {
    await addProfile(page, `${fake.url}/v1`)
    await novelWithText(page)
    await askAi(page, '润色')
    await agree(page)
    const panel = page.getByRole('dialog', { name: '润色' })
    await panel.getByRole('button', { name: '全部采用' }).click()
    await expect(textArea(page).locator('p').first()).toHaveText('他慢慢地走进了房间。')
    await expect(textArea(page).locator('strong')).toHaveText('进了房间。')
    await expect(panel).toContainText('已采用 2 处')
    await panel.locator('.ai-assist-actions').getByRole('button', { name: '关闭' }).click()

    // Second run: insert the reply as new paragraphs instead, original untouched.
    await askAi(page, '改写')
    const rewrite = page.getByRole('dialog', { name: '改写' })
    await rewrite.getByRole('button', { name: '作为新段插入在后面' }).click()
    await expect(textArea(page).locator('p')).toHaveText(['他慢慢地走进了房间。', '第二段没有改动。', '他走进房间。', '第二段。'])
    await rewrite.getByRole('button', { name: '撤销' }).click()
    await expect(textArea(page).locator('p')).toHaveCount(2)

  } finally {
    await fake.close()
  }
})

test('编辑建议处的正文后，该处建议失效，其余跟着位置移动', async ({ page }) => {
  const fake = await fakeAiService({ reply: () => '今日天空很蓝。\n第二段已经改动。' })
  try {
    await addProfile(page, `${fake.url}/v1`)
    await novelWithText(page, ['今天', '天很蓝。'])
    await askAi(page, '润色')
    await agree(page)
    const panel = page.getByRole('dialog', { name: '润色' })
    await expect(panel).toContainText('还有 3 处修改待处理')
    // Type at the very start of the chapter: nothing is touched, every suggestion moves along.
    await textArea(page).locator('p').first().click({ position: { x: 1, y: 5 } })
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.type('嗯，')
    await expect(panel).toContainText('还有 3 处修改待处理')
    // Accept the first, then delete text right next to the last one: only that one is dropped.
    await textArea(page).getByRole('button', { name: '采用第 1 处修改' }).click()
    await page.keyboard.press('ControlOrMeta+End')
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace')
    await expect(panel).toContainText('1 处因正文改动已失效')
    await expect(textArea(page).locator('.ai-sg-ins')).toHaveText(['空'])
    await panel.getByRole('button', { name: '全部采用' }).click()
    await expect(textArea(page).locator('p')).toHaveText(['嗯，今日天空很蓝。', '第二段没有'])
  } finally {
    await fake.close()
  }
})

test('没有配置 AI 时引导去设置页', async ({ page }) => {
  await novelWithText(page)
  await askAi(page, '缩写')
  const setup = page.getByRole('dialog', { name: '还没有配置 AI' })
  await expect(setup).toContainText('需要先在设置里添加一套 AI 服务配置')
  await setup.getByRole('button', { name: '去设置' }).click()
  await expect(page).toHaveURL(/#\/settings\/ai$/)
})

test('流式输出显示在面板里并可以停止，正文不变', async ({ page }) => {
  const fake = await fakeAiService()
  try {
    await addProfile(page, `${fake.url}/hang/v1`)
    await novelWithText(page)
    await askAi(page, '扩写')
    await agree(page)
    const panel = page.getByRole('dialog', { name: '扩写' })
    await expect(panel.locator('.ai-assist-text')).toContainText('你好')
    await panel.getByRole('button', { name: '停止' }).click()
    await expect(panel).toContainText('已停止')
    await expect(panel.getByRole('button', { name: '重新生成' })).toBeVisible()
    await expect(textArea(page).locator('p')).toHaveText(['他慢慢的走进房间。', '第二段没有改动。'])
  } finally {
    await fake.close()
  }
})

test('额度不足时给出友好提示，可去设置或重试', async ({ page }) => {
  const fake = await fakeAiService()
  try {
    await addProfile(page, `${fake.url}/quota/v1`)
    await novelWithText(page)
    await askAi(page, '润色')
    await agree(page)
    const failed = page.getByRole('dialog', { name: '润色' })
    await expect(failed).toContainText('额度不足')
    await expect(failed.getByRole('button', { name: '去设置' })).toBeVisible()
    await expect(failed.getByRole('button', { name: '重新生成' })).toBeVisible()
    await expect(textArea(page).locator('.ai-sg-del, .ai-sg-ins')).toHaveCount(0)
  } finally {
    await fake.close()
  }
})

test('自由提问：回答显示在面板里，可插入到选区后面', async ({ page }) => {
  const fake = await fakeAiService({ reply: () => '节奏偏快，可以多写一点天空的颜色。' })
  try {
    await addProfile(page, `${fake.url}/v1`)
    await novelWithText(page)
    await askAi(page, '自由提问')
    await agree(page)
    const panel = page.getByRole('dialog', { name: '自由提问' })
    await panel.getByLabel('想问 AI 什么').fill('节奏怎么样？')
    await panel.getByRole('button', { name: '发送' }).click()
    await expect(panel.locator('.ai-assist-text')).toHaveText('节奏偏快，可以多写一点天空的颜色。')
    expect(fake.requests.at(-1).body.messages.at(-1).content).toContain('节奏怎么样？')
    await panel.getByRole('button', { name: '插入到选区后面' }).click()
    await expect(textArea(page).locator('p').last()).toHaveText('节奏偏快，可以多写一点天空的颜色。')
  } finally {
    await fake.close()
  }
})

test('阅读模式下只能自由提问，改动类操作不可用', async ({ page }) => {
  await novelWithText(page)
  await editorAction(page, '阅读模式')
  await textArea(page).or(page.locator('.novel-body')).first().click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.locator('.selection-toolbar .selection-ai').click()
  await expect(page.getByRole('menuitem', { name: '润色', exact: true })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: '改语气' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: '自由提问', exact: true })).toBeEnabled()
})
