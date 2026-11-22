import type { ChapterRecord, Edition } from '../documents/model'
import type { Book, LibraryId, TrashEntry } from '../library'

export const storyCategories = ['character', 'location', 'faction', 'item', 'rule'] as const
export type StoryCategory = typeof storyCategories[number]

export const storyFields = {
  character: ['role', 'appearance', 'motivation'],
  location: ['region', 'features'],
  faction: ['leader', 'goal'],
  item: ['owner', 'use'],
  rule: ['conditions', 'consequence'],
} as const
export type StoryField = typeof storyFields[StoryCategory][number]

export const storyLimits = {
  name: 255, summary: 500, details: 20_000, field: 500, state: 2_000, relations: 200, chapters: 200, aliases: 100,
}

export interface StoryWork {
  library: LibraryId
  bookId: string
}

export interface StoryChapter {
  editionId: string
  chapterId: string
}

export interface StoryState extends StoryChapter {
  text: string
}

export interface StoryRelation {
  targetCardId: string
  name: string
}

export interface StoryCardInput {
  category: StoryCategory
  name: string
  aliases: string[]
  fields: Partial<Record<StoryField, string>>
  summary: string
  details: string
  chapters: StoryChapter[]
  states: StoryState[]
  relations: StoryRelation[]
}

export interface StoryCard extends StoryWork, StoryCardInput {
  id: string
  revision: string
  createdAt: number
  updatedAt: number
}

export function blankStoryCard(category: StoryCategory): StoryCardInput {
  return { category, name: '', aliases: [], fields: {}, summary: '', details: '', chapters: [], states: [], relations: [] }
}

export const storyChapterKey = ({ editionId, chapterId }: StoryChapter) => JSON.stringify([editionId, chapterId])
export const storyWorkKey = ({ library, bookId }: StoryWork) => JSON.stringify([library, bookId])
const normalized = (value: string) => value.trim().normalize('NFKC').toLowerCase()

