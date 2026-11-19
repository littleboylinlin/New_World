// Side-by-side reading: what a reference pane can show, the works it can be picked from, and how
// each edition's split layout is remembered on this device.

import { t } from '../i18n'
import { listBooks, openDatabase, resultOf } from '../library'
import type { Book, ImportedBook, LibraryId } from '../library'
import { readTree } from '../shell/split-tree'
import { isWebUrl } from '../web-search'
import type { SplitTree } from '../shell/split-tree'
import type { Edition, EditionKey } from './model'

/** A chapter of any editable version, or the original file of an imported work. Always read-only. */
export type ReferenceSource =
  | { kind: 'chapter'; library: LibraryId; bookId: string; editionId: string; chapterId: string }
  | { kind: 'file'; library: LibraryId; bookId: string }

/** A private web page (desktop only). Its address is never stored, so it is never restored. */
export type WebSource = { kind: 'web'; url?: string }
/** Anything a pane beside the text can show. */
export type PaneSource = ReferenceSource | WebSource

export const mainPane = 'main'

const libraryIds: LibraryId[] = ['original', 'reference']
const uuid = /^[0-9a-f-]{36}$/

export function readSource(raw: unknown): ReferenceSource | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (!libraryIds.includes(value.library as LibraryId) || typeof value.bookId !== 'string' || !uuid.test(value.bookId)) return undefined
  const library = value.library as LibraryId
  if (value.kind === 'file') return { kind: 'file', library, bookId: value.bookId }
  if (value.kind === 'chapter' && typeof value.editionId === 'string' && uuid.test(value.editionId) && typeof value.chapterId === 'string' && uuid.test(value.chapterId)) {
    return { kind: 'chapter', library, bookId: value.bookId, editionId: value.editionId, chapterId: value.chapterId }
  }
  return undefined
}

export function sameSource(a: PaneSource, b: PaneSource) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A route that shows one source on its own, used by the desktop's separate reading windows. */
export function sourceRoute(source: ReferenceSource) {
  const parts = source.kind === 'chapter' ? [source.library, source.bookId, source.editionId, source.chapterId] : [source.library, source.bookId, 'file']
  return `#/compare/${parts.join('/')}`
}

export function parseSourceRoute(hash: string): ReferenceSource | undefined {
  const match = hash.match(/^#\/compare\/(original|reference)\/([0-9a-f-]{36})\/(?:file|([0-9a-f-]{36})\/([0-9a-f-]{36}))\/?$/)
  if (!match) return undefined
  return readSource(match[3] ? { kind: 'chapter', library: match[1], bookId: match[2], editionId: match[3], chapterId: match[4] } : { kind: 'file', library: match[1], bookId: match[2] })
}

// ——— The works a reference can come from ———

export interface CatalogWork {
  book: Book
  editions: Edition[]
  /** Original files that can be read: the work's own, or a continuation project's sources. */
  files: ImportedBook[]
}

/** Every work on the shelves, with its editable versions and readable original files. */
export async function readCatalog(): Promise<CatalogWork[]> {
  const [books, editions] = await Promise.all([
    Promise.all(libraryIds.map(listBooks)).then((lists) => lists.flat()),
    openDatabase().then((db) => resultOf<Edition[]>(db.transaction('editions').objectStore('editions').getAll())),
  ])
  const readable = (book: Book): book is ImportedBook => book.format !== 'draft'
  return books.filter((book) => !book.workId && !book.archivedAt).map((book) => ({
    book,
    editions: editions.filter((edition) => edition.library === book.library && edition.bookId === book.id).sort((a, b) => a.createdAt - b.createdAt),
    files: [
      ...(readable(book) ? [book] : []),
      ...books.filter((other): other is ImportedBook => other.library === book.library && other.workId === book.id && readable(other)),
    ],
  }))
}

export function sourceTitle(catalog: CatalogWork[], source: ReferenceSource) {
  for (const work of catalog) {
    if (source.kind === 'file') {
      const file = work.files.find((item) => item.library === source.library && item.id === source.bookId)
      if (file) return { work: work.book.title, part: file === work.book ? t('compare.originalFile') : file.title }
    } else if (work.book.library === source.library && work.book.id === source.bookId) {
      const edition = work.editions.find((item) => item.id === source.editionId)
      const chapter = edition?.chapters.find((item) => item.id === source.chapterId)
      return { work: work.book.title, part: chapter?.title ?? t('editor.chapterRemoved') }
    }
  }
  return { work: t('compare.missing'), part: '' }
}

// ——— Remembered layouts ———

export interface SplitLayout {
  tree: SplitTree
  panes: Record<string, ReferenceSource>
  focused?: string
  at: number
}

const layoutsKey = 'new-world:editor-split'
const placesKey = 'new-world:reading-places'
const maxLayouts = 120
const maxFilePlaces = 200

function readJson(key: string): Record<string, unknown> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null')
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Only a convenience. */ }
}
function trim<T extends { at: number }>(record: Record<string, T>, limit: number) {
  const entries = Object.entries(record)
  if (entries.length <= limit) return record
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, limit))
}

