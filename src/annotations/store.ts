import { openDatabase, resultOf, writing } from '../library'
import type { Book, ImportedBook, LibraryId } from '../library'
import type { ChapterRecord } from '../documents/model'
import { t } from '../i18n'
import { emptyAnnotations, validAnnotations } from './model'
import type { ReadingAnnotations } from './model'

export type AnnotationTarget = { library: LibraryId; bookId: string } & (
  { kind: 'chapter'; editionId: string; chapterId: string; sourceRevision: number }
  | { kind: 'original'; sectionId: string; sourceRevision: string }
)

function owner(target: AnnotationTarget) {
  return target.kind === 'chapter'
    ? { store: 'chapters', key: [target.library, target.bookId, target.editionId, target.chapterId] }
    : { store: 'books', key: [target.library, target.bookId] }
}

function collection(target: AnnotationTarget, record: ChapterRecord | Book): ReadingAnnotations {
  const data = (target.kind === 'chapter' ? (record as ChapterRecord).readingAnnotations
    : (record as ImportedBook).readingAnnotations?.[target.sectionId]) ?? emptyAnnotations()
  if (!validAnnotations(data)) throw new Error(t('annotations.damaged'))
  return data
}

export async function readAnnotations(target: AnnotationTarget) {
  const db = await openDatabase()
  const { store, key } = owner(target)
  const record = await resultOf(db.transaction(store).objectStore(store).get(key))
  if (!record) throw new Error(t('annotations.ownerRemoved'))
  return collection(target, record)
}

/** Merge metadata into the latest owner in one transaction; text saves never replace it. */
export async function saveAnnotations(target: AnnotationTarget, expected: number, items: ReadingAnnotations['items']) {
  if (!validAnnotations({ revision: expected, items })) throw new Error(t('annotations.invalid'))
  const db = await openDatabase()
  const { store, key } = owner(target)
  const tx = db.transaction(store, 'readwrite', { durability: 'strict' })
  const records = tx.objectStore(store)
  const request = records.get(key)
  const { step, done } = writing<ReadingAnnotations>(tx)
  request.onsuccess = step(() => {
    const record: ChapterRecord | ImportedBook | undefined = request.result
    if (!record) throw new Error(t('annotations.ownerRemoved'))
    const current = collection(target, record)
    if (current.revision !== expected) throw new Error(t('annotations.conflict'))
    const revision = target.kind === 'chapter' ? (record as ChapterRecord).revision : (record as ImportedBook).digest
    if (revision !== target.sourceRevision) throw new Error(t('annotations.sourceChanged'))
    const next = { revision: expected + 1, items }
    records.put({ ...record, readingAnnotations: target.kind === 'chapter' ? next
      : { ...(record as ImportedBook).readingAnnotations, [target.sectionId]: next } })
    return next
  })
  return done()
}
