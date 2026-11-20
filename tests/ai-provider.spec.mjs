import { expect, test } from './helpers/ai-provider-page.mjs'
import { fakeAiService, fakeText } from './helpers/fake-ai.mjs'

test('Web 直连、浏览器跨域诊断和模型列表 @webkit', async ({ page, providerPageUrl }) => {
  const fake = await fakeAiService()
  try {
    await page.goto(providerPageUrl)
    const results = await page.evaluate(async (baseUrl) => {
      const { ai } = await import('/src/ai-provider/index.ts')
      const config = {
        name: 'Sample', protocol: 'anthropic-messages', model: 'example', baseUrl,
        auth: { kind: 'x-api-key' }, anthropicDirectBrowserAccess: true,
        generation: { maxOutputTokens: 80, temperature: 1 },
      }
      const credentials = { apiKey: 'browser-key' }
      const saved = await ai.saveProfile({ config, credentials })
      if (!saved.ok) throw new Error(saved.error.message)
      await ai.setRouting({ defaultProfileId: saved.data.id, byFeature: {} })
      const messages = [{ role: 'user', text: 'a browser request' }]
      const run = ai.generate({ feature: 'ask', messages, generation: { temperature: 0 } })
      const events = []
      for await (const event of run.events) events.push(event)
      const models = await ai.listModels({ draft: { ...config, model: undefined }, credentials })
      const cors = await ai.testConnection({ draft: { ...config, baseUrl: baseUrl + '/cors/v1' }, credentials })
      return { events, models, cors }
    }, fake.url)
    expect(results.events.map(({ type }) => type)).toEqual(['delta', 'done'])
    expect(results.events[1].text).toBe(fakeText)
    expect(results.models.data.models).toEqual([{ id: 'example', displayName: 'Example' }])
    expect(results.cors.error.code).toBe('cors')
    expect(results.cors.httpStatus).toBeUndefined()
    expect(results.cors.rawErrorBody).toBeUndefined()
    expect(fake.requests[0].headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(fake.requests[0].headers['x-api-key']).toBe('browser-key')
    expect(fake.requests[0].body.temperature).toBe(0)
    expect(fake.requests.some((request) => request.url.pathname.includes('/cors/'))).toBe(false)
  } finally {
    await fake.close()
  }
})

test('Web 密钥记忆默认关闭，可持久化、关闭及恢复为页面内存', async ({ page, providerPageUrl }) => {
  await page.goto(providerPageUrl)
  const id = await page.evaluate(async () => {
    const { ai } = await import('/src/ai-provider/index.ts')
    const config = { name: 'Session', protocol: 'openai-chat', baseUrl: 'https://example.invalid', auth: { kind: 'bearer' } }
    const saved = await ai.saveProfile({ config, credentials: { apiKey: 'session-only-test-key' } })
    if (!saved.ok) throw new Error(saved.error.message)
    return saved.data.id
  })
  await page.reload()
  const saved = await page.evaluate(async (id) => {
    const { ai } = await import('/src/ai-provider/index.ts')
    const state = await ai.getConfig()
    const profile = state.data.profiles.find((item) => item.id === id)
    const result = await ai.saveProfile({ id, config: profile.config, credentials: { apiKey: 'persisted-test-key' }, rememberCredentials: true })
    return { profile, result, exported: await ai.exportConfig() }
  }, id)
  expect(saved.profile).toMatchObject({ hasApiKey: false, rememberCredentials: false })
  expect(saved.result.data).toMatchObject({ hasApiKey: true, rememberCredentials: true })
  expect(JSON.stringify(saved.exported)).not.toContain('persisted-test-key')
  await page.reload()
  const turnedOff = await page.evaluate(async (id) => {
    const { ai } = await import('/src/ai-provider/index.ts')
    const state = await ai.getConfig()
    const profile = state.data.profiles.find((item) => item.id === id)
    const result = await ai.saveProfile({ id, config: profile.config, rememberCredentials: false })
    return { previous: profile, next: result.data }
  }, id)
  expect(turnedOff.previous).toMatchObject({ hasApiKey: true, rememberCredentials: true })
  expect(turnedOff.next).toMatchObject({ hasApiKey: true, rememberCredentials: false })
  await page.reload()
  const state = await page.evaluate(async () => (await import('/src/ai-provider/index.ts')).ai.getConfig())
  expect(state.data.profiles[0]).toMatchObject({ hasApiKey: false, rememberCredentials: false })
})
