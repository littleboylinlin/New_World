import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClarification } from '../../src/ai/clarification.ts'
import { assembleBookMessages } from '../../src/ai/context-budget.ts'

const current = { number: 2, title: 'Current', text: '当前章节🙂'.repeat(12) }
const other = { number: 1, title: 'Earlier' }
const input = {
  config: { protocol: 'openai-chat', generation: { maxOutputTokens: 64 } },
  system: 'Story rules', shortSystem: 'Rules', question: 'Where was the key?',
  selection: 'A little of the current text', history: [], bookTitle: 'The crossing',
  current, cards: [{ name: 'Merchant', text: 'Setting card details'.repeat(9) }],
  bookSummary: 'Book synopsis'.repeat(9),
  summaries: [{ ...other, text: 'First chapter summary'.repeat(7) }],
  excerpts: [{ ...other, text: 'Earlier manuscript text'.repeat(15) }],
}

test('book context keeps the current chapter, then setting cards, then summaries, before the related chapter text', () => {
  const plan = (contextTokens) => {
    const result = assembleBookMessages({ ...input, contextTokens })
    const size = result.messages.reduce((sum, { text }) => sum + Buffer.byteLength(text) + 8, 0)
    assert.ok(size + 64 <= contextTokens)
    return result
  }
  const full = plan(1600)
  const text = full.messages.at(-1).text
  const headers = ['SELECTED TEXT', 'CURRENT CHAPTER', 'STORY CARD', 'BOOK SUMMARY', 'CHAPTER SUMMARY', 'RELATED CHAPTER']
    .map((part) => text.indexOf(`[${part}`))
  assert.ok(headers.every((offset, index) => offset > (headers[index - 1] ?? -1)))
  assert.equal(full.sources.clipped, false)
  assert.deepEqual(full.sources.excerpts, [other])
  const before = (heading) => Buffer.byteLength(input.system)
    + Buffer.byteLength(text.slice(0, text.indexOf(heading)) + '[/BOOK CONTEXT]\n\n' + input.question) + 16 + 64
  const noRaw = plan(before('[RELATED CHAPTER'))
  assert.deepEqual(noRaw.sources.summaries, [other])
  assert.deepEqual(noRaw.sources.excerpts, [])
  assert.equal(noRaw.sources.clipped, true)
  const noSummaries = plan(before('[BOOK SUMMARY'))
  assert.deepEqual(noSummaries.sources.cards, ['Merchant'])
  assert.equal(noSummaries.sources.bookSummary, false)
  assert.deepEqual(noSummaries.sources.summaries, [])
  const noCards = plan(before('[STORY CARD'))
  assert.deepEqual(noCards.sources.cards, [])
  assert.ok(noCards.messages.at(-1).text.includes(current.text))
  const chapterOnly = plan(before('[STORY CARD') - 100)
  assert.equal(chapterOnly.sources.current?.number, 2)
  assert.equal(chapterOnly.sources.selectedText, true)
  assert.equal(chapterOnly.sources.clipped, true)
  assert.ok(!chapterOnly.messages.at(-1).text.includes(current.text))
  assert.equal(chapterOnly.messages.at(-1).text.isWellFormed(), true)
})

test('a bounded book request keeps recent complete turns and degrades safely at very small limits', () => {
  const turn = (question, text) => ({ question, reply: { text, status: 'complete' } })
  const history = [turn('old', 'x'.repeat(1000)), turn('recent', 'the clue')]
  const plan = assembleBookMessages({ ...input, history, contextTokens: 650 })
  assert.deepEqual(plan.messages.map(({ role }) => role), ['system', 'user', 'assistant', 'user'])
  assert.equal(plan.messages[1].text, 'recent')
  assert.equal(plan.messages[2].text, 'the clue')
  assert.ok(plan.messages.at(-1).text.endsWith(input.question))
  const one = assembleBookMessages({ ...input, contextTokens: 1, question: '为什么？' })
  assert.deepEqual(one.messages, [])
  assert.equal(one.sources.clipped, true)
})

test('clarification reads one complete round with two to four distinct choices per question', () => {
  const questions = [
    { question: 'Keep the letter?', options: ['Keep it', 'Discard it'] },
    { question: 'Whose letter?', options: ['The merchant', 'The guard', 'Someone else'] },
  ]
  const block = `I need two details.\r\n[NW_CHOICES]\r\n${JSON.stringify(questions)}\r\n[/NW_CHOICES]`
  assert.deepEqual(parseClarification(block), { text: 'I need two details.', questions })
  const malformed = [
    'Just an answer.', '[NW_CHOICES]\n{invalid\n[/NW_CHOICES]', block + ' trailing text',
    block + '\n' + block, block.replace('Discard it', 'Keep it'),
    '[NW_CHOICES]\n[{"question":"Only one?","options":["Yes"]}]\n[/NW_CHOICES]',
    '[NW_CHOICES]\n[{"question":"Too many?","options":["a","b","c","d","e"]}]\n[/NW_CHOICES]',
  ]
  for (const text of malformed) assert.deepEqual(parseClarification(text), { text })
})
