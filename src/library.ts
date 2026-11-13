import { t } from './i18n'
import { fileFormat, maxImportSize } from './formats'
import type { Format } from './formats'
import type { ChapterRecord, Edition } from './documents/model'

export type LibraryId = 'original' | 'reference'

interface BookIdentity {
  library: LibraryId
  id: string
  title: string
  importedAt: number
  workId?: string
  /** Set while the work is archived: kept out of its library's shelf but otherwise unchanged. */
  archivedAt?: number
}

export interface ImportedBook extends BookIdentity {
  originalName: string
  format: Format
  size: number
  digest: string
}

export interface WrittenBook extends BookIdentity {
  format: 'draft'
}

export type Book = ImportedBook | WrittenBook

export interface BookFile {
  library: LibraryId
  id: string
  blob: Blob
}

// A deleted item keeps every record it owned, so restoring puts the same rows back.
export interface TrashEntry {
  id: string
  kind: 'book' | 'original' | 'edition' | 'chapter'
  library: LibraryId
  bookId: string
  title: string
  deletedAt: number
  books: Book[]
  files: BookFile[]
  editions: Edition[]
  chapters: ChapterRecord[]
  position?: { editionId: string; index: number }
}

export const libraryChanges = new EventTarget()
export const libraryStores = ['books', 'files', 'editions', 'chapters', 'trash']

let connection: Promise<IDBDatabase> | undefined
export const maxTitleLength = 255

export function openDatabase() {
  if (connection) return connection
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('new-world-library', 3)
    let blocked = false
    request.onupgradeneeded = (event) => {
      const db = request.result
      if (event.oldVersion < 1) {
        const books = db.createObjectStore('books', { keyPath: ['library', 'id'] })
        books.createIndex('byLibrary', 'library')
        books.createIndex('byLibraryDigest', ['library', 'digest'], { unique: true })
        db.createObjectStore('files', { keyPath: ['library', 'id'] })
      }
      if (event.oldVersion < 2) {
        const editions = db.createObjectStore('editions', { keyPath: ['library', 'bookId', 'id'] })
        editions.createIndex('byBook', ['library', 'bookId'])
        editions.createIndex('byName', ['library', 'bookId', 'name'], { unique: true })
        const chapters = db.createObjectStore('chapters', { keyPath: ['library', 'bookId', 'editionId', 'id'] })
        chapters.createIndex('byBook', ['library', 'bookId'])
        chapters.createIndex('byEdition', ['library', 'bookId', 'editionId'])
      }
      if (event.oldVersion < 3) db.createObjectStore('trash', { keyPath: 'id' })
    }
    request.onsuccess = () => {
      const db = request.result
      const disconnect = () => {
        db.close()
        if (connection === opening) connection = undefined
      }
      db.onversionchange = disconnect
      db.onclose = disconnect
      if (blocked) disconnect()
      else resolve(db)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => {
      blocked = true
      reject(new Error(t('library.anotherNewWorldPageIsUsingAnOlder')))
    }
  })
  connection = opening
  void opening.catch(() => {
    if (connection === opening) connection = undefined
  })
  return opening
}

export function resultOf<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error(t('library.theLibraryOperationWasInterrupted')))
  })
}

// Run a write step inside an IndexedDB callback. A thrown error aborts the transaction and is reported as is.
export function writing<R>(tx: IDBTransaction) {
  let result: R
  let failure: unknown
  const step = (action: () => R) => () => {
    try {
      result = action()
    } catch (error) {
      failure = error
      tx.abort()
    }
  }
  const done = () => committed(tx).then(() => result, (error) => { throw failure ?? error })
  return { step, done }
}

export async function announced<T>(change: Promise<T>) {
  const result = await change
  libraryChanges.dispatchEvent(new Event('update'))
  return result
}

export function trashEntry(kind: TrashEntry['kind'], library: LibraryId, bookId: string, title: string): TrashEntry {
  return { id: crypto.randomUUID(), kind, library, bookId, title, deletedAt: Date.now(), books: [], files: [], editions: [], chapters: [] }
}

