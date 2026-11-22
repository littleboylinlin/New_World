import { openDatabase, resultOf } from '../library'
import type { ChapterRevision } from '../library'
import { isLargeChange } from './change-size'
import { chapterText, wordCount } from './model'
import type { ChapterRecord, DocumentContent, EditionKey } from './model'
import { prepareChapterPayload } from './revisions'
import type { PreparedPayload } from './revisions'

/** Ordinary writing keeps the text it is about to overwrite at most this often… */
export const writingSnapshotInterval = 10 * 60 * 1000
/** …and each chapter keeps this many of those snapshots; AI and restore snapshots are not counted or removed. */
export const keptWritingSnapshots = 30

export interface WritingSnapshot {
  payload: PreparedPayload
  action: 'interval' | 'large-change'
  at: number
}

// When each chapter last kept a writing snapshot. A chapter without one starts its clock at the first
// save it sees, so a short session adds nothing to the history unless it makes a large change.
const latest = new Map<string, number>()
const keyOf = (edition: EditionKey, chapterId: string) => [edition.library, edition.bookId, edition.id, chapterId].join('\u0000')

async function lastSnapshotAt(edition: EditionKey, chapterId: string, now: number) {
  const key = keyOf(edition, chapterId)
  const known = latest.get(key)
  if (known !== undefined) return known
  const db = await openDatabase()
  const rows: ChapterRevision[] = await resultOf(db.transaction('revisions').objectStore('revisions').index('byChapter')
    .getAll([edition.library, edition.bookId, edition.id, chapterId]))
  const stored = rows.filter((row) => row.source === 'writing').reduce((last, row) => Math.max(last, row.createdAt), 0)
  const start = stored || now
  latest.set(key, start)
  return start
}

/**
 * Whether saving `next` over a chapter should first keep the text it replaces (`chapter.content`, the last
 * saved state) in the history: once every ten minutes of writing, and before any large change.
 */
export async function planWritingSnapshot(edition: EditionKey, chapter: ChapterRecord, next: DocumentContent, now = Date.now()) {
  if (!wordCount(chapter.content)) return undefined
  const before = chapterText(chapter.content, '\n\n')
  const after = chapterText(next, '\n\n')
  if (before === after) return undefined
  const large = isLargeChange(before, after)
  if (!large && now - await lastSnapshotAt(edition, chapter.id, now) < writingSnapshotInterval) return undefined
  const snapshot: WritingSnapshot = { payload: await prepareChapterPayload(chapter.content, now), action: large ? 'large-change' : 'interval', at: now }
  return snapshot
}

export function noteWritingSnapshot(edition: EditionKey, chapterId: string, at: number) {
  latest.set(keyOf(edition, chapterId), at)
}
