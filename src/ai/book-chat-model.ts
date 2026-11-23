import type { Book, TrashEntry } from '../library'
import type { StoryWork } from '../story-settings/model'

export interface ContextChapter {
  number: number
  title: string
}

export interface ContextSources {
  current?: ContextChapter
  selectedText: boolean
  cards: string[]
  bookSummary: boolean
  summaries: ContextChapter[]
  excerpts: ContextChapter[]
  clipped: boolean
}

export interface ChatReply {
  text: string
  profileName: string
  context: ContextSources
  status: 'complete' | 'truncated' | 'stopped' | 'error'
}

export interface ChatTurn {
  id: string
  question: string
  reply?: ChatReply
}

export interface BookChat extends StoryWork {
  id: string
  updatedAt: number
  turns: ChatTurn[]
}

export function chatTitle(chat: BookChat) {
  const first = chat.turns[0].question.replace(/\s+/g, ' ')
  const characters = Array.from(first)
  return characters.length > 60 ? characters.slice(0, 60).join('') + '…' : first
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function chapter(value: unknown) {
  return record(value) && typeof value.number === 'number' && Number.isSafeInteger(value.number)
    && value.number > 0 && typeof value.title === 'string'
}

function context(value: unknown) {
  return record(value) && (value.current === undefined || chapter(value.current))
    && typeof value.selectedText === 'boolean'
    && Array.isArray(value.cards) && value.cards.every((name) => typeof name === 'string')
    && Array.isArray(value.summaries) && value.summaries.every(chapter)
    && Array.isArray(value.excerpts) && value.excerpts.every(chapter)
    && typeof value.bookSummary === 'boolean' && typeof value.clipped === 'boolean'
}

function turn(value: unknown): value is ChatTurn {
  if (!record(value) || typeof value.id !== 'string' || !value.id
    || typeof value.question !== 'string' || !value.question.trim()) return false
  const reply = value.reply
  return reply === undefined || (record(reply) && typeof reply.text === 'string' && typeof reply.profileName === 'string'
    && ['complete', 'truncated', 'stopped', 'error'].some((status) => reply.status === status) && context(reply.context))
}

/** Chat transcripts belong to live works or works that can still be restored from the library Trash. */
export function validBookChats(value: unknown, books: readonly Book[], trash: readonly Pick<TrashEntry, 'kind' | 'library' | 'bookId'>[]): value is BookChat[] {
  if (!Array.isArray(value)) return false
  const key = (library: unknown, bookId: unknown) => JSON.stringify([library, bookId])
  const owners = new Set(books.filter((book) => !book.workId).map((book) => key(book.library, book.id)))
  for (const entry of trash) {
    if (entry?.kind === 'book') owners.add(key(entry.library, entry.bookId))
  }
  const ids = new Set<string>()
  return value.every((chat: unknown) => {
    if (!record(chat) || typeof chat.id !== 'string' || !chat.id || ids.has(chat.id)
      || !owners.has(key(chat.library, chat.bookId)) || typeof chat.updatedAt !== 'number' || !Number.isFinite(chat.updatedAt)
      || !Array.isArray(chat.turns) || !chat.turns.length || !chat.turns.every(turn)
      || new Set(chat.turns.map(({ id }) => id)).size !== chat.turns.length) return false
    ids.add(chat.id)
    return true
  })
}
