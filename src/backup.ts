// A backup is one zip file with the whole library: a manifest of every record and the original
// files beside it. It can be AES-256 encrypted with a password. Restoring replaces the library.

import { BlobReader, BlobWriter, ZipReader, ZipWriter } from '@zip.js/zip.js'
import type { FileEntry } from '@zip.js/zip.js'
import { t } from './i18n'
import { committed, coverOf, libraryChanges, libraryStores, openDatabase, resultOf } from './library'
import type { Book, BookFile, LibraryId, TrashEntry } from './library'
import type { ChapterRecord, Edition } from './documents/model'
import { runningVersion } from './updates'

const manifestName = 'new-world-backup.json'
const formatName = 'new-world-backup'
const formatVersion = 1

interface StoredFile {
  library: LibraryId
  id: string
  path: string
  type: string
}

type StoredTrashEntry = Omit<TrashEntry, 'files'> & { files: StoredFile[] }

interface Manifest {
  format: typeof formatName
  version: number
  app: string
  createdAt: number
  books: Book[]
  files: StoredFile[]
  editions: Edition[]
  chapters: ChapterRecord[]
  trash: StoredTrashEntry[]
}

export interface BackupSummary {
  createdAt: number
  app: string
  works: number
  chapters: number
  trash: number
}

export interface BackupContents {
  summary: BackupSummary
  books: Book[]
  files: BookFile[]
  editions: Edition[]
  chapters: ChapterRecord[]
  trash: TrashEntry[]
}

export type BackupProblem = 'password' | 'format' | 'newer'

export class BackupError extends Error {
  constructor(readonly problem: BackupProblem) {
    super({
      password: t('backup.wrongPassword'),
      format: t('backup.notABackup'),
      newer: t('backup.newerBackup'),
    }[problem])
  }
}

function summarize(manifest: Pick<Manifest, 'createdAt' | 'app' | 'books' | 'chapters' | 'trash'>): BackupSummary {
  return {
    createdAt: manifest.createdAt,
    app: manifest.app,
    works: manifest.books.filter((book) => !book.workId).length,
    chapters: manifest.chapters.length,
    trash: manifest.trash.length,
  }
}

