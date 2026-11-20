import { readFile } from 'node:fs/promises'
import { expect, test } from './app-test.mjs'
import { test as pageTest } from './helpers/ai-provider-page.mjs'
import { fakeAiService } from './helpers/fake-ai.mjs'

async function openAiSettings(page) {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/#/settings/ai')
  const card = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'AI 服务', exact: true }) })
  await expect(card).toBeVisible()
  return card
}

async function addPreset(page, card, name) {
  await card.getByRole('button', { name: '新建配置' }).click()
  await card.getByRole('button', { name, exact: true }).click()
  await expect(card.getByLabel('配置名称')).toHaveValue(name)
  // Wait for the preset list to fold away, so the form stops moving.
  await expect(card.locator('.aip-presets')).toBeHidden()
}

test('配置 AI 服务：预设、保存、测试连接显示状态码与原文、跨域提示和模型列表 @webkit', async ({ page }) => {
  const fake = await fakeAiService()
  try {
    const card = await openAiSettings(page)
    await expect(card.getByText('还没有 AI 服务配置')).toBeVisible()
    await addPreset(page, card, 'OpenAI Chat Completions')
    await card.getByLabel('Base URL').fill(`${fake.url}/v1`)
    await card.getByLabel('API Key').fill('test-key')
    await expect(card.getByText('默认不记住')).toBeVisible()
    await card.getByLabel('模型', { exact: true }).fill('example')
    await card.getByRole('button', { name: '保存配置' }).click()
    await expect(card.getByRole('status').filter({ hasText: '配置已保存。' })).toBeVisible()
    await expect(card.getByRole('button', { name: /OpenAI Chat Completions.*默认/ })).toHaveAttribute('aria-pressed', 'true')

    await card.getByRole('button', { name: '测试连接' }).click()
    await expect(card.locator('.aip-test')).toContainText('连接成功（HTTP 200）')
    expect(fake.requests.at(-1).headers.authorization).toBe('Bearer test-key')

    await card.getByRole('button', { name: '获取模型列表' }).click()
    const models = card.getByLabel('服务商提供的模型')
    await expect(models).toBeVisible()
    await expect(models.locator('option')).toHaveText(['选择一个模型…', 'Example · example'])
    await expect(card.getByRole('button', { name: '加载更多' })).toBeVisible()

    // Testing a changed draft on the same origin reuses the saved key and shows the provider's words.
    await card.getByLabel('Base URL').fill(`${fake.url}/unauthorized/v1`)
    await card.getByRole('button', { name: '测试连接' }).click()
    const result = card.locator('.aip-test')
    await expect(result).toContainText('密钥无效或已过期')
    await expect(result).toContainText('HTTP 状态码：401')
    await expect(result.locator('.aip-test-body')).toContainText('fake key rejected')
    expect(fake.requests.at(-1).headers.authorization).toBe('Bearer test-key')

    await card.getByLabel('Base URL').fill(`${fake.url}/cors/v1`)
    await card.getByRole('button', { name: '测试连接' }).click()
    await expect(result).toContainText('跨域')
    await expect(result).toContainText('自建一个反向代理')
    await expect(result).toContainText('改用 New World 桌面版')

    // Leaving unsaved changes asks first; reverting brings the saved address back.
    await card.getByRole('button', { name: '撤销修改' }).click()
    await expect(card.getByLabel('Base URL')).toHaveValue(`${fake.url}/v1`)
  } finally {
    await fake.close()
  }
})

test('Anthropic 预设醒目提示 1024 输出上限并可一键调大，浏览器直连和记住密钥有风险说明', async ({ page }) => {
  const card = await openAiSettings(page)
  await addPreset(page, card, 'Anthropic')
  const callout = card.locator('.aip-callout')
  await expect(callout).toBeVisible()
  await expect(callout).toContainText('1024')
  await callout.getByRole('button', { name: '调到 8192' }).click()
  await expect(callout).toBeHidden()
  await expect(card.getByLabel('最多输出 token')).toHaveValue('8192')

  const direct = card.getByLabel('允许浏览器直连 Anthropic')
  await expect(card.getByText('密钥会暴露在浏览器里')).toBeHidden()
  await direct.check()
  await expect(card.getByText('密钥会暴露在浏览器里')).toBeVisible()

  await card.getByLabel('在此设备记住密钥').check()
  await expect(card.getByText('本站页面上运行的脚本都能读到它')).toBeVisible()

  // Generation settings stay folded until asked for, and open with the shared animation.
  const generation = card.getByRole('button', { name: '生成参数' })
  await expect(generation).toHaveAttribute('aria-expanded', 'false')
  await generation.click()
  await expect(card.getByLabel('超时（秒）')).toBeVisible()
  await expect(card.getByLabel('重试次数')).toBeVisible()
})

