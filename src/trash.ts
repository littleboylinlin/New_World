import { t } from './i18n'
import { maxChapters } from './documents/model'
import type { Edition } from './documents/model'
import { libraryChanges, libraryStores, openDatabase, resultOf, committed, writing } from './library'
import type { Book, TrashEntry } from './library'

export const trashDays = 30
const lifetime = trashDays * 24 * 60 * 60 * 1000

export interface TrashItem {
  entry: TrashEntry
  place: string
}

export async function listTrash(): Promise<TrashItem[]> {
  const db = await openDatabase()
  const tx = db.transaction(['books', 'editions', 'trash'])
  const entries: TrashEntry[] = await resultOf(tx.objectStore('trash').getAll())
  entries.sort((left, right) => right.deletedAt - left.deletedAt)
  return Promise.all(entries.map(async (entry) => {
    if (entry.kind === 'book') return { entry, place: '' }
    const book: Book | undefined = await resultOf(tx.objectStore('books').get([entry.library, entry.bookId]))
    if (!book) return { entry, place: t('trash.parentWorkDeleted') }
    if (!entry.position) return { entry, place: book.title }
    const edition: Edition | undefined = await resultOf(tx.objectStore('editions').get([entry.library, entry.bookId, entry.position.editionId]))
    return { entry, place: edition ? `${book.title} · ${edition.name}` : t('trash.parentVersionDeleted', [book.title]) }
  }))
}

export async function countTrash() {
  const db = await openDatabase()
  return resultOf(db.transaction('trash').objectStore('trash').count())
}

// Restoring puts the saved rows back in one transaction, or changes nothing when their place is gone.
export async function restoreTrash(id: string) {
  const db = await openDatabase()
  const tx = db.transaction(libraryStores, 'readwrite', { durability: 'strict' })
  const books = tx.objectStore('books')
  const files = tx.objectStore('files')
  const editions = tx.objectStore('editions')
  const chapters = tx.objectStore('chapters')
  const trash = tx.objectStore('trash')
  const { step, done } = writing<{ entry: TrashEntry; edition?: Edition }>(tx)
  const request = trash.get(id)
  request.onsuccess = step(() => {
    const entry: TrashEntry | undefined = request.result
    if (!entry) throw new Error(t('trash.thisItemIsNoLongerInTheTrash'))
    const key = [entry.library, entry.bookId]
    trash.delete(id)
    if (entry.kind === 'book') {
      for (const book of entry.books) books.add(book)
      for (const file of entry.files) files.add(file)
      for (const edition of entry.editions) editions.add(edition)
      for (const chapter of entry.chapters) chapters.add(chapter)
      return { entry }
    }

    const owner = books.get(key)
    if (entry.kind === 'original') {
      owner.onsuccess = step(() => {
        const work: Book | undefined = owner.result
        if (!work) throw new Error(t('trash.theParentContinuationProjectIsNoLongerIn'))
        const [original] = entry.books
        // The first original shares its record with the project, which may have been renamed since.
        if (original.id === work.id) books.put({ ...original, title: work.title })
        else books.add(original)
        for (const file of entry.files) files.add(file)
        return { entry }
      })
      return { entry }
    }

    if (entry.kind === 'edition') {
      const siblings = editions.index('byBook').getAll(key)
      siblings.onsuccess = step(() => {
        if (!owner.result) throw new Error(t('trash.theParentWorkIsNoLongerInThe'))
        const names = new Set(siblings.result.map((edition: Edition) => edition.name))
        const [stored] = entry.editions
        let name = stored.name
        for (let i = 1; names.has(name); i++) name = t('trash.restored356', [stored.name, i > 1 ? ` ${i}` : ''])
        const edition = { ...stored, name }
        editions.add(edition)
        for (const chapter of entry.chapters) chapters.add(chapter)
        return { entry, edition }
      })
      return { entry }
    }

    const target = editions.get([...key, entry.position!.editionId])
    target.onsuccess = step(() => {
      const stored: Edition | undefined = target.result
      if (!stored) throw new Error(t('trash.theParentEditableVersionIsNoLongerIn'))
      if (stored.chapters.length >= maxChapters) throw new Error(t('store.eachEditableVersionCanContainUpToChapters', [maxChapters]))
      const [chapter] = entry.chapters
      const list = [...stored.chapters]
      list.splice(Math.min(entry.position!.index, list.length), 0, { id: chapter.id, title: entry.title })
      const edition = { ...stored, chapters: list, revision: stored.revision + 1 }
      editions.put(edition)
      chapters.add(chapter)
      return { entry, edition }
    })
    return { entry }
  })
  try {
    const restored = await done()
    libraryChanges.dispatchEvent(new Event('update'))
    return restored
  } catch (error) {
    // Ids are unique, so a constraint can only come from an identical original imported after the deletion.
    if (error instanceof DOMException && error.name === 'ConstraintError') throw new Error(t('trash.theLibraryAlreadyContainsAnIdenticalOriginalFile'))
    throw error
  }
}

export async function emptyTrash(id?: string) {
  const db = await openDatabase()
  const tx = db.transaction('trash', 'readwrite', { durability: 'strict' })
  if (id) tx.objectStore('trash').delete(id)
  else tx.objectStore('trash').clear()
  await committed(tx)
  libraryChanges.dispatchEvent(new Event('update'))
}

export async function clearExpiredTrash(now = Date.now()) {
  const db = await openDatabase()
  const tx = db.transaction('trash', 'readwrite')
  const request = tx.objectStore('trash').openCursor()
  let cleared = 0
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) return
    if (now - (cursor.value as TrashEntry).deletedAt > lifetime) {
      cursor.delete()
      cleared++
    }
    cursor.continue()
  }
  await committed(tx)
  if (cleared) libraryChanges.dispatchEvent(new Event('update'))
}
