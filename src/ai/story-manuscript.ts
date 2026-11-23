import type { Node as ProseNode } from '@tiptap/pm/model'
import { readBlocks } from '../documents/ai-suggest'
import type { TextBlock } from '../documents/ai-suggest'
import { convertFile } from '../documents/import'
import type { DocumentContent, Edition } from '../documents/model'
import { documentNode } from '../documents/schema'
import { listEditions } from '../documents/store'
import { t } from '../i18n'
import { listBooks, readBook } from '../library'
import type { ImportedBook } from '../library'
import type { StoryWork } from '../story-settings/model'
import { readStorySettings } from '../story-settings/store'
import { readBookContext } from './book-context'

export type StorySource = { kind: 'edition'; edition: Edition } | { kind: 'original'; book: ImportedBook }

export const sourceId = (source: StorySource) => source.kind === 'edition' ? source.edition.id : source.book.id
export const sourceLabel = (source: StorySource) => source.kind === 'edition'
  ? t('storyAi.edition', [source.edition.name]) : t('storyAi.original', [source.book.originalName])

export async function storySources(work: StoryWork) {
  const [editions, books] = await Promise.all([listEditions(work.library, work.bookId), listBooks(work.library)])
  return [
    ...editions.map((edition): StorySource => ({ kind: 'edition', edition })),
    ...books.flatMap((book): StorySource[] => book.format !== 'draft' && (book.id === work.bookId || book.workId === work.bookId)
      ? [{ kind: 'original', book }] : []),
  ]
}

export interface LiveStoryChapter {
  editionId: string
  chapterId: string
  content: DocumentContent
  selection?: { from: number; to: number }
}

export interface StoryManuscriptChapter {
  id: string
  number: number
  title: string
  content: DocumentContent
  previewSection?: number
}

export async function readStoryManuscript(work: StoryWork, source: StorySource, signal: AbortSignal, live?: LiveStoryChapter) {
  if (source.kind === 'edition') {
    const { bundle, settings } = await readBookContext(source.edition)
    signal.throwIfAborted()
    const chapters: StoryManuscriptChapter[] = bundle.chapters.map(({ title, content }, index) => {
      const chapter = bundle.edition.chapters[index]
      const useLive = live?.editionId === bundle.edition.id && live.chapterId === chapter.id
      return { id: chapter.id, number: index + 1, title, content: useLive ? live.content : content }
    })
    return { title: settings.book?.title ?? source.edition.name, chapters, scene: settings.board.scene, edition: bundle.edition, notes: [] }
  }
  const [stored, settings] = await Promise.all([readBook(work.library, source.book.id), readStorySettings(work)])
  signal.throwIfAborted()
  if (!stored?.blob || (stored.book.id !== work.bookId && stored.book.workId !== work.bookId)) {
    throw new Error(t('storyAi.sourceMissing'))
  }
  const { chapters: converted, notes } = await convertFile(stored.book.format, stored.blob, signal)
  const chapters = converted.map((chapter, index): StoryManuscriptChapter => ({ ...chapter, id: String(index + 1), number: index + 1 }))
  return { title: settings.book?.title ?? source.book.title, chapters, scene: settings.board.scene, edition: undefined, notes }
}

export interface StoryAnchor {
  quote: string
  before: string
  after: string
  occurrence: number
  total: number
}

export function storyQuoteOffsets(text: string, quote: string) {
  const offsets: number[] = []
  if (quote) {
    for (let start = text.indexOf(quote); start >= 0; start = text.indexOf(quote, start + 1)) offsets.push(start)
  }
  return offsets
}

function quotePlaces(blocks: readonly TextBlock[], quote: string) {
  return blocks.flatMap((block) => storyQuoteOffsets(block.text, quote).flatMap((index) => {
    const from = block.positions[index]
    const to = block.positions[index + quote.length - 1] + 1
    // A quoted span cannot cross an inline image or a hard line break.
    return to - from === quote.length ? [{ block, index, from, to }] : []
  }))
}

export function storyAnchor(blocks: readonly TextBlock[], quote: string, from: number) {
  const locations = quotePlaces(blocks, quote)
  const occurrence = locations.findIndex((location) => location.from === from)
  if (occurrence < 0) return
  const { block, index } = locations[occurrence]
  return {
    quote, occurrence, total: locations.length,
    before: block.text.slice(Math.max(0, index - 32), index),
    after: block.text.slice(index + quote.length, index + quote.length + 32),
  }
}

export function findStoryQuote(doc: ProseNode, anchor: StoryAnchor) {
  const candidates = quotePlaces(readBlocks(doc, 0, doc.content.size), anchor.quote)
  const withContext = candidates.filter(({ block, index }) => block.text.slice(0, index).endsWith(anchor.before)
    && block.text.startsWith(anchor.after, index + anchor.quote.length))
  const occurrence = candidates[anchor.occurrence]
  const match = withContext.length === 1 && (anchor.before || anchor.after) ? withContext[0]
    : candidates.length === anchor.total && (anchor.total === 1 || withContext.includes(occurrence)) ? occurrence : undefined
  return match && { from: match.from, to: match.to }
}
