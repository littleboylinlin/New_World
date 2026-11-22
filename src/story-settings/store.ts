import { t } from '../i18n'
import { openDatabase, resultOf, writing } from '../library'
import type { Book, TrashEntry } from '../library'
import type { Edition } from '../documents/model'
import { announceStoryChange } from './changes'
import { emptyStoryBoard, isStoryScene, isStoryView, storyCards, storyChapterKey } from './model'
import type { StoryBoard, StoryScene, StoryView, StoryWork } from './model'

const keyOf = (work: StoryWork) => [work.library, work.bookId]

export async function listStoryCards(work: StoryWork) {
  const db = await openDatabase()
  const board: StoryBoard | undefined = await resultOf(db.transaction('storyBoards').objectStore('storyBoards').get(keyOf(work)))
  return board ? storyCards(board.scene) : []
}

export async function readStorySettings(work: StoryWork) {
  const db = await openDatabase()
  const tx = db.transaction(['books', 'editions', 'storyBoards', 'trash'])
  const key = keyOf(work)
  const [book, editions, board, trash]: [Book | undefined, Edition[], StoryBoard | undefined, TrashEntry[]] = await Promise.all([
    resultOf(tx.objectStore('books').get(key)),
    resultOf(tx.objectStore('editions').index('byBook').getAll(key)),
    resultOf(tx.objectStore('storyBoards').get(key)),
    resultOf(tx.objectStore('trash').index('byWorkKind').getAll([...key, 'storyCard'])),
  ])
  return {
    book: book?.workId ? undefined : book, board: board ?? emptyStoryBoard(work),
    editions: editions.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name)),
    trash: trash.filter((entry) => entry.storyCard).sort((a, b) => b.deletedAt - a.deletedAt),
  }
}

interface TrashChanges {
  add?: TrashEntry[]
  remove?: TrashEntry[]
}

export async function saveStoryScene(work: StoryWork, revision: string, scene: StoryScene, changes: TrashChanges = {}) {
  if (!isStoryScene(scene)) throw new Error(t('story.invalidScene'))
  const db = await openDatabase()
  const tx = db.transaction(['books', 'editions', 'storyBoards', 'trash'], 'readwrite', { durability: 'strict' })
  const boards = tx.objectStore('storyBoards')
  const trash = tx.objectStore('trash')
  const key = keyOf(work)
  const { step, done } = writing<StoryBoard>(tx)
  const owner = tx.objectStore('books').get(key)
  const stored = boards.get(key)
  const removed = (changes.remove ?? []).map((entry) => ({ entry, request: trash.get(entry.id) }))
  const editions = tx.objectStore('editions').index('byBook').getAll(key)
  editions.onsuccess = step(() => {
    const book: Book | undefined = owner.result
    if (!book || book.workId) throw new Error(t('story.workUnavailable'))
    const current: StoryBoard = stored.result ?? emptyStoryBoard(work)
    if (current.revision !== revision) throw new Error(t('story.conflict'))
    const previous = new Map(storyCards(current.scene).map((card) => [card.id, card]))
    const restored = new Map<string, NonNullable<TrashEntry['storyCard']>>()
    for (const { entry, request } of removed) {
      const existing = request.result as TrashEntry | undefined
      if (!existing?.storyCard || existing.bookId !== work.bookId || existing.library !== work.library || existing.storyCard.id !== entry.storyCard?.id) {
        throw new Error(t('story.conflict'))
      }
      restored.set(existing.storyCard.id, existing.storyCard)
      trash.delete(existing.id)
    }
    const liveChapters = new Set((editions.result as Edition[]).flatMap((edition) =>
      edition.chapters.map(({ id }) => storyChapterKey({ editionId: edition.id, chapterId: id }))))
    for (const card of storyCards(scene)) {
      const old = previous.get(card.id) ?? restored.get(card.id)
      const prior = new Set([...(old?.chapters ?? []), ...(old?.states ?? [])].map(storyChapterKey))
      // A chapter that was recycled after linking stays attached by its stable ID.
      if ([...card.chapters, ...card.states].some((ref) => {
        const key = storyChapterKey(ref)
        return !prior.has(key) && !liveChapters.has(key)
      })) throw new Error(t('story.chapterUnavailable'))
    }
    for (const entry of changes.add ?? []) trash.add(entry)
    const next = { ...current, revision: crypto.randomUUID(), scene }
    boards.put(next)
    return next
  })
  const saved = await done()
  announceStoryChange(work)
  return saved
}

/** Save the last view independently of edits, including while another tab is writing to the board. */
export async function saveStoryView(work: StoryWork, view: StoryView) {
  if (!isStoryView(view)) return
  const db = await openDatabase()
  const tx = db.transaction(['books', 'storyBoards'], 'readwrite')
  const boards = tx.objectStore('storyBoards')
  const key = keyOf(work)
  const owner = tx.objectStore('books').get(key)
  const stored = boards.get(key)
  const { step, done } = writing<void>(tx)
  stored.onsuccess = step(() => {
    if (owner.result && !owner.result.workId) boards.put({ ...(stored.result ?? emptyStoryBoard(work)), view })
  })
  await done()
}
