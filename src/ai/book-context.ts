import type { ProfileConfig } from '../ai-provider'
import { chapterText } from '../documents/model'
import type { Edition, EditionKey } from '../documents/model'
import { readBundle } from '../documents/store'
import { t } from '../i18n'
import { storyCardApplies, storyCards } from '../story-settings/model'
import type { StoryCard, StoryScene } from '../story-settings/model'
import { readStorySettings } from '../story-settings/store'
import type { ChatTurn } from './book-chat-model'
import { assembleBookMessages } from './context-budget'
import type { ContextText } from './context-budget'
import { bookQuestionInstructions } from './prompts'
import { cachedBookSummaries } from './review'

export interface BookRequestSource {
  edition: Edition
  bookTitle: string
  chapterId: string
  chapterTitle: string
  currentText: string
}

const normalize = (text: string) => text.normalize('NFKC').toLowerCase()
export const contextTokensFor = (config: ProfileConfig) => config.generation?.contextTokens ?? 8192

export async function readBookContext(edition: EditionKey) {
  const [bundle, settings] = await Promise.all([readBundle(edition), readStorySettings(edition)])
  return { bundle, settings }
}

function nameMatcher(name: string): (text: string) => boolean {
  const term = normalize(name.trim())
  if (!term) return () => false
  if (/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u.test(term)) return (text) => text.includes(term)
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?:^|[^\\p{sc=Latin}\\p{N}_])${escaped}(?![\\p{sc=Latin}\\p{N}_])`, 'u')
  return (text) => pattern.test(text)
}

export function storyContextCards(scene: StoryScene, edition: Edition, chapterId: string, manuscript: string, includeUnlinked = false) {
  const text = normalize(manuscript)
  const tags = new Map(scene.tags.map(({ id, name }) => [id, name]))
  const number = edition.chapters.findIndex(({ id }) => id === chapterId) + 1
  const chapters = new Map(edition.chapters.slice(0, number).map(({ id, title }, index) => [id, { number: index + 1, title }]))
  const priority = (card: StoryCard) => card.wholeBook ? 0
    : storyCardApplies(card, { editionId: edition.id, chapterId }) ? 1
    : [card.name, ...card.aliases].some((name) => nameMatcher(name)(text)) ? 2 : 3
  return storyCards(scene).map((card) => ({ card, rank: priority(card) }))
    .filter(({ rank }) => includeUnlinked || rank < 3).sort((a, b) => a.rank - b.rank)
    .map(({ card }) => {
      const states = card.states.flatMap((state) => {
        const chapter = state.editionId === edition.id ? chapters.get(state.chapterId) : undefined
        return chapter ? [{ ...chapter, text: state.text }] : []
      }).sort((a, b) => a.number - b.number)
      return { id: card.id, name: card.name, aliases: card.aliases, tags: card.tagIds.flatMap((id) => tags.get(id) ?? []),
        fields: card.fields, body: card.body, states }
    })
}

function chapterNumbers(question: string) {
  const numbers = new Set(Array.from(question.matchAll(/\b(?:chapter|ch\.?)\s*(\d+)\b/g), ([, number]) => Number(number)))
  for (const [, number] of question.matchAll(/第\s*([\d零〇一二两三四五六七八九十百千]+)\s*[章回节]/g)) {
    if (/^\d+$/.test(number)) { numbers.add(Number(number)); continue }
    const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
    const digits = '零一二三四五六七八九'
    let total = 0
    let digit = 0
    for (const character of number) {
      if (units[character]) { total += (digit || 1) * units[character]; digit = 0 }
      else digit = digit * 10 + Math.max(0, digits.indexOf(character === '两' ? '二' : character))
    }
    numbers.add(total + digit)
  }
  return numbers
}

const words = new Intl.Segmenter('zh', { granularity: 'word' })
const common = new Set('what where when who why which how about could would should tell happened the that this was were did does for from with and into they them have then later 什么 为什么 怎么 怎么样 如何 发生 后来 时候 情节 章节 小说 人物 这里 那里 语气 节奏 段落'.split(' '))

/** Rank explicit chapter references first, then plot details corroborated by the local manuscript or cache. */
function relatedChapters(question: string, chapters: readonly ContextText[], summaries: readonly (string | undefined)[]) {
  const numbers = chapterNumbers(question)
  const quotes = Array.from(question.matchAll(/["“「『《]([^"”」』》\r\n]{2,})["”」』》]/g), ([, phrase]) => phrase)
  const terms = [...new Set(Array.from(words.segment(question))
    .filter(({ isWordLike, segment }) => isWordLike && segment.length >= 2 && !common.has(segment) && !/^\d+$/.test(segment))
    .map(({ segment }) => segment))].slice(0, 12)
  const plotQuestion = /谁|哪[里儿]|为什么|怎么|发生|何时|后来|\b(?:who|where|why|when|happened)\b/.test(question)
  const matchers = terms.map((term) => ({ term, matches: nameMatcher(term) }))
  const matches = chapters.map((chapter) => {
    const explicit = numbers.has(chapter.number) || (chapter.title.length > 1 && nameMatcher(chapter.title)(question))
    const text = normalize(chapter.text)
    const summary = normalize(summaries[chapter.number - 1] ?? '')
    const quote = quotes.find((phrase) => text.includes(phrase) || summary.includes(phrase))
    const hits = matchers.filter(({ matches }) => matches(text) || matches(summary)).map(({ term }) => term)
    return { chapter, explicit, quote, hits, text }
  })
  const frequency = new Map(terms.map((term) => [term, matches.filter(({ hits }) => hits.includes(term)).length]))
  return matches.flatMap(({ chapter, explicit, quote, hits, text }) => {
    const distinctive = hits.some((term) => frequency.get(term) === 1)
    if (!explicit && !quote && hits.length < 2 && !(plotQuestion && distinctive)) return []
    const focus = [quote, ...hits].map((term) => term ? text.indexOf(term) : -1).find((index) => index >= 0)
    const score = (explicit ? 100 : 0) + (quote ? 20 : 0) + hits.reduce((sum, term) => sum + 1 / (frequency.get(term) ?? 1), 0)
    return [{ ...chapter, focus, score }]
  }).sort((a, b) => b.score - a.score || a.number - b.number).slice(0, 3)
}

export async function buildBookQuestion(source: BookRequestSource, config: ProfileConfig, question: string,
  history: readonly ChatTurn[], selection?: string, stopped: () => boolean = () => false) {
  const { edition, bookTitle, chapterId, chapterTitle, currentText } = source
  const { bundle, settings } = await readBookContext(edition)
  if (stopped()) return
  const currentIndex = bundle.edition.chapters.findIndex(({ id }) => id === chapterId)
  if (currentIndex < 0) throw new Error(t('aiContext.readFailed'))
  const chapters = bundle.chapters.map(({ title, content }, index) => ({
    title: index === currentIndex ? chapterTitle : title,
    number: index + 1, text: index === currentIndex ? currentText : chapterText(content),
  }))
  const current = chapters[currentIndex]
  const combined = [currentText, selection, question].filter(Boolean).join('\n')
  const cards = storyContextCards(settings.board.scene, bundle.edition, chapterId, combined)
    .map(({ id: _id, ...card }) => ({ name: card.name, text: JSON.stringify(card) }))
  const system = bookQuestionInstructions(Boolean(selection))
  const input = {
    ...system, config, contextTokens: contextTokensFor(config),
    question, selection, history, bookTitle, current: { ...current, focus: selection ? currentText.indexOf(selection) : undefined },
    cards, summaries: [], excerpts: [],
  }
  const primary = assembleBookMessages(input)
  if (primary.sources.clipped) return primary
  const cached = await cachedBookSummaries(bookTitle, chapters)
  if (stopped()) return
  const chapterSummaries = cached.ok ? cached.data.chapters : []
  const summaries = chapters.flatMap(({ title, number }) => {
    const text = chapterSummaries[number - 1]
    return text ? [{ title, number, text }] : []
  })
  const excerpts = relatedChapters(normalize(question), chapters.filter((chapter) => chapter !== current), chapterSummaries)
  return assembleBookMessages({ ...input, bookSummary: cached.ok ? cached.data.book : undefined, summaries, excerpts })
}