/** Works on the shelf: every book except archived works (originals of a continuation project stay). */
export async function listShelf(library: LibraryId): Promise<Book[]> {
  return (await listBooks(library)).filter((book) => !book.workId && !book.archivedAt)
}

/** Archived works of both libraries, most recently archived first. */
export async function listArchived(): Promise<Book[]> {
  const db = await openDatabase()
  const books: Book[] = await resultOf(db.transaction('books').objectStore('books').getAll())
  return books.filter((book) => !book.workId && book.archivedAt).sort((a, b) => b.archivedAt! - a.archivedAt!)
}

export async function setArchived(library: LibraryId, id: string, archived: boolean) {
  const db = await openDatabase()
  const tx = db.transaction('books', 'readwrite', { durability: 'strict' })
  const books = tx.objectStore('books')
  const { step, done } = writing<Book>(tx)
  const request = books.get([library, id])
  request.onsuccess = step(() => {
    const book: Book | undefined = request.result
    if (!book || book.workId) throw new Error(t('store.thisWorkHasBeenRemovedFromTheLibrary'))
    const { archivedAt: _previous, ...rest } = book
    const next = (archived ? { ...rest, archivedAt: Date.now() } : rest) as Book
    books.put(next)
    return next
  })
  return announced(done())
}

export async function listBooks(library: LibraryId): Promise<Book[]> {
  const db = await openDatabase()
  const index = db.transaction('books').objectStore('books').index('byLibrary')
  const books: Book[] = await resultOf(index.getAll(library))
  return books.sort((a, b) => b.importedAt - a.importedAt || a.title.localeCompare(b.title, 'zh-CN'))
}

export async function readBook(library: LibraryId, id: string) {
  const db = await openDatabase()
  const tx = db.transaction(['books', 'files'])
  const key = [library, id]
  const [book, file]: [Book | undefined, BookFile | undefined] = await Promise.all([
    resultOf(tx.objectStore('books').get(key)),
    resultOf(tx.objectStore('files').get(key)),
  ])
  if (!book) return null
  if (book.format === 'draft') return { book, blob: null } as const
  if (!file) throw new Error(t('library.theOriginalFileForThisWorkIsMissing'))
  return { book, blob: file.blob }
}

export async function importBook(library: LibraryId, file: File, workId?: string) {
  const format = fileFormat(file.name)
  if (!format) throw new Error(t('library.thisFileExtensionIsNotSupportedForImport'))
  if (file.size === 0) throw new Error(t('library.theFileIsEmpty'))
  if (file.size > maxImportSize) throw new Error(t('library.aSingleFileCannotExceed128Mib'))
  if (!globalThis.crypto?.subtle) throw new Error(t('store.openNewWorldOverHttpsOrOnLocalhost'))

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
  const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const book: ImportedBook = {
    library, format, digest, workId,
    id: crypto.randomUUID(),
    title: (file.name.replace(/\.[^.]+$/, '').trim() || file.name).slice(0, maxTitleLength),
    originalName: file.name,
    size: file.size,
    importedAt: Date.now(),
  }

  const db = await openDatabase()
  const tx = db.transaction(['books', 'files'], 'readwrite', { durability: 'strict' })
  const books = tx.objectStore('books')
  const files = tx.objectStore('files')
  const parent = workId ? books.get([library, workId]) : undefined
  const existing = books.index('byLibraryDigest').get([library, digest])
  let duplicate: Book | undefined
  let invalidParent = false
  existing.onsuccess = () => {
    if (parent && (library !== 'reference' || !parent.result || parent.result.workId)) {
      invalidParent = true
      return
    }
    duplicate = existing.result
    if (!duplicate) {
      books.add(book)
      files.add({ library, id: book.id, blob: file } satisfies BookFile)
    }
  }
  await committed(tx)
  if (invalidParent) throw new Error(t('library.theContinuationProjectHasBeenRemoved'))
  return duplicate ? { book: duplicate, duplicate: true } : { book, duplicate: false }
}

