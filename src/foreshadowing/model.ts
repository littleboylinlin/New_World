import { maxTitleLength } from '../library'
import type { Book, LibraryId, TrashEntry } from '../library'

export interface ForeshadowingWork {
  library: LibraryId
  bookId: string
}

export interface ChapterTarget {
  editionId: string
  chapterId: string
}

export interface ForeshadowingLocation {
  chapter?: ChapterTarget & { title: string }
  note: string
}

export interface ForeshadowingFields {
  title: string
  description: string
  setups: ForeshadowingLocation[]
  payoffs: ForeshadowingLocation[]
  resolved: boolean
  notes: string
}

export interface Foreshadowing extends ForeshadowingWork, ForeshadowingFields {
  id: string
  revision: string
  updatedAt: number
}

export const maxForeshadowingText = 20_000
export const chapterTargetKey = ({ editionId, chapterId }: ChapterTarget) => `${editionId}/${chapterId}`

export function linksChapter(item: Foreshadowing, target: ChapterTarget) {
  const linked = ({ chapter }: ForeshadowingLocation) => chapter?.editionId === target.editionId && chapter.chapterId === target.chapterId
  return item.setups.some(linked) || item.payoffs.some(linked)
}

const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const validTitle = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= maxTitleLength
const validText = (value: unknown): value is string => typeof value === 'string' && value.length <= maxForeshadowingText
const hasOnly = (value: object, keys: string[]) => Object.keys(value).every((key) => keys.includes(key))

function validLocation(location: ForeshadowingLocation) {
  if (!location || typeof location !== 'object' || !hasOnly(location, ['chapter', 'note']) || !validText(location.note)) return false
  const { chapter } = location
  if (chapter === undefined) return !!location.note.trim()
  return chapter && typeof chapter === 'object' && hasOnly(chapter, ['editionId', 'chapterId', 'title'])
    && uuid(chapter.editionId) && uuid(chapter.chapterId) && validTitle(chapter.title)
}

/** A removed chapter can still have a location record, where its last known name and note are kept. */
export function validForeshadowingRows(rows: unknown, books: Book[]): rows is Foreshadowing[] {
  if (!Array.isArray(rows)) return false
  const workKey = (library: LibraryId, id: string) => `${library}/${id}`
  const owners = new Set(books.filter((book) => book && !book.workId).map((book) => workKey(book.library, book.id)))
  const seen = new Set<string>()
  for (const row of rows as Foreshadowing[]) {
    if (!row || typeof row !== 'object'
      || !hasOnly(row, ['library', 'bookId', 'id', 'revision', 'updatedAt', 'title', 'description', 'setups', 'payoffs', 'resolved', 'notes'])
      || !['original', 'reference'].includes(row.library) || !uuid(row.bookId) || !uuid(row.id) || !uuid(row.revision)
      || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0
      || !validTitle(row.title) || !validText(row.description) || !validText(row.notes) || typeof row.resolved !== 'boolean'
      || !Array.isArray(row.setups) || !row.setups.every(validLocation) || !Array.isArray(row.payoffs) || !row.payoffs.every(validLocation)) return false
    const owner = workKey(row.library, row.bookId)
    const identity = `${owner}/${row.id}`
    if (!owners.has(owner) || seen.has(identity)) return false
    seen.add(identity)
  }
  return true
}

export function validTrashedForeshadowing(trash: Pick<TrashEntry, 'kind' | 'library' | 'bookId' | 'books' | 'foreshadowing'>[]) {
  return trash.every((entry) => entry && (entry.foreshadowing === undefined || (
    entry.kind === 'book' && Array.isArray(entry.books)
    && validForeshadowingRows(entry.foreshadowing, entry.books.filter((book) => book && book.id === entry.bookId && book.library === entry.library))
  )))
}