/** A name for a backup file, from its time. */
export function backupName(time: Date, kind: 'backup' | 'auto-backup' | 'before-restore' = 'backup') {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}-${pad(time.getHours())}${pad(time.getMinutes())}${pad(time.getSeconds())}`
  return `New-World-${kind}-${stamp}.zip`
}

/** Reads the whole library at one moment and packs it into a zip, encrypted when a password is given. */
export async function createBackup(password?: string) {
  const db = await openDatabase()
  const tx = db.transaction(libraryStores)
  const [books, files, editions, chapters, trash]: [Book[], BookFile[], Edition[], ChapterRecord[], TrashEntry[]] = await Promise.all([
    resultOf(tx.objectStore('books').getAll()),
    resultOf(tx.objectStore('files').getAll()),
    resultOf(tx.objectStore('editions').getAll()),
    resultOf(tx.objectStore('chapters').getAll()),
    resultOf(tx.objectStore('trash').getAll()),
  ])

  const blobs: [string, Blob][] = []
  const store = (file: BookFile, folder: string): StoredFile => {
    const path = `${folder}/${file.library}/${file.id}`
    blobs.push([path, file.blob])
    return { library: file.library, id: file.id, path, type: file.blob.type }
  }
  // Cover images are blobs on the work records; they go beside the manifest like the original files.
  const pack = (book: Book, folder: string): Book => {
    const { cover: _stored, ...rest } = book
    const cover = coverOf(book)
    if (!cover) return rest as Book
    const path = `${folder}/${book.library}/${book.id}`
    blobs.push([path, cover])
    return { ...rest, cover: { path, type: cover.type } as unknown as Blob } as Book
  }
  const manifest: Manifest = {
    format: formatName, version: formatVersion, app: runningVersion, createdAt: Date.now(),
    editions, chapters,
    books: books.map((book) => pack(book, 'covers')),
    files: files.map((file) => store(file, 'files')),
    trash: trash.map((entry) => ({
      ...entry,
      books: entry.books.map((book) => pack(book, `trash/${entry.id}/covers`)),
      files: entry.files.map((file) => store(file, `trash/${entry.id}`)),
    })),
  }

  const options = password ? { password, encryptionStrength: 3 as const } : {}
  const zip = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false, ...options })
  await zip.add(manifestName, new BlobReader(new Blob([JSON.stringify(manifest)], { type: 'application/json' })))
  for (const [path, blob] of blobs) await zip.add(path, new BlobReader(blob))
  const blob = await zip.close()
  return { blob, summary: summarize(manifest) }
}

async function openZip(file: Blob) {
  const zip = new ZipReader(new BlobReader(file), { useWebWorkers: false })
  try {
    const entries = new Map<string, FileEntry>()
    for (const entry of await zip.getEntries()) if (!entry.directory) entries.set(entry.filename, entry)
    return { zip, entries }
  } catch {
    await zip.close()
    throw new BackupError('format')
  }
}

/** Whether a backup needs a password to open. */
export async function isEncrypted(file: Blob) {
  const { zip, entries } = await openZip(file)
  await zip.close()
  const manifest = entries.get(manifestName)
  if (!manifest) throw new BackupError('format')
  return manifest.encrypted
}

function list(value: unknown) {
  if (!Array.isArray(value)) throw new BackupError('format')
  return value as Record<string, unknown>[]
}

/** Opens a backup and checks it before anything in the library changes. */
export async function readBackup(file: Blob, password?: string): Promise<BackupContents> {
  const { zip, entries } = await openZip(file)
  try {
    const read = async (path: string, type = '') => {
      const entry = entries.get(path)
      if (!entry) throw new BackupError('format')
      if (entry.encrypted && !password) throw new BackupError('password')
      try {
        return await entry.getData(new BlobWriter(type), { password, checkSignature: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (entry.encrypted && /password/i.test(message)) throw new BackupError('password')
        throw new BackupError('format')
      }
    }

    let manifest: Manifest
    try {
      manifest = JSON.parse(await (await read(manifestName)).text())
    } catch (error) {
      if (error instanceof BackupError) throw error
      throw new BackupError('format')
    }
    if (manifest?.format !== formatName || typeof manifest.version !== 'number') throw new BackupError('format')
    if (manifest.version > formatVersion) throw new BackupError('newer')
    for (const name of ['books', 'files', 'editions', 'chapters', 'trash'] as const) list(manifest[name])
    for (const record of [...manifest.books, ...manifest.editions, ...manifest.chapters]) {
      if (!record || (record.library !== 'original' && record.library !== 'reference') || typeof record.id !== 'string') {
        throw new BackupError('format')
      }
    }

    const restore = async (stored: StoredFile): Promise<BookFile> => {
      if (typeof stored?.path !== 'string') throw new BackupError('format')
      return { library: stored.library, id: stored.id, blob: await read(stored.path, stored.type) }
    }
    const unpack = async (book: Book): Promise<Book> => {
      const cover = book.cover as unknown as { path?: unknown; type?: unknown } | undefined
      const { cover: _stored, ...rest } = book
      if (!cover || typeof cover.path !== 'string') return rest as Book
      return { ...rest, cover: await read(cover.path, typeof cover.type === 'string' ? cover.type : '') } as Book
    }
    const books: Book[] = []
    for (const book of manifest.books) books.push(await unpack(book))
    const files: BookFile[] = []
    for (const stored of manifest.files) files.push(await restore(stored))
    const trash: TrashEntry[] = []
    for (const entry of manifest.trash) {
      const entryFiles: BookFile[] = []
      for (const stored of list(entry.files) as unknown as StoredFile[]) entryFiles.push(await restore(stored))
      const entryBooks: Book[] = []
      for (const book of list(entry.books) as unknown as Book[]) entryBooks.push(await unpack(book))
      trash.push({ ...entry, books: entryBooks, files: entryFiles })
    }
    return {
      summary: summarize(manifest),
      books, files, editions: manifest.editions, chapters: manifest.chapters, trash,
    }
  } finally {
    await zip.close()
  }
}

/** Replaces the whole library with a backup in one transaction: either all of it or nothing. */
export async function restoreBackup(contents: BackupContents) {
  const db = await openDatabase()
  const tx = db.transaction(libraryStores, 'readwrite', { durability: 'strict' })
  for (const name of libraryStores) tx.objectStore(name).clear()
  for (const book of contents.books) tx.objectStore('books').add(book)
  for (const file of contents.files) tx.objectStore('files').add(file)
  for (const edition of contents.editions) tx.objectStore('editions').add(edition)
  for (const chapter of contents.chapters) tx.objectStore('chapters').add(chapter)
  for (const entry of contents.trash) tx.objectStore('trash').add(entry)
  try {
    await committed(tx)
  } catch (error) {
    // Records that break the library's rules mean the backup is damaged; anything else (a full disk) is reported as is.
    if (error instanceof DOMException && ['ConstraintError', 'DataError'].includes(error.name)) throw new BackupError('format')
    throw error
  }
  libraryChanges.dispatchEvent(new Event('update'))
}
