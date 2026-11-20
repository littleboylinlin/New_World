import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeAiService, fakeText, unauthorizedBody } from '../helpers/fake-ai.mjs'
import { createProviderClient } from '../../shared/ai-provider/client.mjs'

const client = createProviderClient()
const messages = [{ role: 'system', text: 'Instructions' }, { role: 'user', text: 'Text' }]

function target(url, protocol = 'openai-chat', options = {}, credentials = {}) {
  return { config: { name: 'Test', protocol, baseUrl: url, auth: { kind: 'none' }, model: 'example', ...options }, credentials }
}

async function run(profile, request = {}, signal = new AbortController().signal) {
  return Array.fromAsync(client.generate(profile, { messages, ...request }, signal))
}

for (const [protocol, path, options, params] of [
  ['openai-chat', '/prefix/v1/chat/completions', { reasoningEffort: 'low' }, { max_completion_tokens: 84, reasoning_effort: 'low' }],
  ['openai-responses', '/prefix/v1/responses', { reasoningEffort: 'low' }, { max_output_tokens: 84, reasoning: { effort: 'low' }, store: false }],
  ['anthropic-messages', '/prefix/v1/messages', { thinkingBudgetTokens: 30 }, { max_tokens: 84, thinking: { type: 'enabled', budget_tokens: 30 }, system: 'Instructions' }],
  ['gemini-generate-content', '/prefix/v1/models/example:generateContent', { reasoningEffort: 'low' }, { generationConfig: {
    temperature: 0, topP: 0.8, maxOutputTokens: 84, thinkingConfig: { thinkingLevel: 'LOW' },
  } }],
]) {
  test(`${protocol} supports text, streaming and per-call options`, async (t) => {
    const fake = await fakeAiService()
    t.after(fake.close)
    const profile = target(`${fake.url}/prefix/v1?version=custom`, protocol, {
      generation: { temperature: 1, maxOutputTokens: 84, topP: 0.8, contextTokens: 4096, ...options },
    })
    const nonStreaming = await run(profile, { stream: false, generation: { temperature: 0 } })
    assert.equal(nonStreaming.length, 1)
    assert.equal(nonStreaming[0].text, fakeText)
    const [sent] = fake.requests
    assert.equal(sent.url.pathname, path)
    assert.equal(sent.url.searchParams.get('version'), 'custom')
    for (const [key, value] of Object.entries(params)) assert.deepEqual(sent.body[key], value)
    assert.equal(sent.body.contextTokens, undefined)
    if (protocol !== 'gemini-generate-content') {
      assert.equal(sent.body.temperature, 0)
      assert.equal(sent.body.top_p, 0.8)
      assert.equal(sent.body.stream, false)
    }
    assert.equal(profile.config.generation.temperature, 1)

    const events = await run(profile)
    assert.deepEqual(events.map((event) => event.type), ['delta', 'done'])
    assert.equal(events[0].text, fakeText)
    assert.equal(events[1].text, fakeText)
    if (protocol === 'gemini-generate-content') {
      assert.equal(fake.requests[1].url.pathname, '/prefix/v1/models/example:streamGenerateContent')
      assert.equal(fake.requests[1].url.searchParams.get('alt'), 'sse')
    }
  })
}

test('custom endpoints, four auth modes, secret headers and body priority', async (t) => {
  const fake = await fakeAiService()
  t.after(fake.close)
  for (const [auth, check] of [
    [{ kind: 'bearer' }, ({ headers }) => assert.equal(headers.authorization, 'Bearer abc')],
    [{ kind: 'x-api-key' }, ({ headers }) => assert.equal(headers['x-api-key'], 'abc')],
    [{ kind: 'header', name: 'X-Token', prefix: 'Token ' }, ({ headers }) => assert.equal(headers['x-token'], 'Token abc')],
    [{ kind: 'query', name: 'key' }, ({ url }) => assert.equal(url.searchParams.get('key'), 'abc')],
  ]) {
    const result = await run(target(`${fake.url}/relay/v1?key=old`, 'openai-chat', {
      paths: { stream: '/custom-stream?key=local' }, auth,
      headers: [{ name: 'X-Extra', value: 'value' }, { name: 'X-Relay-Secret', secretRef: 'relay' }],
      extraBody: { model: 'wrong', messages: ['wrong'], stream: false, tools: [{ type: 'example' }] },
    }, { apiKey: 'abc', headerSecrets: { relay: 'secret-value' } }))
    assert.equal(result.at(-1).type, 'done')
    const sent = fake.requests.at(-1)
    check(sent)
    assert.equal(sent.url.pathname, '/custom-stream')
    assert.equal(sent.headers['x-extra'], 'value')
    assert.equal(sent.headers['x-relay-secret'], 'secret-value')
    assert.equal(sent.body.model, 'example')
    assert.equal(sent.body.messages[1].content, 'Text')
    assert.equal(sent.body.stream, true)
    assert.equal(sent.body.temperature, undefined)
    assert.deepEqual(sent.body.tools, [{ type: 'example' }])
  }

  const nested = target(`${fake.url}/v1`, 'openai-responses', {
    generation: { reasoningEffort: 'low' }, extraBody: { reasoning: { summary: 'auto' } },
  })
  assert.equal((await run(nested)).at(-1).type, 'done')
  assert.deepEqual(fake.requests.at(-1).body.reasoning, { effort: 'low', summary: 'auto' })

  const crossOrigin = target(fake.url, 'openai-chat', { paths: { generate: '//other.invalid/chat/completions' } })
  assert.equal((await run(crossOrigin, { stream: false }))[0].error.code, 'invalid_config')
})

