import { t } from './i18n'
import { maxChapters } from './documents/model'
import type { Edition } from './documents/model'
import { announceIdeas } from './ideas'
import { libraryChanges, libraryStores, openDatabase, resultOf, committed, writing } from './library'
import type { Book, TrashEntry } from './library'

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
    if (entry.kind === 'idea') {
      if (!entry.bookId) return { entry, place: '' }
      const book: Book | undefined = await resultOf(tx.objectStore('books').get([entry.library, entry.bookId]))
      return { entry, place: book ? book.title : t('ideas.workGone') }
    }
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
  const tx = db.transaction([...libraryStores, 'ideas'], 'readwrite', { durability: 'strict' })
  const books = tx.objectStore('books')
  const files = tx.objectStore('files')
  const editions = tx.objectStore('editions')
  const chapters = tx.objectStore('chapters')
  const ideas = tx.objectStore('ideas')
  const trash = tx.objectStore('trash')
  const { step, done } = writing<{ entry: TrashEntry; edition?: Edition }>(tx)
  const request = trash.get(id)
  request.onsuccess = step(() => {
    const entry: TrashEntry | undefined = request.result
    if (!entry) throw new Error(t('trash.thisItemIsNoLongerInTheTrash'))
    const key = [entry.library, entry.bookId]
    trash.delete(id)
    if (entry.kind === 'idea') {
      const items = entry.ideas ?? []
      if (!items.length) throw new Error(t('trash.thisItemIsNoLongerInTheTrash'))
      for (const idea of items) ideas.put(idea)
      return { entry }
    }
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
    if (restored.entry.kind === 'idea') announceIdeas()
    else libraryChanges.dispatchEvent(new Event('update'))
    return restored
  } catch (error) {
    // Ids are unique, so a constraint can only come from an identical original imported after the deletion.
    if (error instanceof DOMException && error.name === 'ConstraintError') throw new Error(t('trash.theLibraryAlreadyContainsAnIdenticalOriginalFile'))
    throw error
  }
}

function chapterTupleKey(library: string, bookId: string, editionId: string, chapterId: string) {
  return `${library}\0${bookId}\0${editionId}\0${chapterId}`
}

/**
 * Permanently deletes one trash entry (`id`) or empties the entire trash in one strict
 * IndexedDB transaction, cascading cleanup to exclusively owned `revisions`, `aiBaselines`,
 * and `ideaRevisions` while preserving shared deduplicated `revisionBlobs` still referenced
 * by surviving active or remaining-trashed revisions.
 */
export async function emptyTrash(id?: string) {
  const db = await openDatabase()
  const tx = db.transaction(
    ['chapters', 'ideas', 'trash', 'revisions', 'revisionBlobs', 'aiBaselines', 'ideaRevisions'],
    'readwrite',
    { durability: 'strict' },
  )
  const chaptersStore = tx.objectStore('chapters')
  const ideasStore = tx.objectStore('ideas')
  const trashStore = tx.objectStore('trash')
  const revisionsStore = tx.objectStore('revisions')
  const blobsStore = tx.objectStore('revisionBlobs')
  const baselinesStore = tx.objectStore('aiBaselines')
  const ideaRevsStore = tx.objectStore('ideaRevisions')

  const chaptersReq = chaptersStore.getAll()
  const ideasReq = ideasStore.getAll()
  const trashReq = trashStore.getAll()
  const revsReq = revisionsStore.getAll()
  const blobsReq = blobsStore.getAll()
  const baselinesReq = baselinesStore.getAll()
  const ideaRevsReq = ideaRevsStore.getAll()

  let stepError: unknown
  ideaRevsReq.onsuccess = () => {
    try {
      const allTrash = trashReq.result as Array<{
        id: string
        chapters?: Array<{ library: string; bookId: string; editionId: string; id: string }>
        ideas?: Array<{ id: string }>
      }>
      const remainingTrash = id ? allTrash.filter((entry) => entry.id !== id) : []
      if (id) trashStore.delete(id)
      else trashStore.clear()

      const reachableChapters = new Set<string>()
      for (const ch of chaptersReq.result as Array<{ library: string; bookId: string; editionId: string; id: string }>) {
        reachableChapters.add(chapterTupleKey(ch.library, ch.bookId, ch.editionId, ch.id))
      }
      const reachableIdeas = new Set<string>()
      for (const idea of ideasReq.result as Array<{ id: string }>) {
        reachableIdeas.add(idea.id)
      }

      for (const entry of remainingTrash) {
        for (const ch of entry.chapters ?? []) {
          reachableChapters.add(chapterTupleKey(ch.library, ch.bookId, ch.editionId, ch.id))
        }
        for (const idea of entry.ideas ?? []) {
          reachableIdeas.add(idea.id)
        }
      }

      const survivingBlobHashes = new Set<string>()
      for (const rev of revsReq.result as Array<{
        id: string
        library: string
        bookId: string
        editionId: string
        chapterId: string
        blobHash?: string
      }>) {
        if (reachableChapters.has(chapterTupleKey(rev.library, rev.bookId, rev.editionId, rev.chapterId))) {
          if (rev.blobHash) survivingBlobHashes.add(rev.blobHash)
        } else {
          revisionsStore.delete(rev.id)
        }
      }

      for (const blob of blobsReq.result as Array<{ hash: string }>) {
        if (!survivingBlobHashes.has(blob.hash)) {
          blobsStore.delete(blob.hash)
        }
      }

      for (const baseline of baselinesReq.result as Array<{
        clientId: string
        library: string
        bookId: string
        editionId: string
        chapterId: string
      }>) {
        if (!reachableChapters.has(chapterTupleKey(baseline.library, baseline.bookId, baseline.editionId, baseline.chapterId))) {
          baselinesStore.delete([baseline.clientId, baseline.library, baseline.bookId, baseline.editionId, baseline.chapterId])
        }
      }

      for (const ideaRev of ideaRevsReq.result as Array<{ id: string; ideaId: string }>) {
        if (!reachableIdeas.has(ideaRev.ideaId)) {
          ideaRevsStore.delete(ideaRev.id)
        }
      }
    } catch (error) {
      stepError = error
      try { tx.abort() } catch { /* Transaction may already be aborting. */ }
    }
  }

  try {
    await committed(tx)
  } catch (error) {
    throw stepError ?? error
  }
  libraryChanges.dispatchEvent(new Event('update'))
}
