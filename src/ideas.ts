// Ideas: short notes jotted down the moment they come, with or without the work they belong to.

import { t } from './i18n'
import { ConfirmStateConflictError, synchronousContentHash } from './documents/revisions'
import { committed, libraryChanges, openDatabase, resultOf, trashEntry, writing } from './library'
import type { IdeaRevision, LibraryId, RevisionSource, TrashEntry } from './library'

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

export function buildIdeaRevision(input: {
  idea: Idea
  source: RevisionSource
  action: string
  clientId?: string
  clientName?: string
  createdAt?: number
}): IdeaRevision {
  const hashPayload = JSON.stringify({
    text: input.idea.text,
    library: input.idea.library ?? null,
    bookId: input.idea.bookId ?? null,
    usedAt: input.idea.usedAt ?? null,
  })
  return {
    id: crypto.randomUUID(),
    ideaId: input.idea.id,
    text: input.idea.text,
    ...(input.idea.library ? { library: input.idea.library } : {}),
    ...(input.idea.bookId ? { bookId: input.idea.bookId } : {}),
    ...(input.idea.usedAt !== undefined ? { usedAt: input.idea.usedAt } : {}),
    ideaCreatedAt: input.idea.createdAt,
    createdAt: input.createdAt ?? Date.now(),
    source: input.source,
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.clientName ? { clientName: input.clientName } : {}),
    action: input.action,
    contentHash: synchronousContentHash(hashPayload),
  }
}

export async function listIdeaRevisions(ideaId: string): Promise<IdeaRevision[]> {
  const db = await openDatabase()
  const index = db.transaction('ideaRevisions').objectStore('ideaRevisions').index('byIdea')
  const rows: IdeaRevision[] = await resultOf(index.getAll(ideaId))
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

export async function listIdeaRevisionCounts(): Promise<Map<string, number>> {
  const db = await openDatabase()
  const rows: IdeaRevision[] = await resultOf(db.transaction('ideaRevisions').objectStore('ideaRevisions').getAll())
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.ideaId, (counts.get(row.ideaId) ?? 0) + 1)
  return counts
}

/**
 * Atomically saves a complete pre-edit snapshot in `ideaRevisions` before updating an `Idea`.
 * If persisting the snapshot fails (e.g. QuotaExceededError), the strict transaction aborts and preserves the original note.
 */
export async function applyAiIdeaUpdate(params: {
  id: string
  clientId: string
  clientName: string
  nextText?: string
  nextWork?: { library: LibraryId; bookId: string } | null
  nextUsed?: boolean
  action?: string
  expected?: {
    text: string
    library?: LibraryId
    bookId?: string
    usedAt?: number
  }
}): Promise<{ idea: Idea; snapshot: IdeaRevision }> {
  let cleanText: string | undefined
  if (params.nextText !== undefined) {
    cleanText = params.nextText.trim()
    if (!cleanText) throw new Error(t('ideas.empty'))
    if (cleanText.length > maxIdeaLength) throw new Error(t('ideas.tooLong', [maxIdeaLength]))
  }

  const db = await openDatabase()
  const tx = db.transaction(['ideas', 'ideaRevisions'], 'readwrite', { durability: 'strict' })
  const ideas = tx.objectStore('ideas')
  const ideaRevisions = tx.objectStore('ideaRevisions')
  const { step, done } = writing<{ idea: Idea; snapshot: IdeaRevision }>(tx)
  const request = ideas.get(params.id)

  request.onsuccess = step(() => {
    const current: Idea | undefined = request.result
    if (!current) throw new Error('Note not found')
    if (params.expected) {
      if (
        current.text !== params.expected.text ||
        (current.library ?? undefined) !== params.expected.library ||
        (current.bookId ?? undefined) !== params.expected.bookId ||
        (current.usedAt ?? undefined) !== params.expected.usedAt
      ) {
        throw new ConfirmStateConflictError()
      }
    }

    const snapshot = buildIdeaRevision({
      idea: current,
      source: 'ai',
      action: params.action ?? 'ideas.update',
      clientId: params.clientId,
      clientName: params.clientName,
    })
    ideaRevisions.add(snapshot)

    const { library: _lib, bookId: _book, usedAt: _used, ...base } = current
    const workFields = params.nextWork === null
      ? {}
      : params.nextWork
        ? { library: params.nextWork.library, bookId: params.nextWork.bookId }
        : current.library && current.bookId
          ? { library: current.library, bookId: current.bookId }
          : {}
    const usedFields = params.nextUsed === false
      ? {}
      : params.nextUsed === true
        ? { usedAt: current.usedAt ?? Date.now() }
        : current.usedAt !== undefined
          ? { usedAt: current.usedAt }
          : {}

    const next: Idea = {
      ...base,
      text: cleanText ?? current.text,
      ...workFields,
      ...usedFields,
    }
    ideas.put(next)
    return { idea: next, snapshot }
  })

  const result = await done()
  announceIdeas()
  return result
}

/** Atomically restores a historical snapshot of an idea while backing up the current state first. */
export async function restoreIdeaRevision(ideaId: string, revisionId: string): Promise<{
  idea: Idea
  backupRevision: IdeaRevision
  restoredFrom: IdeaRevision
}> {
  const db = await openDatabase()
  const tx = db.transaction(['ideas', 'ideaRevisions'], 'readwrite', { durability: 'strict' })
  const ideas = tx.objectStore('ideas')
  const ideaRevisions = tx.objectStore('ideaRevisions')
  const { step, done } = writing<{
    idea: Idea
    backupRevision: IdeaRevision
    restoredFrom: IdeaRevision
  }>(tx)

  const ideaReq = ideas.get(ideaId)
  const revReq = ideaRevisions.get(revisionId)

  revReq.onsuccess = step(() => {
    const current: Idea | undefined = ideaReq.result
    const targetRev: IdeaRevision | undefined = revReq.result
    if (!current || !targetRev || targetRev.ideaId !== ideaId) {
      throw new Error(t('revisions.ideaNotFound'))
    }

    const backupRevision = buildIdeaRevision({
      idea: current,
      source: 'user-restore',
      action: 'restore.backup',
    })
    ideaRevisions.add(backupRevision)

    const next: Idea = {
      id: current.id,
      text: targetRev.text,
      createdAt: current.createdAt,
      ...(targetRev.library && targetRev.bookId ? { library: targetRev.library, bookId: targetRev.bookId } : {}),
      ...(targetRev.usedAt !== undefined ? { usedAt: targetRev.usedAt } : {}),
    }
    ideas.put(next)
    return { idea: next, backupRevision, restoredFrom: targetRev }
  })

  const result = await done()
  announceIdeas()
  return result
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