export function uniqueAliases(name: string, aliases: string[]) {
  const seen = new Set([normalized(name), ''])
  return aliases.map((alias) => alias.trim()).filter((alias) => {
    const key = normalized(alias)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function matchesStoryCard(card: Pick<StoryCardInput, 'name' | 'aliases'>, query: string) {
  const term = normalized(query)
  return !term || [card.name, ...card.aliases].some((name) => normalized(name).includes(term))
}

/** States follow the edition's current reading order. An absent anchor never exposes a later state. */
export function storyStateAt(card: Pick<StoryCardInput, 'states'>, edition: Pick<Edition, 'id' | 'chapters'>, chapterId: string) {
  const states = new Map(card.states.filter((state) => state.editionId === edition.id).map((state) => [state.chapterId, state]))
  let state: StoryState | undefined
  for (const chapter of edition.chapters) {
    state = states.get(chapter.id) ?? state
    if (chapter.id === chapterId) return state
  }
  return undefined
}

const fieldNames = new Set<string>(Object.values(storyFields).flat())
const plain = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const line = (value: unknown): value is string => text(value, storyLimits.name) && !!value && value === value.trim() && !/[\x00-\x1f]/.test(value)
const id = (value: unknown) => text(value, 255) && !!value && !/[\x00-\x1f]/.test(value)
const time = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function distinctList<T>(value: unknown, max: number, valid: (item: unknown) => boolean, key: (item: T) => string): value is T[] {
  if (!Array.isArray(value) || value.length > max) return false
  const seen = new Set<string>()
  for (const item of value) {
    if (!valid(item)) return false
    const identity = key(item)
    if (seen.has(identity)) return false
    seen.add(identity)
  }
  return true
}

function validChapter(value: unknown, state: boolean) {
  return plain(value) && keys(value, state ? ['editionId', 'chapterId', 'text'] : ['editionId', 'chapterId'])
    && id(value.editionId) && id(value.chapterId)
    && (!state || (text(value.text, storyLimits.state) && !!value.text.trim()))
}

export function isStoryCard(value: unknown): value is StoryCard {
  if (!plain(value)) return false
  const { name, aliases } = value
  return keys(value, [
    'library', 'bookId', 'id', 'revision', 'createdAt', 'updatedAt', 'category', 'name', 'aliases', 'fields',
    'summary', 'details', 'chapters', 'states', 'relations',
  ]) && (value.library === 'original' || value.library === 'reference')
    && id(value.bookId) && id(value.id) && id(value.revision)
    && time(value.createdAt) && time(value.updatedAt)
    && storyCategories.some((category) => category === value.category)
    && line(name) && distinctList<string>(aliases, storyLimits.aliases, line, normalized)
    && !aliases.some((alias) => normalized(alias) === normalized(name))
    && plain(value.fields) && Object.entries(value.fields).every(([key, field]) => fieldNames.has(key) && text(field, storyLimits.field))
    && text(value.summary, storyLimits.summary) && text(value.details, storyLimits.details)
    && distinctList<StoryChapter>(value.chapters, storyLimits.chapters, (chapter) => validChapter(chapter, false), storyChapterKey)
    && distinctList<StoryState>(value.states, storyLimits.chapters, (state) => validChapter(state, true), storyChapterKey)
    && distinctList<StoryRelation>(value.relations, storyLimits.relations,
      (relation) => plain(relation) && keys(relation, ['targetCardId', 'name'])
        && id(relation.targetCardId) && relation.targetCardId !== value.id && line(relation.name),
      ({ targetCardId, name }) => JSON.stringify([targetCardId, normalized(name)]))
}

/** Validates the active and recycled cards as a unit for imports. Recycled cards can outlive their work. */
export function validStoryRows(cards: unknown, books: Book[], chapters: ChapterRecord[], trash: (Omit<TrashEntry, 'files'> & { files: unknown[] })[]): cards is StoryCard[] {
  if (!Array.isArray(cards) || trash.some((entry) => !entry)) return false
  if (!cards.length && trash.every((entry) => entry.kind !== 'storyCard' && entry.storyCards === undefined)) return true
  const active = new Set(books.filter((book) => !book.workId).map(({ library, id }) => storyWorkKey({ library, bookId: id })))
  const knownChapters = new Map<string, Set<string>>()
  for (const chapter of [...chapters, ...trash.flatMap((entry) => Array.isArray(entry.chapters) ? entry.chapters : [])]) {
    if (!chapter) return false
    const owners = knownChapters.get(chapter.id) ?? new Set<string>()
    owners.add(JSON.stringify([chapter.library, chapter.bookId, chapter.editionId]))
    knownChapters.set(chapter.id, owners)
  }
  const seen = new Set<string>()
  const add = (row: unknown, owner?: StoryWork) => {
    if (!isStoryCard(row)) return false
    const work = storyWorkKey(row)
    if (owner ? work !== storyWorkKey(owner) : !active.has(work)) return false
    const key = JSON.stringify([row.library, row.bookId, row.id])
    if (seen.has(key)) return false
    seen.add(key)
    return [...row.chapters, ...row.states].every(({ editionId, chapterId }) => {
      const owners = knownChapters.get(chapterId)
      return !owners || owners.has(JSON.stringify([row.library, row.bookId, editionId]))
    })
  }
  if (!cards.every((card) => add(card))) return false
  return trash.every((entry) => {
    const rows = entry.storyCards
    if (entry.kind === 'book') {
      if (rows === undefined) return true
      if (!Array.isArray(rows) || !Array.isArray(entry.books)
        || !entry.books.some((book) => book?.id === entry.bookId && book.library === entry.library && !book.workId)) return false
      return rows.every((card) => add(card, entry))
    }
    if (entry.kind === 'storyCard') {
      return Array.isArray(rows) && rows.length === 1 && add(rows[0], entry) && !entry.position && entry.ideas === undefined
        && [entry.books, entry.files, entry.editions, entry.chapters].every((value) => Array.isArray(value) && !value.length)
    }
    return rows === undefined
  })
}
