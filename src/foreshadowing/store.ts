import { t } from '../i18n'
import { announced, openDatabase, resultOf, writing } from '../library'
import type { Book } from '../library'
import type { Edition } from '../documents/model'
import { validForeshadowingRows } from './model'
import type { Foreshadowing, ForeshadowingFields, ForeshadowingWork } from './model'

const workKey = (work: ForeshadowingWork) => [work.library, work.bookId]
const newestFirst = (left: Foreshadowing, right: Foreshadowing) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)

export async function listForeshadowing(work: ForeshadowingWork) {
  const db = await openDatabase()
  const store = db.transaction('foreshadowing').objectStore('foreshadowing')
  const rows: Foreshadowing[] = await resultOf(store.index('byBook').getAll(workKey(work)))
  return rows.sort(newestFirst)
}

export async function readForeshadowingBox(work: ForeshadowingWork) {
  const db = await openDatabase()
  const tx = db.transaction(['books', 'editions', 'foreshadowing'])
  const key = workKey(work)
  const [book, editions, entries]: [Book | undefined, Edition[], Foreshadowing[]] = await Promise.all([
    resultOf(tx.objectStore('books').get(key)),
    resultOf(tx.objectStore('editions').index('byBook').getAll(key)),
    resultOf(tx.objectStore('foreshadowing').index('byBook').getAll(key)),
  ])
  if (!book || book.workId) throw new Error(t('continuation.thisWorkWasNotFoundInThisLibrary'))
  return { book, editions: editions.sort((left, right) => left.createdAt - right.createdAt), entries: entries.sort(newestFirst) }
}

async function changeEntry(
  work: ForeshadowingWork, id: string, expected: string | undefined,
  change: (current: Foreshadowing | undefined) => ForeshadowingFields | undefined,
) {
  const db = await openDatabase()
  const tx = db.transaction(['books', 'foreshadowing'], 'readwrite', { durability: 'strict' })
  const key = workKey(work)
  const owner = tx.objectStore('books').get(key)
  const store = tx.objectStore('foreshadowing')
  const stored = store.get([...key, id])
  const { step, done } = writing<Foreshadowing | undefined>(tx)
  stored.onsuccess = step(() => {
    const book: Book | undefined = owner.result
    if (!book || book.workId) throw new Error(t('store.thisWorkHasBeenRemovedFromTheLibrary'))
    const current: Foreshadowing | undefined = stored.result
    if (current?.revision !== expected) throw new Error(t('foreshadowing.changedElsewhere'))
    const fields = change(current)
    if (!fields) { store.delete([...key, id]); return }
    const row: Foreshadowing = { ...fields, ...work, id, revision: crypto.randomUUID(), updatedAt: Date.now() }
    if (!validForeshadowingRows([row], [book])) throw new Error(t('foreshadowing.invalidEntry'))
    store.put(row)
    return row
  })
  return announced(done())
}

export async function saveForeshadowing(work: ForeshadowingWork, fields: ForeshadowingFields, current?: Foreshadowing) {
  const id = current?.id ?? crypto.randomUUID()
  return (await changeEntry(work, id, current?.revision, () => fields))!
}

export function setForeshadowingResolved(item: Foreshadowing, resolved: boolean) {
  const { library, bookId, id, revision } = item
  return changeEntry({ library, bookId }, id, revision, (current) => ({ ...current!, resolved }))
}

export function deleteForeshadowing(item: Foreshadowing) {
  const { library, bookId, id, revision } = item
  return changeEntry({ library, bookId }, id, revision, () => undefined)
}
