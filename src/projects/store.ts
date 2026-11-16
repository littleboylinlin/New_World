import { announced, committed, openDatabase, resultOf, writing } from '../library'
import type { RevisionBlobRecord } from '../library'
import { synchronousContentHash } from '../confirm-state'
import { packProject } from './archive'
import { projectStores, readableProjectSchemas, ProjectError, requireValid as ok } from './model'
import type { ProjectContents, ProjectData, ProjectRoot } from './model'
import { detachedIds, referencedIds, validateData, validatePayloads } from './validate'

/** A single readonly transaction yields a consistent work and its complete historical closure. */
export async function collectProject(root: ProjectRoot): Promise<ProjectData> {
  const db = await openDatabase()
  const tx = db.transaction([...projectStores])
  const data: ProjectData = { books: [], files: [], editions: [], chapters: [], ideas: [], revisions: [], revisionBlobs: [], ideaRevisions: [], aiBaselines: [], trash: [] }
  const owns = (r: { library?: string; bookId?: string }) => r.library === root.library && r.bookId === root.id
  const ideaHistory = new Map<string, ProjectData['ideaRevisions'][number]>()
  const requestedIdeas = new Set<string>()
  const requestedBlobs = new Set<string>()
  const ownedBookIds = new Set([root.id])
  // Queue dependent reads inside IDB callbacks, keeping the snapshot transaction active on Safari.
  const historyForIdea = (id: string) => {
    if (requestedIdeas.has(id)) return
    requestedIdeas.add(id)
    const q = tx.objectStore('ideaRevisions').index('byIdea').getAll(id)
    q.onsuccess = () => { for (const row of q.result) ideaHistory.set(row.id, row) }
  }
  const cursor = (name: 'books' | 'ideas' | 'trash', accept: (value: any) => void, finish?: () => void) => {
    const q = name === 'books' ? tx.objectStore(name).index('byLibrary').openCursor(root.library) : tx.objectStore(name).openCursor()
    q.onsuccess = () => { const c = q.result; if (c) { accept(c.value); c.continue() } else finish?.() }
  }
  cursor('books', (book: ProjectData['books'][number]) => {
    if (book.id !== root.id && book.workId !== root.id) return
    data.books.push(book); ownedBookIds.add(book.id)
    const q = tx.objectStore('files').get([root.library, book.id])
    q.onsuccess = () => { if (q.result) data.files.push(q.result) }
  }, () => {
    const sourceIdeaTrash: ProjectData['trash'] = []
    cursor('trash', (entry: ProjectData['trash'][number]) => {
      if (owns(entry)) {
        data.trash.push(entry)
        for (const book of entry.books) ownedBookIds.add(book.id)
      } else if (entry.library === root.library && entry.kind === 'idea') sourceIdeaTrash.push(entry)
    }, () => {
      data.trash.push(...sourceIdeaTrash.filter((entry) => ownedBookIds.has(entry.bookId)))
      data.trash.sort((a, b) => a.id.localeCompare(b.id))
      for (const entry of data.trash) for (const idea of entry.ideas ?? []) historyForIdea(idea.id)
      // Context-menu capture on an attached original can persist its source book ID, not the root ID.
      const ownsIdea = (idea: { library?: string; bookId?: string }) => idea.library === root.library && !!idea.bookId && ownedBookIds.has(idea.bookId)
      cursor('ideas', (idea: ProjectData['ideas'][number]) => { if (ownsIdea(idea)) { data.ideas.push(idea); historyForIdea(idea.id) } })
      for (const bookId of ownedBookIds) {
        const history = tx.objectStore('ideaRevisions').index('byBook').getAll([root.library, bookId])
        history.onsuccess = () => { for (const row of history.result) ideaHistory.set(row.id, row) }
      }
    })
  })
  for (const name of ['editions', 'chapters', 'revisions', 'aiBaselines'] as const) {
    const q = tx.objectStore(name).index('byBook').getAll([root.library, root.id])
    q.onsuccess = () => {
      ;(data[name] as unknown[]) = q.result
      if (name === 'revisions') for (const r of data.revisions) {
        if (r.content) continue
        const hash = r.blobHash ?? r.contentHash
        if (requestedBlobs.has(hash)) continue
        requestedBlobs.add(hash)
        const blob = tx.objectStore('revisionBlobs').get(hash)
        blob.onsuccess = () => { if (blob.result) data.revisionBlobs.push(blob.result) }
      }
    }
  }
  await committed(tx)
  data.ideaRevisions = [...ideaHistory.values()].sort((a, b) => a.id.localeCompare(b.id))
  data.revisionBlobs.sort((a, b) => a.hash.localeCompare(b.hash))
  data.files.sort((a, b) => a.id.localeCompare(b.id))
  ok(data.books.some((b) => b.id === root.id && !b.workId), 'work not found')
  return data
}
export async function exportProject(root: ProjectRoot) { return packProject(await collectProject(root), root) }

