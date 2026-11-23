import { conservativeTokens, outputLimit } from '../../shared/ai-provider/summary.mjs'
import type { CompletionRequest, ProfileConfig } from '../ai-provider'
import type { ChatTurn, ContextChapter, ContextSources } from './book-chat-model'

export interface ContextText extends ContextChapter {
  text: string
  /** A matching position to keep if only part of the chapter fits. */
  focus?: number
}

interface ContextInput {
  config: ProfileConfig
  contextTokens: number
  system: string
  shortSystem: string
  question: string
  selection?: string
  history: readonly ChatTurn[]
  bookTitle: string
  current: ContextText
  cards: readonly { name: string; text: string }[]
  bookSummary?: string
  summaries: readonly ContextText[]
  excerpts: readonly ContextText[]
}

const frameTokens = 8
const encoder = new TextEncoder()
const bookStart = '[BOOK CONTEXT]\n'
const bookEnd = '[/BOOK CONTEXT]\n\n'

function prefix(text: string, budget: number) {
  if (budget <= 0) return ''
  if (text.length * 3 <= budget) return text
  const { read } = encoder.encodeInto(text, new Uint8Array(Math.min(budget, text.length * 3)))
  return text.slice(0, read)
}

function excerpt(text: string, budget: number, focus?: number) {
  if (conservativeTokens(text) <= budget) return text
  const from = focus === undefined ? 0 : Math.max(0, focus - Math.floor(budget / 8))
  // Move off a low surrogate if the excerpt would start inside a Unicode character.
  const start = from > 0 && /[\uDC00-\uDFFF]/.test(text[from] ?? '') ? from - 1 : from
  const marker = start > 0 ? '…\n' : ''
  const room = budget - conservativeTokens(marker)
  const content = prefix(text.slice(start), room - conservativeTokens('\n…'))
  if (!content) return prefix(text, budget)
  return marker + content + '\n…'
}

function chapterHeading(chapter: ContextChapter) {
  return `${chapter.number} ${JSON.stringify(chapter.title)}`
}

function chapterSource({ number, title }: ContextChapter) {
  return { number, title }
}

/** Packs messages by priority, counting UTF-8 bytes as a conservative token estimate. */
export function assembleBookMessages(input: ContextInput): { messages: CompletionRequest['messages']; sources: ContextSources } {
  const { config, contextTokens, history } = input
  const configured = outputLimit(config)
  const output = typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0
    ? configured : Math.min(1024, Math.floor(contextTokens / 4))
  const budget = Math.max(0, contextTokens - Math.min(output, Math.max(0, contextTokens - conservativeTokens(input.shortSystem) - 64)))
  // The current question is needed even with a context too small for the full instructions.
  const questionBudget = Math.max(0, budget - frameTokens)
  const systemRoom = questionBudget - frameTokens - Math.min(conservativeTokens(input.question), Math.ceil(questionBudget / 2))
  const system = conservativeTokens(input.system) <= systemRoom ? input.system
    : conservativeTokens(input.shortSystem) <= systemRoom ? input.shortSystem : ''
  let remaining = questionBudget - (system ? conservativeTokens(system) + frameTokens : 0)
  const question = excerpt(input.question, remaining)
  remaining -= conservativeTokens(question)
  const sources: ContextSources = {
    selectedText: false, cards: [], bookSummary: false, summaries: [], excerpts: [], clipped: question !== input.question,
  }
  if (!question.trim()) return { messages: [], sources }
  const historyMessages: CompletionRequest['messages'] = []
  // Keep recent complete turns together, leaving most of the remaining room for the book.
  let historyRoom = Math.floor(remaining / 4)
  for (let i = history.length - 1; i >= 0; i--) {
    const { question, reply } = history[i]
    if (!reply?.text || (reply.status !== 'complete' && reply.status !== 'truncated')) continue
    const weight = conservativeTokens(question) + conservativeTokens(reply.text) + 2 * frameTokens
    if (weight > historyRoom) {
      if (!historyMessages.length && historyRoom > 2 * frameTokens + 32) {
        const user = excerpt(question, Math.floor((historyRoom - 2 * frameTokens) / 2))
        const answer = excerpt(reply.text, historyRoom - 2 * frameTokens - conservativeTokens(user))
        if (user && answer) {
          historyMessages.push({ role: 'user', text: user }, { role: 'assistant', text: answer })
          remaining -= conservativeTokens(user) + conservativeTokens(answer) + 2 * frameTokens
        }
      }
      break
    }
    historyRoom -= weight
    remaining -= weight
    historyMessages.unshift({ role: 'user', text: question }, { role: 'assistant', text: reply.text })
  }

  const parts: string[] = []
  const opening = bookStart + `BOOK ${JSON.stringify(input.bookTitle)}\n\n`
  remaining -= conservativeTokens(opening + bookEnd)
  function add(heading: string, text: string, clip = false, focus?: number) {
    const start = `[${heading}]\n`
    const end = '\n\n'
    const space = remaining - conservativeTokens(start + end)
    if (space < 0 || (text && space === 0)) { sources.clipped = true; return false }
    const included = clip ? excerpt(text, space, focus) : text
    const size = conservativeTokens(included)
    if (size > space || (text && !included)) { sources.clipped = true; return false }
    if (included !== text) sources.clipped = true
    parts.push(start + included + end)
    remaining = space - size
    return true
  }

  if (input.selection) sources.selectedText = add('SELECTED TEXT', input.selection, true)
  if (!sources.clipped && add(`CURRENT CHAPTER ${chapterHeading(input.current)}`, input.current.text, true, input.current.focus)) {
    sources.current = chapterSource(input.current)
  }
  if (!sources.clipped) for (const card of input.cards) {
    if (!add('STORY CARD', card.text)) break
    sources.cards.push(card.name)
  }
  if (!sources.clipped && input.bookSummary && add('BOOK SUMMARY', input.bookSummary)) sources.bookSummary = true
  if (!sources.clipped) for (const chapter of input.summaries) {
    if (!add(`CHAPTER SUMMARY ${chapterHeading(chapter)}`, chapter.text)) break
    sources.summaries.push(chapterSource(chapter))
  }
  if (!sources.clipped) for (const chapter of input.excerpts) {
    if (!add(`RELATED CHAPTER ${chapterHeading(chapter)}`, chapter.text, true, chapter.focus)) break
    sources.excerpts.push(chapterSource(chapter))
    if (sources.clipped) break
  }
  const context = parts.length ? opening + parts.join('') + bookEnd : ''
  const messages: CompletionRequest['messages'] = [
    ...(system ? [{ role: 'system' as const, text: system }] : []),
    ...historyMessages,
    { role: 'user', text: context + question },
  ]
  return { messages, sources }
}
