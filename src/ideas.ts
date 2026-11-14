// Ideas: short notes jotted down the moment they come, with or without the work they belong to.

import { t } from './i18n'
import { committed, libraryChanges, openDatabase, resultOf, trashEntry, writing } from './library'
import type { LibraryId, TrashEntry } from './library'

export interface Idea {
  id: string
  text: string
  createdAt: number
  library?: LibraryId
  bookId?: string
  /** Set once the idea has been used in the writing. */
  usedAt?: number
}

export const maxIdeaLength = 20_000
const channelName = 'new-world-ideas'
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : undefined

// The quick note window and the main window are separate pages, so a change is announced to both.
export function announceIdeas() {
  libraryChanges.dispatchEvent(new Event('update'))
  channel?.postMessage('changed')
}
channel?.addEventListener('message', () => libraryChanges.dispatchEvent(new Event('update')))

async function write(change: (store: IDBObjectStore) => void) {
  const db = await openDatabase()
  const tx = db.transaction('ideas', 'readwrite', { durability: 'strict' })
  change(tx.objectStore('ideas'))
  await committed(tx)
  announceIdeas()
}

export async function addIdea(text: string, work?: { library: LibraryId; bookId: string }) {
  const value = text.trim()
  if (!value) throw new Error(t('ideas.empty'))
  if (value.length > maxIdeaLength) throw new Error(t('ideas.tooLong', [maxIdeaLength]))
  const idea: Idea = { id: crypto.randomUUID(), text: value, createdAt: Date.now(), ...(work ? { library: work.library, bookId: work.bookId } : {}) }
  await write((store) => store.add(idea))
  return idea
}

/** Newest first. */
export async function listIdeas() {
  const db = await openDatabase()
  const ideas: Idea[] = await resultOf(db.transaction('ideas').objectStore('ideas').getAll())
  return ideas.sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveIdea(idea: Idea) {
  await write((store) => store.put(idea))
  return idea
}

export async function setIdeaUsed(idea: Idea, used: boolean) {
  const { usedAt: _previous, ...rest } = idea
  return saveIdea(used ? { ...rest, usedAt: Date.now() } : rest)
}

export async function deleteIdea(id: string): Promise<TrashEntry | undefined> {
  const db = await openDatabase()
  const tx = db.transaction(['ideas', 'trash'], 'readwrite', { durability: 'strict' })
  const ideas = tx.objectStore('ideas')
  const { step, done } = writing<TrashEntry | undefined>(tx)
  const request = ideas.get(id)
  request.onsuccess = step(() => {
    const idea: Idea | undefined = request.result
    if (!idea) return undefined
    const preview = Array.from(idea.text.replace(/\s+/g, ' ').trim()).slice(0, 48).join('')
    const entry = trashEntry('idea', idea.library ?? 'original', idea.bookId ?? '', preview || t('ideas.title'))
    entry.ideas = [idea]
    ideas.delete(id)
    tx.objectStore('trash').add(entry)
    return entry
  })
  const entry = await done()
  if (entry) announceIdeas()
  return entry
}

const lastWorkKey = 'new-world:last-work'
const recentKey = 'new-world:recent-works'

export interface WorkRef {
  library: LibraryId
  bookId: string
}

/** Remembers the work last opened, which new ideas belong to by default, and the recent works. */
export function rememberWork(work: WorkRef) {
  try {
    localStorage.setItem(lastWorkKey, JSON.stringify(work))
    const recent = recentWorks().filter((item) => item.library !== work.library || item.bookId !== work.bookId)
    localStorage.setItem(recentKey, JSON.stringify([work, ...recent].slice(0, 5)))
  } catch { /* Only the default choice is lost. */ }
}

export function lastWork(): WorkRef | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(lastWorkKey) ?? 'null')
    return value && typeof value.bookId === 'string' && (value.library === 'original' || value.library === 'reference') ? value : undefined
  } catch {
    return undefined
  }
}

export function recentWorks(): WorkRef[] {
  try {
    const value = JSON.parse(localStorage.getItem(recentKey) ?? '[]')
    return Array.isArray(value) ? value.filter((item) => typeof item?.bookId === 'string' && (item.library === 'original' || item.library === 'reference')) : []
  } catch {
    return []
  }
}