const layoutKey = (edition: EditionKey) => `${edition.library}/${edition.bookId}/${edition.id}`

export function readLayout(edition: EditionKey): SplitLayout | undefined {
  const raw = readJson(layoutsKey)[layoutKey(edition)] as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object') return undefined
  const tree = readTree(raw.tree)
  if (!tree) return undefined
  const panes: Record<string, ReferenceSource> = {}
  const stored = raw.panes && typeof raw.panes === 'object' ? raw.panes as Record<string, unknown> : {}
  for (const [id, value] of Object.entries(stored)) {
    const source = readSource(value)
    if (source && id !== mainPane) panes[id] = source
  }
  return { tree, panes, focused: typeof raw.focused === 'string' ? raw.focused : undefined, at: Number(raw.at) || 0 }
}

export function saveLayout(edition: EditionKey, layout: Omit<SplitLayout, 'at'> | undefined) {
  const all = readJson(layoutsKey) as Record<string, SplitLayout>
  if (layout) all[layoutKey(edition)] = { ...layout, at: Date.now() }
  else delete all[layoutKey(edition)]
  writeJson(layoutsKey, trim(all, maxLayouts))
}

/** Where an original file was being read: the section at the top of the pane and how far into it. */
export interface FilePlace { section: number; fraction: number; at: number }

export function readFilePlace(source: { library: LibraryId; bookId: string }): FilePlace | undefined {
  const raw = readJson(placesKey)[`${source.library}/${source.bookId}`] as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object') return undefined
  const section = Number(raw.section)
  const fraction = Number(raw.fraction)
  if (!Number.isInteger(section) || section < 0 || !Number.isFinite(fraction)) return undefined
  return { section, fraction: Math.max(0, Math.min(1, fraction)), at: Number(raw.at) || 0 }
}

export function saveFilePlace(source: { library: LibraryId; bookId: string }, place: Omit<FilePlace, 'at'>) {
  const all = readJson(placesKey) as Record<string, FilePlace>
  all[`${source.library}/${source.bookId}`] = { ...place, at: Date.now() }
  writeJson(placesKey, trim(all, maxFilePlaces))
}

// ——— Asking the editor to open something once it has loaded ———

const pendingKey = 'new-world:open-reference'
const lastEditionKey = 'new-world:last-edition'

export type OpenPlacement = 'right' | 'bottom'

/** The editable version opened last, so the shelf can open a work beside it. */
export function rememberEdition(edition: EditionKey) {
  writeJson(lastEditionKey, { library: edition.library, bookId: edition.bookId, id: edition.id })
}

export function lastEdition(): EditionKey | undefined {
  const raw = readJson(lastEditionKey)
  if (!libraryIds.includes(raw.library as LibraryId) || typeof raw.bookId !== 'string' || typeof raw.id !== 'string') return undefined
  return { library: raw.library as LibraryId, bookId: raw.bookId, id: raw.id }
}

export function requestOpen(source: PaneSource, placement: OpenPlacement) {
  try { sessionStorage.setItem(pendingKey, JSON.stringify({ source, placement })) } catch { /* The work still opens. */ }
}

export function takeOpenRequest(): { source: PaneSource; placement: OpenPlacement } | undefined {
  try {
    const raw = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null')
    sessionStorage.removeItem(pendingKey)
    // A web page asked for from outside the editor (a link in an idea) opens once and is gone.
    const web = raw?.source?.kind === 'web' && typeof raw.source.url === 'string' && isWebUrl(raw.source.url) ? { kind: 'web' as const, url: raw.source.url as string } : undefined
    const source = web ?? readSource(raw?.source)
    if (source) return { source, placement: raw.placement === 'bottom' ? 'bottom' : 'right' }
  } catch { /* Nothing waiting. */ }
  return undefined
}

/** Whether this app can open a separate reading window (only the desktop app can). */
export const canOpenWindow = () => Boolean(window.newWorldDesktop?.openReadingWindow)

export function openWindow(source: PaneSource) {
  if (source.kind !== 'web') void window.newWorldDesktop?.openReadingWindow?.(sourceRoute(source))
}

/**
 * The source a work opens to by default: the chapter last read in its newest version, else its file.
 * Given a version, the chapter last read in that version instead.
 */
export function defaultSource(work: CatalogWork, lastChapterOf: (edition: Edition) => string | undefined, editionId?: string): ReferenceSource | undefined {
  const edition = editionId ? work.editions.find(({ id }) => id === editionId) : work.editions.at(-1)
  if (editionId && !edition?.chapters.length) return undefined
  if (edition?.chapters.length) {
    const remembered = lastChapterOf(edition)
    const chapterId = edition.chapters.some(({ id }) => id === remembered) ? remembered! : edition.chapters[0].id
    return { kind: 'chapter', library: edition.library, bookId: edition.bookId, editionId: edition.id, chapterId }
  }
  const file = work.files[0]
  return file ? { kind: 'file', library: file.library, bookId: file.id } : undefined
}
