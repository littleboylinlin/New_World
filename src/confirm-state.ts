import type { ChapterRecord, DocumentContent, Edition } from './documents/model'
import type { Idea } from './ideas'
import type { Book, ImportedBook, LibraryId } from './library'

export class ConfirmStateConflictError extends Error {
  constructor(message = 'Target state changed while awaiting confirmation') {
    super(message)
    this.name = 'ConfirmStateConflictError'
  }
}

/** Fast synchronous 64-bit FNV-1a hex fingerprint, safe inside IDB transaction handlers. */
export function synchronousContentHash(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x811c9dc5 ^ 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

export function hashDocumentContent(content: DocumentContent): string {
  return synchronousContentHash(JSON.stringify(content))
}

export function expectedChaptersSnapshot(edition: Edition, records: ChapterRecord[]) {
  const byId = new Map<string, ChapterRecord>(records.map((rec) => [rec.id, rec]))
  return edition.chapters.map((ch) => {
    const rec = byId.get(ch.id)
    return {
      id: ch.id,
      title: ch.title,
      revision: rec?.revision ?? 0,
      contentHash: rec ? hashDocumentContent(rec.content) : 'missing',
    }
  })
}

export function computeWorkDeleteFingerprint(
  library: LibraryId,
  rootBook: Book,
  ownedBooks: Book[],
  editions: Edition[],
  chapters: ChapterRecord[],
): string {
  const chaptersByEdition = new Map<string, ChapterRecord[]>()
  for (const ch of chapters) {
    const list = chaptersByEdition.get(ch.editionId)
    if (list) list.push(ch)
    else chaptersByEdition.set(ch.editionId, [ch])
  }
  const sortedEditions = [...editions].sort((a, b) => a.id.localeCompare(b.id))
  const editionSummaries = sortedEditions.map((edition) => ({
    id: edition.id,
    name: edition.name,
    revision: edition.revision,
    chapters: expectedChaptersSnapshot(edition, chaptersByEdition.get(edition.id) ?? []),
  }))
  const attachedSources = library === 'reference'
    ? ownedBooks
      .filter((item): item is ImportedBook => item.workId === rootBook.id && item.format !== 'draft')
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((src) => ({ id: src.id, title: src.title, originalName: src.originalName, size: src.size, digest: src.digest }))
    : []
  const stateHash = synchronousContentHash(JSON.stringify({
    library,
    id: rootBook.id,
    title: rootBook.title,
    archivedAt: rootBook.archivedAt ?? 0,
    coverSize: rootBook.cover?.size ?? 0,
    editions: editionSummaries,
    sources: attachedSources,
  }))
  return `work:${library}:${rootBook.id}:${stateHash}`
}

export function computeEditionDeleteFingerprint(edition: Edition, records: ChapterRecord[]): string {
  const stateHash = synchronousContentHash(JSON.stringify({
    library: edition.library,
    bookId: edition.bookId,
    id: edition.id,
    name: edition.name,
    revision: edition.revision,
    chapters: expectedChaptersSnapshot(edition, records),
  }))
  return `edition:${edition.library}:${edition.bookId}:${edition.id}:${stateHash}`
}

export function computeChapterDeleteFingerprint(edition: Edition, record: ChapterRecord, index: number): string {
  const infoEntry = edition.chapters[index]
  const chHash = synchronousContentHash(JSON.stringify({
    index,
    title: infoEntry?.title ?? '',
    editionRevision: edition.revision,
    chapterRevision: record.revision,
    contentHash: hashDocumentContent(record.content),
  }))
  return `chapter-delete:${edition.library}:${edition.bookId}:${edition.id}:${record.id}:${chHash}`
}

export function computeSourceDeleteFingerprint(workId: string, src: Book): string {
  const srcHash = synchronousContentHash(JSON.stringify({
    id: src.id,
    workId: src.workId ?? '',
    title: src.title,
    originalName: src.format === 'draft' ? '' : src.originalName,
    size: src.format === 'draft' ? 0 : src.size,
    digest: src.format === 'draft' ? '' : src.digest,
    importedAt: src.importedAt,
  }))
  return `source-delete:${workId}:${src.id}:${srcHash}`
}

export function computeIdeaDeleteFingerprint(idea: Idea): string {
  const ideaHash = synchronousContentHash(JSON.stringify({
    id: idea.id,
    text: idea.text,
    library: idea.library ?? '',
    bookId: idea.bookId ?? '',
    createdAt: idea.createdAt,
    usedAt: idea.usedAt ?? 0,
  }))
  return `idea-delete:${idea.id}:${ideaHash}`
}
