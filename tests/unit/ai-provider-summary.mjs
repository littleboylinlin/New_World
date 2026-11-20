import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chapterCacheKey, splitChapterText } from '../../shared/ai-provider/summary.mjs'

const config = {
  protocol: 'openai-chat', baseUrl: 'https://test.invalid/prefix/v1', model: 'example',
  generation: { contextTokens: 32, maxOutputTokens: 7 },
}

test('splitting keeps paragraphs where possible and exact offsets for Chinese, CRLF and emoji', () => {
  const text = '甲乙。丙丁。\r\n🙂 e\u0301 一二三四五六七八九十。\nEnd'
  const chunks = splitChapterText(config, { text, reservedPromptTokens: 5 })
  assert.equal(chunks[0].text, '甲乙。丙丁。\r\n')
  assert.equal(chunks.map((chunk) => chunk.text).join(''), text)
  let offset = 0
  for (const chunk of chunks) {
    assert.equal(chunk.start, offset)
    assert.equal(text.slice(chunk.start, chunk.end), chunk.text)
    assert.equal(chunk.estimatedTokens, Buffer.byteLength(chunk.text))
    assert.ok(chunk.estimatedTokens <= 20)
    assert.equal(chunk.text.isWellFormed(), true)
    offset = chunk.end
  }
  assert.equal(offset, text.length)
  assert.deepEqual(splitChapterText(config, { text: '' }), [])
})

test('splitting respects configured and explicit reserved output tokens and validates a missing or exhausted context', () => {
  const request = { text: '1234567890'.repeat(6), reservedPromptTokens: 0 }
  const override = { ...config, extraBody: { max_completion_tokens: 24 } }
  assert.equal(splitChapterText(override, request)[0].estimatedTokens, 8)
  assert.equal(splitChapterText(override, { ...request, reservedOutputTokens: 4 })[0].estimatedTokens, 28)
  assert.throws(() => splitChapterText(override, { ...request, reservedPromptTokens: 8 }), /Leave room/)
  assert.throws(() => splitChapterText({ ...config, generation: {} }, request), /context length/)
})

test('chapter fingerprints match only the same text, model endpoint and prompt version', async () => {
  const key = await chapterCacheKey(config, 'Chapter A', 'v1')
  assert.match(key, /^[0-9a-f]{64}$/)
  assert.equal(key, await chapterCacheKey({ ...config, name: 'Renamed' }, 'Chapter A', 'v1'))
  assert.notEqual(key, await chapterCacheKey(config, 'Chapter B', 'v1'))
  assert.notEqual(key, await chapterCacheKey(config, 'Chapter A', 'v2'))
  assert.notEqual(key, await chapterCacheKey({ ...config, model: 'other' }, 'Chapter A', 'v1'))
  assert.notEqual(key, await chapterCacheKey({ ...config, baseUrl: 'https://other.invalid/v1' }, 'Chapter A', 'v1'))
  assert.notEqual(key, await chapterCacheKey({ ...config, paths: { stream: '/other' } }, 'Chapter A', 'v1'))
})