test('功能分配、自定义请求头和导入导出；改写等功能跟随润色的配置', async ({ page }) => {
  const card = await openAiSettings(page)
  await addPreset(page, card, 'DeepSeek')
  await card.getByRole('button', { name: /高级/ }).click()
  await card.getByRole('button', { name: '添加请求头' }).click()
  await card.getByLabel('请求头名').fill('X-Team')
  await card.getByLabel('值', { exact: true }).fill('novel')
  await card.getByLabel('自定义请求体参数').fill('{ "max_tokens": ')
  await expect(card.getByText('这里需要一个 JSON 对象')).toBeVisible()
  await expect(card.getByRole('button', { name: '保存配置' })).toBeDisabled()
  await card.getByLabel('自定义请求体参数').fill('{ "max_tokens": 4096 }')
  await card.getByRole('button', { name: '保存配置' }).click()
  await expect(card.getByRole('status').filter({ hasText: '配置已保存。' })).toBeVisible()

  const routing = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: '功能分配' }) })
  await expect(routing.getByLabel('默认配置')).toHaveValue(/.+/)
  await expect(routing.getByText('同时用于改写、扩写、缩写和改语气')).toBeVisible()
  await routing.getByLabel('润色与改写').selectOption({ label: '停用这个功能' })
  await expect(routing.getByRole('status')).toHaveText('功能分配已保存。')
  await expect(routing.getByLabel('总结网页')).toHaveCount(0)

  const download = page.waitForEvent('download')
  await card.getByRole('button', { name: '导出', exact: true }).click()
  const file = await (await download).path()
  const exported = JSON.parse(await readFile(file, 'utf8'))
  expect(exported.profiles).toHaveLength(1)
  expect(exported.profiles[0].config).toMatchObject({ headers: [{ name: 'X-Team', value: 'novel' }], extraBody: { max_tokens: 4096 } })
  for (const feature of ['polish', 'extension:rewrite', 'extension:expand', 'extension:shorten', 'extension:tone']) {
    expect(exported.routing.byFeature[feature]).toBeNull()
  }

  await card.locator('input[type=file]').setInputFiles({ name: 'ai.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) })
  await expect(card.getByRole('status').filter({ hasText: '已导入 1 套配置' })).toBeVisible()
  await expect(card.locator('.aip-item')).toHaveCount(2)

  // Deleting asks first and leaves the other profile.
  await card.getByRole('button', { name: '删除配置' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除配置' }).click()
  await expect(card.locator('.aip-item')).toHaveCount(1)
})

pageTest('第一次使用 AI 前告知发送目标，没配置时引导去设置页', async ({ page, providerPageUrl }) => {
  await page.goto(providerPageUrl)
  await page.evaluate(() => {
    window.pending = import('/src/ai/access.ts').then(({ requireAi }) => requireAi('extension:rewrite'))
  })
  await expect(page.getByRole('dialog')).toContainText('aiAccess.setupTitle')
  await page.getByRole('button', { name: 'aiAccess.openSettings' }).click()
  expect(await page.evaluate(() => window.pending)).toBeNull()
  expect(new URL(page.url()).hash).toBe('#/settings/ai')

  await page.evaluate(async () => {
    const { ai } = await import('/src/ai-provider/index.ts')
    const saved = await ai.saveProfile({ config: { name: 'Relay', protocol: 'openai-chat', baseUrl: 'https://relay.example/v1', auth: { kind: 'bearer' } } })
    await ai.setRouting({ defaultProfileId: saved.data.id, byFeature: {} })
    window.pending = import('/src/ai/access.ts').then(({ requireAi }) => requireAi('extension:rewrite'))
  })
  await expect(page.getByRole('dialog')).toContainText('aiAccess.consentRelay')
  await page.getByRole('button', { name: 'aiAccess.consentAction' }).click()
  expect(await page.evaluate(() => window.pending.then((profile) => profile?.config.name))).toBe('Relay')
  // Agreed once for this address: no second question.
  expect(await page.evaluate(() => import('/src/ai/access.ts').then(({ requireAi }) => requireAi('polish')).then((profile) => profile?.config.name))).toBe('Relay')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
