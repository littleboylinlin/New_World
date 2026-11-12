import { t } from '../i18n'
import { announced, committed, maxTitleLength, openDatabase, resultOf, trashEntry, writing } from '../library'
import type { Book, LibraryId, TrashEntry, WrittenBook } from '../library'
import { emptyChapter, maxChapters, wordCount } from './model'
import type { ChapterInput, ChapterRecord, DocumentContent, Edition, EditionBundle, EditionKey } from './model'

const editionKey = (edition: EditionKey) => [edition.library, edition.bookId, edition.id]
const chapterKey = (edition: EditionKey, id: string) => [...editionKey(edition), id]

function checkedTitle(value: string) {
  const title = value.trim()
  if (!title || title.length > maxTitleLength) throw new Error(t('store.enterAValidName'))
  return title
}

// Queue writes while the IndexedDB callback owns the active transaction, including in Safari.
function updateRecord<T, R>(tx: IDBTransaction, request: IDBRequest<T>, write: (record: T) => R) {
  const { step, done } = writing<R>(tx)
  request.onsuccess = step(() => write(request.result))
  return done()
}

type EditionOptions = Pick<Edition, 'source'> & Partial<Pick<Edition, 'notes' | 'copiedFrom' | 'originalId'>>

function assembleEdition(book: Book, name: string, inputs: ChapterInput[], options: EditionOptions) {
  if (!inputs.length || inputs.length > maxChapters) throw new Error(t('store.aManuscriptMustHaveBetween1AndChapters', [maxChapters]))
  const id = crypto.randomUUID()
  const edition: Edition = {
    library: book.library, bookId: book.id, id, name: checkedTitle(name),
    source: options.source, notes: options.notes ?? [], copiedFrom: options.copiedFrom, originalId: options.originalId,
    chapters: inputs.map((chapter) => ({ id: crypto.randomUUID(), title: checkedTitle(chapter.title) })),
    createdAt: Date.now(), revision: 0,
  }
  const records = inputs.map((chapter, index) => newChapter(edition, edition.chapters[index].id, chapter.content))
  return { edition, records }
}

function newChapter(edition: EditionKey, id: string, content: DocumentContent): ChapterRecord {
  return { library: edition.library, bookId: edition.bookId, editionId: edition.id, id, content, revision: 0 }
}

function addRecords(tx: IDBTransaction, edition: Edition, records: ChapterRecord[]) {
  tx.objectStore('editions').add(edition)
  const chapters = tx.objectStore('chapters')
  for (const chapter of records) chapters.add(chapter)
}

export async function createNovel(library: LibraryId, name: string) {
  if (!globalThis.crypto?.randomUUID) throw new Error(t('store.openNewWorldOverHttpsOrOnLocalhost'))
  const book: WrittenBook = { library, id: crypto.randomUUID(), title: checkedTitle(name), format: 'draft', importedAt: Date.now() }
  const { edition, records } = assembleEdition(book, t('store.manuscript'), [emptyChapter()], { source: 'blank' })
  const db = await openDatabase()
  const tx = db.transaction(['books', 'editions', 'chapters'], 'readwrite', { durability: 'strict' })
  tx.objectStore('books').add(book)
  addRecords(tx, edition, records)
  await committed(tx)
  return { book, edition }
}

export async function createEdition(book: Book, inputs: ChapterInput[], options: EditionOptions, name?: string) {
  const draft = assembleEdition(book, name ?? t('store.manuscript'), inputs, options)
  const db = await openDatabase()
  const tx = db.transaction(['books', 'editions', 'chapters'], 'readwrite', { durability: 'strict' })
  const exists = tx.objectStore('books').get([book.library, book.id])
  const existing = tx.objectStore('editions').index('byBook').getAll([book.library, book.id])
  return updateRecord(tx, existing, (editions: Edition[]) => {
    if (!exists.result) throw new Error(t('store.thisWorkHasBeenRemovedFromTheLibrary'))
    if (name === undefined) {
      const names = new Set(editions.map((edition) => edition.name))
      for (let i = 2; names.has(draft.edition.name); i++) draft.edition.name = t('store.manuscript193', [i])
    }
    addRecords(tx, draft.edition, draft.records)
    return draft.edition
  })
}

export async function listEditions(library: LibraryId, bookId: string): Promise<Edition[]> {
  const db = await openDatabase()
  const index = db.transaction('editions').objectStore('editions').index('byBook')
  const editions: Edition[] = await resultOf(index.getAll([library, bookId]))
  return editions.sort((left, right) => left.createdAt - right.createdAt)
}

export async function readChapter(edition: EditionKey, id: string): Promise<ChapterRecord> {
  const db = await openDatabase()
  const chapter = await resultOf(db.transaction('chapters').objectStore('chapters').get(chapterKey(edition, id)))
  if (!chapter) throw new Error(t('store.thisChapterHasBeenRemoved'))
  return chapter
}

