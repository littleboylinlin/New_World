import type { LibraryId } from '../library'
import { bookPath } from '../ui'
import type { ChapterTarget, ForeshadowingWork } from './model'

const route = /^#\/(original|reference)\/([0-9a-f-]{36})\/foreshadowing(?:\/([0-9a-f-]{36})\/([0-9a-f-]{36}))?\/?$/

export function foreshadowingPath(work: ForeshadowingWork, target?: ChapterTarget) {
  return `${bookPath(work.library, work.bookId)}/foreshadowing${target ? `/${target.editionId}/${target.chapterId}` : ''}`
}

export function chapterPath(work: ForeshadowingWork, target: ChapterTarget) {
  return `${bookPath(work.library, work.bookId, target.editionId)}/chapter/${target.chapterId}`
}

export function parseForeshadowingPath(hash: string) {
  const match = route.exec(hash)
  if (!match) return
  const [, library, bookId, editionId, chapterId] = match
  return { work: { library: library as LibraryId, bookId }, target: chapterId ? { editionId, chapterId } : undefined }
}
