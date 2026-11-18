import { libraryChanges, listBooks } from './library'
import type { Book } from './library'
import { collectProject, exportProject, importProject, inspectConflicts } from './projects/store'
import { chapterSaves } from './documents/store'
import { readProject } from './projects/archive'
import { taskChanges } from './tasks/store'
import { recordExport } from './web-storage'

// The folder handle lives in its own small database so the library schema stays untouched.
const databaseName = 'new-world-folder'
const handleKey = 'folder'

export interface FolderState {
  name: string | null
  permission: FolderPermission | null
  lastWrite: number | null
  written: number
  error: string | null
}

export const folderChanges = new EventTarget()
const state: FolderState = { name: null, permission: null, lastWrite: null, written: 0, error: null }
let folder: FileSystemDirectoryHandle | null = null
const signatures = new Map<string, string>()
// Works waiting for a write: a chapter save names its work, other library changes may touch any.
let dirty: Set<string> | 'all' = 'all'

export function folderSupported() {
  return !window.newWorldDesktop && typeof window.showDirectoryPicker === 'function'
}

export function folderState(): FolderState {
  return { ...state }
}

function announce() {
  folderChanges.dispatchEvent(new Event('change'))
}

function openStore() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('handles')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function stored(value?: FileSystemDirectoryHandle | null) {
  const db = await openStore()
  try {
    const tx = db.transaction('handles', value === undefined ? 'readonly' : 'readwrite')
    const store = tx.objectStore('handles')
    const request = value === undefined ? store.get(handleKey) : value === null ? store.delete(handleKey) : store.put(value, handleKey)
    return await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      tx.oncomplete = () => resolve(value === undefined ? (request.result as FileSystemDirectoryHandle | undefined) ?? null : value)
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

async function permission(handle: FileSystemDirectoryHandle, ask = false): Promise<FolderPermission> {
  const options = { mode: 'readwrite' } as const
  const current = await handle.queryPermission?.(options) ?? 'granted'
  return current === 'prompt' && ask ? await handle.requestPermission?.(options) ?? 'denied' : current
}

const unsafe = /[<>:"/\\|?*\x00-\x1f]/g
function fileName(book: Book) {
  const title = book.title.replace(unsafe, '_').trim().slice(0, 120) || 'New World'
  return `${title} (${book.id.slice(0, 8)}).newworld`
}

// Cheap change detection: the work's records with blobs reduced to size and type.
async function signature(book: Book) {
  const data = await collectProject({ library: book.library, id: book.id })
  const text = JSON.stringify(data, (_key, value: unknown) =>
    value instanceof Blob ? `blob:${value.size}:${value.type}` : value instanceof Uint8Array ? `bytes:${value.byteLength}` : value)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function entries(handle: FileSystemDirectoryHandle) {
  const files: FileSystemFileHandle[] = []
  for await (const entry of handle.values()) if (entry.kind === 'file' && /\.newworld$/i.test(entry.name)) files.push(entry as FileSystemFileHandle)
  return files
}

async function writeWork(handle: FileSystemDirectoryHandle, book: Book, existing: FileSystemFileHandle[]) {
  const key = `${book.library}/${book.id}`
  const next = await signature(book)
  const name = fileName(book)
  if (signatures.get(key) === next && existing.some((file) => file.name === name)) return false
  const blob = await exportProject({ library: book.library, id: book.id })
  const file = await handle.getFileHandle(name, { create: true })
  const stream = await file.createWritable()
  try { await stream.write(blob); await stream.close() } catch (error) { await stream.abort().catch(() => {}); throw error }
  // A renamed work leaves its old file behind; the id suffix finds it.
  const suffix = ` (${book.id.slice(0, 8)}).newworld`
  for (const old of existing) if (old.name !== name && old.name.endsWith(suffix)) await handle.removeEntry(old.name).catch(() => {})
  signatures.set(key, next)
  return true
}

/** Writes every work whose content changed since the last write. Deleting a work never deletes its file. */
export async function syncFolder() {
  if (!folder) return 0
  state.permission = await permission(folder)
  if (state.permission !== 'granted') { announce(); return 0 }
  const pending = dirty
  dirty = new Set()
  const books = [...await listBooks('original'), ...await listBooks('reference')].filter((book) => !book.workId)
  const existing = await entries(folder)
  let written = 0
  try {
    for (const book of books) {
      if (pending !== 'all' && !pending.has(`${book.library}/${book.id}`)) continue
      if (await writeWork(folder, book, existing)) written++
    }
  } catch (error) {
    dirty = 'all'
    throw error
  }
  if (written) {
    state.lastWrite = Date.now()
    state.written = written
    recordExport(state.lastWrite)
  }
  state.error = null
  announce()
  return written
}

/** Brings back works that are in the folder but not in this browser, such as after clearing site data. */
export async function restoreFromFolder() {
  if (!folder) return 0
  let restored = 0
  for (const entry of await entries(folder)) {
    try {
      const contents = await readProject(await entry.getFile())
      const found = await inspectConflicts(contents)
      if (found.ids || found.works || found.originals) continue
      await importProject(contents, 'preserve')
      restored++
    } catch { /* Unreadable or foreign files are left alone. */ }
  }
  return restored
}

let timer = 0
let running: Promise<unknown> = Promise.resolve()
function schedule(event?: Event) {
  if (!folder) return
  const work = (event as CustomEvent<{ library: string; bookId: string }> | undefined)?.detail
  if (dirty !== 'all') {
    if (work?.bookId) dirty.add(`${work.library}/${work.bookId}`)
    else dirty = 'all'
  }
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    running = running.then(syncFolder).catch((error: unknown) => {
      state.error = error instanceof Error ? error.message : String(error)
      announce()
    })
  }, 1200)
}

export async function chooseFolder() {
  const handle = await window.showDirectoryPicker!({ id: 'new-world', mode: 'readwrite' })
  if (await permission(handle, true) !== 'granted') throw new DOMException('Permission denied', 'NotAllowedError')
  folder = await stored(handle)
  signatures.clear()
  dirty = 'all'
  state.name = handle.name
  const restored = await restoreFromFolder()
  await syncFolder()
  return restored
}

/** Chrome asks again after a restart unless the visitor chose to allow it on every visit. */
export async function reconnectFolder() {
  if (!folder) return 0
  state.permission = await permission(folder, true)
  if (state.permission !== 'granted') { announce(); return 0 }
  dirty = 'all'
  const restored = await restoreFromFolder()
  await syncFolder()
  return restored
}

export async function forgetFolder() {
  window.clearTimeout(timer)
  await stored(null)
  folder = null
  signatures.clear()
  Object.assign(state, { name: null, permission: null, lastWrite: null, written: 0, error: null })
  announce()
}

export async function mountFolderSync() {
  if (!folderSupported()) return
  libraryChanges.addEventListener('update', schedule)
  taskChanges.addEventListener('update', schedule)
  chapterSaves.addEventListener('save', schedule)
  try {
    folder = await stored()
    if (!folder) return
    state.name = folder.name
    state.permission = await permission(folder)
    announce()
    if (state.permission === 'granted') schedule()
  } catch {
    folder = null
  }
}