export async function renameBook(library: LibraryId, id: string, value: string) {
  const title = value.trim()
  if (!title || title.length > maxTitleLength) throw new Error(t('library.enterAValidWorkTitle'))
  const db = await openDatabase()
  const tx = db.transaction('books', 'readwrite', { durability: 'strict' })
  const books = tx.objectStore('books')
  const request = books.get([library, id])
  let found = false
  request.onsuccess = () => {
    const book: Book | undefined = request.result
    if (book) {
      found = true
      books.put({ ...book, title })
    }
  }
  await committed(tx)
  if (!found) throw new Error(t('store.thisWorkHasBeenRemovedFromTheLibrary'))
}

// Deleting moves a work with its originals, editions and chapters to the trash in one transaction.
export async function deleteBook(library: LibraryId, id: string) {
  const db = await openDatabase()
  const tx = db.transaction(libraryStores, 'readwrite', { durability: 'strict' })
  const books = tx.objectStore('books')
  const files = tx.objectStore('files')
  const editions = tx.objectStore('editions')
  const chapters = tx.objectStore('chapters')
  const key = [library, id]
  const { step, done } = writing<TrashEntry>(tx)
  const members = books.index('byLibrary').getAll(library)
  members.onsuccess = step(() => {
    const owned: Book[] = members.result.filter((book: Book) => book.id === id || book.workId === id)
    const root = owned.find((book) => book.id === id)
    if (!root) throw new Error(t('store.thisWorkHasBeenRemovedFromTheLibrary'))
    const entry = trashEntry('book', library, id, root.title)
    entry.books = owned
    // Requests on one transaction finish in order, so the last read sees every earlier result.
    const storedFiles = owned.map((book) => files.get([library, book.id]))
    const storedEditions = editions.index('byBook').getAll(key)
    const storedChapters = chapters.index('byBook').getAll(key)
    storedChapters.onsuccess = step(() => {
      entry.files = storedFiles.map((request) => request.result).filter(Boolean)
      entry.editions = storedEditions.result
      entry.chapters = storedChapters.result
      for (const book of owned) {
        books.delete([library, book.id])
        files.delete([library, book.id])
      }
      for (const edition of entry.editions) editions.delete([library, id, edition.id])
      for (const chapter of entry.chapters) chapters.delete([library, id, chapter.editionId, chapter.id])
      tx.objectStore('trash').add(entry)
      return entry
    })
    return entry
  })
  return announced(done())
}

export async function removeWorkOriginal(workId: string, id: string) {
  const db = await openDatabase()
  const tx = db.transaction(['books', 'files', 'trash'], 'readwrite', { durability: 'strict' })
  const books = tx.objectStore('books')
  const files = tx.objectStore('files')
  const key = ['reference', id]
  const { step, done } = writing<TrashEntry>(tx)
  const request = books.get(key)
  const stored = files.get(key)
  stored.onsuccess = step(() => {
    const book: Book | undefined = request.result
    if (!book || book.format === 'draft' || (book.workId ?? book.id) !== workId) throw new Error(t('library.thisSourceHasBeenRemoved'))
    const entry = trashEntry('original', 'reference', workId, book.originalName)
    entry.books = [book]
    if (stored.result) entry.files = [stored.result]
    if (book.workId) books.delete(key)
    else books.put({ library: book.library, id, title: book.title, importedAt: book.importedAt, format: 'draft' } satisfies WrittenBook)
    files.delete(key)
    tx.objectStore('trash').add(entry)
    return entry
  })
  return announced(done())
}

export function storageError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'QuotaExceededError') return t('library.localStorageIsFullTheLatestChangesWere')
    if (error.name === 'ConstraintError') return t('library.anEditableVersionWithThisNameAlreadyExists')
    if (error.name === 'SecurityError' || error.name === 'InvalidStateError') {
      return t('library.theLocalLibraryIsUnavailableInThisBrowser')
    }
    return t('library.theLocalLibraryOperationFailedTryAgain')
  }
  return error instanceof Error ? error.message : t('library.theLocalLibraryOperationFailedTryAgain')
}