test('requests distinguish timeout, authorization, rate limits and quota and leave redirects alone', async (t) => {
  const fake = await fakeAiService()
  t.after(fake.close)
  for (const [path, code, status] of [
    ['timeout', 'timeout', undefined], ['unauthorized', 'unauthorized', 401],
    ['rate', 'rate_limited', 429], ['quota', 'quota_exceeded', 429],
    ['billing', 'quota_exceeded', 400], ['daily', 'quota_exceeded', 429],
    ['redirect', 'http_error', 307],
  ]) {
    const profile = target(`${fake.url}/${path}/v1`, 'openai-chat', {
      timeoutMs: path === 'timeout' ? 120 : 3000,
    })
    const result = await client.testConnection(profile, false)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, code)
    assert.equal(result.httpStatus, status)
    if (path === 'unauthorized') assert.equal(result.rawErrorBody, unauthorizedBody)
    if (path === 'rate') assert.equal(result.error.retryAfterMs, 0)
  }
  const streamError = await client.testConnection(target(`${fake.url}/stream-error/v1`), true)
  assert.equal(streamError.httpStatus, 200)
  assert.equal(streamError.error.code, 'quota_exceeded')
  assert.match(streamError.rawErrorBody, /stream quota/)
})

test('connection probe uses fixed text and a small output limit', async (t) => {
  const fake = await fakeAiService()
  t.after(fake.close)
  const profile = target(fake.url, 'anthropic-messages', {
    extraBody: { max_tokens: 4000, messages: [{ role: 'user', content: 'other text' }], system: 'other instructions' },
  })
  assert.deepEqual(await client.testConnection(profile, false), { ok: true, httpStatus: 200 })
  assert.deepEqual(fake.requests[0].body, {
    model: 'example', stream: false, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }],
  })
  assert.equal((await run(target(fake.url, 'anthropic-messages')))[0].error.code, 'invalid_config')
})

test('models can be paged without a configured model, and an unavailable list leaves generation usable', async (t) => {
  const fake = await fakeAiService()
  t.after(fake.close)
  const profile = target(`${fake.url}/gemini/v1beta`, 'gemini-generate-content', { model: undefined })
  const models = await client.listModels(profile)
  assert.deepEqual(models, { ok: true, data: { models: [{ id: 'example', displayName: 'Example' }], nextCursor: 'cursor' } })
  assert.equal((await client.listModels(profile, models.data.nextCursor)).data.nextCursor, undefined)
  const manual = target(`${fake.url}/no-models/v1`)
  assert.equal((await client.listModels(manual)).error.httpStatus, 404)
  assert.equal((await run(manual)).at(-1).type, 'done')
})

test('retry before text, never after partial output or for quota, and cancel the real request', async (t) => {
  const fake = await fakeAiService()
  t.after(fake.close)
  for (const [path, expected, count] of [
    ['retry', 'done', 2], ['partial-error', 'error', 1], ['quota', 'error', 1], ['truncated', 'error', 1],
  ]) {
    const events = await run(target(`${fake.url}/${path}/v1`, 'openai-chat', { retries: 2 }))
    assert.equal(events.at(-1).type, expected)
    assert.equal(fake.requests.filter((request) => request.url.pathname.includes(`/${path}/`)).length, count)
  }

  const abort = new AbortController()
  const iterator = client.generate(target(`${fake.url}/hang/v1`), { messages }, abort.signal)
  assert.equal((await iterator.next()).value.type, 'delta')
  abort.abort()
  assert.deepEqual((await iterator.next()).value, { type: 'cancelled' })
  assert.equal((await iterator.next()).done, true)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(fake.requests.at(-1).closed, true)
})