export interface ProjectConflicts { ids: number; works: number; originals: number }
function identities(data: ProjectData): Set<string> {
  const refs = referencedIds(data)
  const annotations = [...data.chapters, ...data.trash.flatMap((t) => t.chapters)].flatMap((c) => c.readingAnnotations?.items.map((a) => a.id) ?? [])
  for (const b of [...data.books, ...data.trash.flatMap((t) => t.books)]) if (b.format !== 'draft') {
    annotations.push(...Object.values(b.readingAnnotations ?? {}).flatMap((a) => a.items.map((i) => i.id)))
  }
  return new Set([
    ...annotations,
    ...Object.values(refs).flatMap((v) => [...v]),
    ...data.revisions.map((v) => v.id), ...data.ideaRevisions.map((v) => v.id), ...data.trash.map((v) => v.id),
  ])
}
function conflicts(incoming: ProjectContents, existing: ProjectData): ProjectConflicts {
  const incomingIds = identities(incoming.data)
  const existingIds = identities(existing)
  const root = incoming.data.books.find((v) => v.id === incoming.manifest.root.id)!
  const originals = new Set(incoming.data.books.filter((b) => b.format !== 'draft').map((b) => b.digest))
  return {
    ids: [...incomingIds].filter((id) => existingIds.has(id)).length,
    works: existing.books.filter((b) => !b.workId && b.library === root.library && (b.id === root.id || b.title === root.title)).length,
    originals: existing.books.filter((b) => b.format !== 'draft' && b.library === root.library && originals.has(b.digest)).length,
  }
}
async function readAll() {
  const db = await openDatabase()
  const tx = db.transaction([...projectStores])
  return Object.fromEntries(await Promise.all(projectStores.map(async (name) => [name, ['files', 'revisionBlobs'].includes(name) ? [] : await resultOf(tx.objectStore(name).getAll())]))) as unknown as ProjectData
}
export async function inspectConflicts(contents: ProjectContents) { return conflicts(contents, await readAll()) }

/** Remaps only model identity fields; text, hashes, client provenance and image data stay intact. */
export function copyProject(contents: ProjectContents, reserved = new Set<string>()): ProjectContents {
  const data = structuredClone(contents.data)
  const mapping = new Map<string, string>()
  for (const old of identities(data)) {
    let next: string
    do { next = crypto.randomUUID() } while (reserved.has(next))
    reserved.add(next); mapping.set(old, next)
  }
  const mapped = (id: string) => mapping.get(id) ?? id
  const walk = (value: any): void => {
    if (!value || typeof value !== 'object' || value instanceof Blob || value instanceof Uint8Array) return
    if (Array.isArray(value)) { value.forEach(walk); return }
    for (const [k, v] of Object.entries(value)) {
      if (k === 'metadata') continue // Unknown metadata may contain literal IDs; it is not a reference graph.
      if (['id', 'bookId', 'workId', 'editionId', 'chapterId', 'ideaId', 'originalId', 'copiedFrom'].includes(k) && typeof v === 'string') value[k] = mapped(v)
      else walk(v)
    }
  }
  walk(data)
  // The idea hash covers its historical owner, so remapping requires recalculating it.
  for (const r of data.ideaRevisions) r.contentHash = synchronousContentHash(JSON.stringify({ text: r.text, library: r.library ?? null, bookId: r.bookId ?? null, usedAt: r.usedAt ?? null }))
  return { data, manifest: { ...contents.manifest, root: { ...contents.manifest.root, id: mapped(contents.manifest.root.id) }, detached: detachedIds(data) } }
}

/** Add only, never clear/overwrite. Conflict recheck and every write share one strict transaction. */
export async function importProject(contents: ProjectContents, mode: 'preserve' | 'copy' | 'skip' = 'preserve') {
  if (mode === 'skip') return null
  // Clone before async verification, preventing UI callers mutating already-validated records.
  const prepared = structuredClone(contents)
  if (!readableProjectSchemas.includes(prepared.manifest.schemaVersion as 1 | 2)) throw new ProjectError('version')
  validateData(prepared.data, prepared.manifest.root, prepared.manifest.detached, prepared.manifest.schemaVersion)
  await validatePayloads(prepared.data)
  const db = await openDatabase()
  const tx = db.transaction([...projectStores], 'readwrite', { durability: 'strict' })
  const blobRequests = prepared.data.revisionBlobs.map((blob) => tx.objectStore('revisionBlobs').get(blob.hash))
  const requests = projectStores.map((name) => ['files', 'revisionBlobs'].includes(name) ? undefined : tx.objectStore(name).getAll())
  const { step, done } = writing<ProjectRoot>(tx)
  requests.at(-1)!.onsuccess = step(() => {
    const current = Object.fromEntries(projectStores.map((name, i) => [name, name === 'revisionBlobs' ? blobRequests.map((q) => q.result).filter(Boolean) : requests[i]?.result ?? []])) as unknown as ProjectData
    const found = conflicts(prepared, current)
    if (mode === 'preserve' && (found.ids || found.works || found.originals)) throw new ProjectError('conflict')
    const incoming = mode === 'copy' ? copyProject(prepared, identities(current)) : prepared
    const blobs = new Map<string, RevisionBlobRecord>(current.revisionBlobs.map((v) => [v.hash, v]))
    for (const name of projectStores) for (const row of incoming.data[name]) {
      if (name === 'revisionBlobs') {
        const b = row as RevisionBlobRecord
        const previous = blobs.get(b.hash)
        if (previous) {
          if (b.encoding !== previous.encoding || b.rawBytes !== previous.rawBytes || b.data.length !== previous.data.length
            || !b.data.every((byte, i) => byte === previous.data[i])) throw new ProjectError('conflict')
          continue
        }
      }
      tx.objectStore(name).add(row)
    }
    return incoming.manifest.root
  })
  return announced(done())
}