export async function saveChapter(edition: EditionKey, chapter: ChapterRecord, content: DocumentContent) {
  const db = await openDatabase()
  const tx = db.transaction('chapters', 'readwrite', { durability: 'strict' })
  const chapters = tx.objectStore('chapters')
  return updateRecord(tx, chapters.get(chapterKey(edition, chapter.id)), (stored: ChapterRecord | undefined) => {
    if (!stored) throw new Error(t('store.thisChapterHasBeenRemovedTheCurrentText'))
    if (stored.revision !== chapter.revision) throw new Error(t('store.thisChapterWasUpdatedInAnotherPageSave'))
    const next = { ...stored, content, revision: stored.revision + 1 }
    chapters.put(next)
    return next
  })
}

export async function readBundle(key: EditionKey): Promise<EditionBundle> {
  const db = await openDatabase()
  const tx = db.transaction(['editions', 'chapters'])
  const [edition, chapters]: [Edition | undefined, ChapterRecord[]] = await Promise.all([
    resultOf(tx.objectStore('editions').get(editionKey(key))),
    resultOf(tx.objectStore('chapters').index('byEdition').getAll(editionKey(key))),
  ])
  if (!edition) throw new Error(t('store.thisEditableVersionHasBeenRemoved'))
  const byId = new Map(chapters.map((chapter) => [chapter.id, chapter.content]))
  return { edition, chapters: edition.chapters.map(({ id, title }) => {
    const content = byId.get(id)
    if (!content) throw new Error(t('store.someChaptersCouldNotBeReadFromThe'))
    return { title, content }
  }) }
}

type ChapterChange = { type: 'add'; title: string } | { type: 'rename'; id: string; title: string }
  | { type: 'move'; id: string; offset: -1 | 1 } | { type: 'delete'; id: string }

export async function chapterWordCounts(key: EditionKey) {
  const db = await openDatabase()
  const index = db.transaction('chapters').objectStore('chapters').index('byEdition')
  const chapters: ChapterRecord[] = await resultOf(index.getAll(editionKey(key)))
  return new Map(chapters.map((chapter) => [chapter.id, wordCount(chapter.content)]))
}

export async function changeChapters(edition: Edition, change: ChapterChange) {
  const db = await openDatabase()
  const tx = db.transaction(['editions', 'chapters', 'trash'], 'readwrite', { durability: 'strict' })
  const editions = tx.objectStore('editions')
  const records = tx.objectStore('chapters')
  // A deleted chapter is read before the directory so its text can move to the trash.
  const removed = change.type === 'delete' ? records.get(chapterKey(edition, change.id)) : undefined
  let trashed: TrashEntry | undefined
  return announced(updateRecord(tx, editions.get(editionKey(edition)), (stored: Edition | undefined) => {
    if (!stored) throw new Error(t('store.thisEditableVersionHasBeenRemoved'))
    if (stored.revision !== edition.revision) throw new Error(t('store.theChapterListWasUpdatedInAnotherPage'))
    const chapters = [...stored.chapters]
    let selected: string
    function append(title: string) {
      const id = crypto.randomUUID()
      chapters.push({ id, title: checkedTitle(title) })
      records.add(newChapter(stored!, id, emptyChapter().content))
      return id
    }

    if (change.type === 'add') {
      if (chapters.length >= maxChapters) throw new Error(t('store.eachEditableVersionCanContainUpToChapters', [maxChapters]))
      selected = append(change.title)
    } else {
      const index = chapters.findIndex((chapter) => chapter.id === change.id)
      if (index < 0) throw new Error(t('store.thisChapterHasBeenRemoved'))
      selected = change.id
      if (change.type === 'rename') chapters[index] = { ...chapters[index], title: checkedTitle(change.title) }
      if (change.type === 'move') {
        const target = index + change.offset
        if (target < 0 || target >= chapters.length) return { edition: stored, selected }
        const moved = chapters[index]
        chapters[index] = chapters[target]
        chapters[target] = moved
      }
      if (change.type === 'delete') {
        if (removed?.result) {
          trashed = trashEntry('chapter', stored.library, stored.bookId, chapters[index].title)
          trashed.chapters = [removed.result]
          trashed.position = { editionId: stored.id, index }
          tx.objectStore('trash').add(trashed)
        }
        chapters.splice(index, 1)
        records.delete(chapterKey(stored, change.id))
        selected = chapters.length ? chapters[Math.min(index, chapters.length - 1)].id : append(t('editor.firstChapter'))
      }
    }
    const next = { ...stored, chapters, revision: stored.revision + 1 }
    editions.put(next)
    return { edition: next, selected, trashed }
  }))
}

export async function deleteEdition(edition: EditionKey) {
  const db = await openDatabase()
  const tx = db.transaction(['editions', 'chapters', 'trash'], 'readwrite', { durability: 'strict' })
  const editions = tx.objectStore('editions')
  const chapters = tx.objectStore('chapters')
  const { step, done } = writing<TrashEntry>(tx)
  const stored = editions.get(editionKey(edition))
  const records = chapters.index('byEdition').getAll(editionKey(edition))
  records.onsuccess = step(() => {
    const current: Edition | undefined = stored.result
    if (!current) throw new Error(t('store.thisEditableVersionHasBeenRemoved'))
    const entry = trashEntry('edition', current.library, current.bookId, current.name)
    entry.editions = [current]
    entry.chapters = records.result
    editions.delete(editionKey(current))
    for (const chapter of entry.chapters) chapters.delete(chapterKey(current, chapter.id))
    tx.objectStore('trash').add(entry)
    return entry
  })
  return announced(done())
}
