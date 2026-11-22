import { t } from '../i18n'
import { openDatabase, resultOf, trashEntry, writing } from '../library'
import type { Book, TrashEntry } from '../library'
import type { Edition } from '../documents/model'
import { announceStoryChange } from './changes'
import { isStoryCard, storyChapterKey, uniqueAliases } from './model'
import type { StoryCard, StoryCardInput, StoryWork } from './model'

const workKey = (work: StoryWork) => [work.library, work.bookId]
const cardKey = (card: StoryCard) => [...workKey(card), card.id]

export async function listStoryCards(work: StoryWork): Promise<StoryCard[]> {
  const db = await openDatabase()
  return resultOf(db.transaction('storyCards').objectStore('storyCards').index('byBook').getAll(workKey(work)))
}

export async function readStorySettings(work: StoryWork) {
  const db = await openDatabase()
  const tx = db.transaction(['books', 'editions', 'storyCards', 'trash'])
  const key = workKey(work)
  const [book, editions, cards, trash]: [Book | undefined, Edition[], StoryCard[], TrashEntry[]] = await Promise.all([
    resultOf(tx.objectStore('books').get(key)),
    resultOf(tx.objectStore('editions').index('byBook').getAll(key)),
    resultOf(tx.objectStore('storyCards').index('byBook').getAll(key)),
    resultOf(tx.objectStore('trash').index('byWorkKind').getAll([...key, 'storyCard'])),
  ])
  return {
    book: book?.workId ? undefined : book,
    editions: editions.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name)),
    cards,
    trash: trash.sort((a, b) => b.deletedAt - a.deletedAt),
  }
}

/** Validates new links and checks the expected revision in the same transaction as the write. */
export async function saveStoryCard(work: StoryWork, input: StoryCardInput, previous?: Pick<StoryCard, 'id' | 'revision'>) {
  const now = Date.now()
  const card: StoryCard = {
    ...structuredClone(input), library: work.library, bookId: work.bookId,
    id: previous?.id ?? crypto.randomUUID(), revision: crypto.randomUUID(), createdAt: now, updatedAt: now,
  }
  card.name = card.name.trim()
  card.aliases = uniqueAliases(card.name, card.aliases)
  card.relations.forEach((relation) => { relation.name = relation.name.trim() })
  if (!isStoryCard(card)) throw new Error(t('story.invalidCard'))
  const db = await openDatabase()
  const tx = db.transaction(['books', 'editions', 'storyCards'], 'readwrite', { durability: 'strict' })
  const cards = tx.objectStore('storyCards')
  const { step, done } = writing<StoryCard>(tx)
  const owner = tx.objectStore('books').get(workKey(work))
  const stored = previous ? cards.get(cardKey(card)) : undefined
  const targetIds = new Set(card.relations.map(({ targetCardId }) => targetCardId))
  const targets = [...targetIds].map((id) => [id, cards.get([...workKey(work), id])] as const)
  const editions = tx.objectStore('editions').index('byBook').getAll(workKey(work))
  editions.onsuccess = step(() => {
    const book: Book | undefined = owner.result
    if (!book || book.workId) throw new Error(t('store.thisWorkHasBeenRemovedFromTheLibrary'))
    const current: StoryCard | undefined = stored?.result
    if (previous && current?.revision !== previous.revision) throw new Error(t('story.conflict'))
    const linksWere = new Set(current?.chapters.map(storyChapterKey))
    const statesWere = new Set(current?.states.map(storyChapterKey))
    const chapters = new Map((editions.result as Edition[]).map((edition) => [edition.id, new Set(edition.chapters.map(({ id }) => id))]))
    const chapterExists = (ref: StoryCardInput['chapters'][number]) => chapters.get(ref.editionId)?.has(ref.chapterId)
    if (card.chapters.some((ref) => !linksWere.has(storyChapterKey(ref)) && !chapterExists(ref))
      || card.states.some((ref) => !statesWere.has(storyChapterKey(ref)) && !chapterExists(ref))) {
      throw new Error(t('story.chapterUnavailable'))
    }
    const targetsWere = new Set(current?.relations.map((relation) => relation.targetCardId))
    for (const [id, request] of targets) {
      if (!request.result && !targetsWere.has(id)) throw new Error(t('story.cardUnavailable'))
    }
    if (current) {
      card.createdAt = current.createdAt
      cards.put(card)
    } else cards.add(card)
    return card
  })
  const saved = await done()
  announceStoryChange(work)
  return saved
}

export async function deleteStoryCard(card: StoryCard) {
  const db = await openDatabase()
  const tx = db.transaction(['storyCards', 'trash'], 'readwrite', { durability: 'strict' })
  const cards = tx.objectStore('storyCards')
  const { step, done } = writing<TrashEntry>(tx)
  const request = cards.get(cardKey(card))
  request.onsuccess = step(() => {
    const current: StoryCard | undefined = request.result
    if (!current || current.revision !== card.revision) throw new Error(t('story.conflict'))
    const entry = trashEntry('storyCard', current.library, current.bookId, current.name)
    entry.storyCards = [current]
    tx.objectStore('trash').add(entry)
    cards.delete(cardKey(current))
    return entry
  })
  const entry = await done()
  announceStoryChange(card)
  return entry
}
