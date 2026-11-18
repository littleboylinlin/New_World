// How the editor was left on this device: which panels were open, the find options, and where
// each chapter was being read or written. Kept in localStorage like the appearance settings, and
// shared by every work, so a new work opens the way the last one was left.

export type FindScope = 'chapter' | 'book'

export interface EditorPreferences {
  /** null until chosen: then the chapter list opens where there is room for it. */
  navOpen: boolean | null
  /** null until chosen: then the side panel opens where there is room for it. */
  sideOpen: boolean | null
  sideTab: string
  sideWidth: number
  formatCollapsed: boolean
  find: { scope: FindScope; matchCase: boolean; wholeWord: boolean; replaceOpen: boolean }
}

export interface ChapterPlace {
  /** Document position at the top of the visible text, and how far above the pane's top it starts. */
  top: number
  offset: number
  scroll: number
  /** The text pane's scroll height then; when it differs the top position is used instead. */
  height?: number
  from: number
  to: number
  at: number
}

const preferencesKey = 'new-world:editor-ui'
const placesKey = 'new-world:editor-places'
const legacyIdeasKey = 'new-world:ideas-open'
const maxPlaces = 400

export const defaultSideWidth = 320

function readJson(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Only a convenience; the page keeps working. */ }
}

function legacySideOpen() {
  try {
    const stored = localStorage.getItem(legacyIdeasKey)
    if (stored) return stored === '1'
  } catch { /* Falls back to the default. */ }
  return null
}

export function readEditorPreferences(): EditorPreferences {
  const raw = readJson(preferencesKey)
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const find = record.find && typeof record.find === 'object' ? record.find as Record<string, unknown> : {}
  const width = typeof record.sideWidth === 'number' && Number.isFinite(record.sideWidth) ? record.sideWidth : defaultSideWidth
  return {
    navOpen: typeof record.navOpen === 'boolean' ? record.navOpen : null,
    sideOpen: typeof record.sideOpen === 'boolean' ? record.sideOpen : legacySideOpen(),
    sideTab: typeof record.sideTab === 'string' ? record.sideTab : 'ideas',
    sideWidth: Math.round(Math.max(240, Math.min(640, width))),
    formatCollapsed: record.formatCollapsed === true,
    find: {
      scope: find.scope === 'book' ? 'book' : 'chapter',
      matchCase: find.matchCase === true,
      wholeWord: find.wholeWord === true,
      replaceOpen: find.replaceOpen !== false,
    },
  }
}

export function updateEditorPreferences(change: Partial<Omit<EditorPreferences, 'find'>> & { find?: Partial<EditorPreferences['find']> }) {
  const current = readEditorPreferences()
  const next = { ...current, ...change, find: { ...current.find, ...change.find } }
  writeJson(preferencesKey, next)
  return next
}

interface PlaceBook {
  chapters: Record<string, ChapterPlace>
  last: Record<string, string>
}

function readPlaces(): PlaceBook {
  const raw = readJson(placesKey)
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const chapters = record.chapters && typeof record.chapters === 'object' ? record.chapters as Record<string, ChapterPlace> : {}
  const last = record.last && typeof record.last === 'object' ? record.last as Record<string, string> : {}
  return { chapters, last }
}

const editionKey = (edition: { library: string; bookId: string; id: string }) => `${edition.library}/${edition.bookId}/${edition.id}`

function valid(place: unknown): place is ChapterPlace {
  if (!place || typeof place !== 'object') return false
  const value = place as Record<string, unknown>
  return ['top', 'offset', 'scroll', 'from', 'to'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
}

export function readChapterPlace(edition: { library: string; bookId: string; id: string }, chapterId: string): ChapterPlace | undefined {
  const place = readPlaces().chapters[`${editionKey(edition)}/${chapterId}`]
  return valid(place) ? place : undefined
}

export function saveChapterPlace(edition: { library: string; bookId: string; id: string }, chapterId: string, place: Omit<ChapterPlace, 'at'>) {
  const book = readPlaces()
  book.chapters[`${editionKey(edition)}/${chapterId}`] = { ...place, at: Date.now() }
  book.last[editionKey(edition)] = chapterId
  const entries = Object.entries(book.chapters)
  if (entries.length > maxPlaces) {
    entries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
    book.chapters = Object.fromEntries(entries.slice(0, maxPlaces))
  }
  writeJson(placesKey, book)
}

export function lastChapter(edition: { library: string; bookId: string; id: string }) {
  return readPlaces().last[editionKey(edition)]
}
