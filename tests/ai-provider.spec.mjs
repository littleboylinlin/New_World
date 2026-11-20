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

test('Web 密钥记忆默认关闭，可持久化、关闭及恢复为页面内存 @webkit', async ({ page, providerPageUrl }) => {
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

test('章节缓存刷新后重用，只重算改章，清空后拒绝旧结果回写 @webkit', async ({ page, providerPageUrl }) => {
  const fake = await fakeAiService()
  try {
    await page.goto(providerPageUrl)
    const id = await page.evaluate(async (baseUrl) => {
      const { ai } = await import('/src/ai-provider/index.ts')
      const config = {
        name: 'Summary', baseUrl, protocol: 'openai-chat', auth: { kind: 'none' }, model: 'example',
        generation: { contextTokens: 512, maxOutputTokens: 24 },
      }
      const result = await ai.saveProfile({ config })
      if (!result.ok) throw new Error(result.error.message)
      await ai.setRouting({ defaultProfileId: null, byFeature: { bookSummary: result.data.id } })
      return result.data.id
    }, fake.url)

    async function summarize(chapters) {
      return page.evaluate(async (texts) => {
        const { ai } = await import('/src/ai-provider/index.ts')
        const cacheHits = []
        for (const text of texts) {
          const planned = await ai.prepareChapterSummary({ feature: 'bookSummary', text, promptVersion: 'v1' })
          if (!planned.ok) throw new Error(planned.error.message)
          const plan = planned.data
          cacheHits.push(plan.hit)
          if (plan.hit) continue
          const results = []
          for (const chunk of plan.chunks) {
            const run = ai.generate({ ...plan.route, messages: [{ role: 'user', text: chunk.text }] })
            for await (const event of run.events) {
              if (event.type === 'done') results.push(event.text)
              if (event.type === 'error') throw new Error(event.error.message)
            }
          }
          const saved = await ai.saveChapterSummary(plan.cacheToken, results.join('\n'))
          if (!saved.ok) throw new Error(saved.error.message)
        }
        return cacheHits
      }, chapters)
    }

    expect(await summarize(['第一章', '第二章'])).toEqual([false, false])
    expect(fake.requests).toHaveLength(2)
    await page.reload()
    expect(await summarize(['第一章', '第二章新稿'])).toEqual([true, false])
    expect(fake.requests).toHaveLength(3)
    expect(fake.requests[2].body.messages[0].content).toBe('第二章新稿')

    const invalidated = await page.evaluate(async (id) => {
      const { ai } = await import('/src/ai-provider/index.ts')
      const request = { feature: 'bookSummary', text: '第一章', promptVersion: 'v2' }
      const plan = (await ai.prepareChapterSummary(request)).data
      const original = (await ai.getConfig()).data.profiles.find((profile) => profile.id === id)
      await ai.saveProfile({ id, config: { ...original.config, model: 'new-model' } })
      const run = ai.generate({ ...plan.route, messages: [{ role: 'user', text: 'First chapter' }] })
      const first = await run.events[Symbol.asyncIterator]().next()
      await ai.clearSummaryCache()
      const write = await ai.saveChapterSummary(plan.cacheToken, 'old result')
      const after = await ai.prepareChapterSummary({ ...request, promptVersion: 'v1' })
      return { hit: plan.hit, first: first.value, write, after: after.data }
    }, id)
    expect(invalidated.hit).toBe(false)
    expect(invalidated.first.error.code).toBe('profile_changed')
    expect(invalidated.write.error.code).toBe('cache_token_expired')
    expect(invalidated.after.hit).toBe(false)
    expect(fake.requests).toHaveLength(3)
  } finally {
    await fake.close()
  }
})

test('新增缓存表时保留已有 Web 配置和设备密钥', async ({ page, providerPageUrl }) => {
  await page.goto(providerPageUrl)
  const state = await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const first = indexedDB.open('new-world-ai-providers', 1)
      first.onupgradeneeded = () => {
        const store = first.result.createObjectStore('config')
        store.put({
          profiles: [{
            id: 'prior', revision: 'v1', rememberCredentials: true,
            config: { name: 'Prior', baseUrl: 'https://example.invalid', protocol: 'openai-chat', auth: { kind: 'bearer' } },
            credentialEntry: { apiKey: 'previous-test-secret' },
          }],
          routing: { defaultProfileId: 'prior', byFeature: {} },
        }, 'state')
      }
      first.onsuccess = () => { first.result.close(); resolve() }
      first.onerror = () => reject(first.error)
    })
    const { ai } = await import('/src/ai-provider/index.ts')
    await ai.clearSummaryCache()
    return ai.getConfig()
  })
  expect(state.data.routing.defaultProfileId).toBe('prior')
  expect(state.data.profiles[0]).toMatchObject({ id: 'prior', hasApiKey: true, rememberCredentials: true })
  expect(JSON.stringify(state)).not.toContain('previous-test-secret')
})
