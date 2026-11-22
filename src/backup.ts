// A backup is one zip file with the whole library: a manifest of every record and the original
// files beside it. It can be AES-256 encrypted with a password. Restoring replaces the library.

import { BlobReader, BlobWriter, ZipReader, ZipWriter } from '@zip.js/zip.js'
import type { FileEntry } from '@zip.js/zip.js'
import { t } from './i18n'
import { committed, coverOf, libraryChanges, libraryStores, openDatabase, resultOf } from './library'
import type { AiChapterBaseline, Book, BookFile, ChapterRevision, IdeaRevision, LibraryId, RevisionBlobRecord, TrashEntry } from './library'
import type { ChapterRecord, Edition } from './documents/model'
import { runningVersion } from './updates'
import type { WritingDay } from './writing-stats'
import type { Idea } from './ideas'
import { validateWorkMetadata } from './work-metadata'
import { taskStores, validateTasks } from './tasks/model'
import { styleChanges, styleStore } from './ai/styles'
import { clearAllBaselines } from './ai/guard'
import { clearWritingSnapshotClock } from './documents/writing-history'
import type { TaskData } from './tasks/model'
import { decodeTaskResources, encodeTaskResources } from './tasks/transfer'
import { validateTaskAssets } from './tasks/resources'
import { announceTasks } from './tasks/store'

const manifestName = 'new-world-backup.json'
const formatName = 'new-world-backup'
const formatVersion = 3

export const maxBackupZipEntries = 10_000
export const maxBackupManifestBytes = 64 * 1024 * 1024
export const maxBackupEntryBytes = 256 * 1024 * 1024
export const maxBackupTotalUncompressedBytes = 2 * 1024 * 1024 * 1024

interface StoredFile {
  library: LibraryId
  id: string
  path: string
  type: string
}

interface StoredRevisionBlob {
  hash: string
  encoding: 'gzip' | 'json'
  rawBytes: number
  storedBytes: number
  createdAt: number
  path: string
}

type StoredTrashEntry = Omit<TrashEntry, 'files'> & { files: StoredFile[] }

interface Manifest {
  taskData?: TaskData
  format: typeof formatName
  version: number
  app: string
  createdAt: number
  books: Book[]
  files: StoredFile[]
  editions: Edition[]
  chapters: ChapterRecord[]
  trash: StoredTrashEntry[]
  /** Daily writing counts for the heatmap. Missing from backups made before v0.14.0. */
  writingDays?: WritingDay[]
  /** Quick notes. Missing from backups made before v0.14.0, which then leave the current ideas alone. */
  ideas?: Idea[]
  /** Pre-edit chapter revision snapshots. Missing from backups made before v0.15.1. */
  revisions?: ChapterRevision[]
  /** Deduplicated compressed revision payloads. Added in v0.15.2. */
  revisionBlobs?: StoredRevisionBlob[]
  /** Pre-edit idea revision snapshots. Added in v0.15.2. */
  ideaRevisions?: IdeaRevision[]
  /** Writing styles and each work's default style. Missing from older backups, which then leave the current ones alone. */
  writingStyles?: StyleRecord[]
  /** Persistent per-client AI cumulative-loss baselines. Added in backup format 3. */
  aiBaselines?: AiChapterBaseline[]
}

/** A row of the writing style store, kept as is. */
type StyleRecord = { type: 'style' | 'workDefault'; id: string } & Record<string, unknown>

export interface BackupSummary {
  createdAt: number
  app: string
  works: number
  chapters: number
  trash: number
}

export interface BackupContents {
  taskData?: TaskData
  summary: BackupSummary
  books: Book[]
  files: BookFile[]
  editions: Edition[]
  chapters: ChapterRecord[]
  trash: TrashEntry[]
  writingDays: WritingDay[]
  ideas?: Idea[]
  revisions?: ChapterRevision[]
  revisionBlobs?: RevisionBlobRecord[]
  ideaRevisions?: IdeaRevision[]
  writingStyles?: StyleRecord[]
  aiBaselines?: AiChapterBaseline[]
}

function validateAiBaselines(value: unknown): AiChapterBaseline[] {
  if (!Array.isArray(value)) throw new BackupError('format')
  const seen = new Set<string>()
  const baselines: AiChapterBaseline[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new BackupError('format')
    const row = item as Record<string, unknown>
    if (
      typeof row.clientId !== 'string' || !row.clientId
      || (row.library !== 'original' && row.library !== 'reference')
      || typeof row.bookId !== 'string' || !row.bookId
      || typeof row.editionId !== 'string' || !row.editionId
      || typeof row.chapterId !== 'string' || !row.chapterId
      || typeof row.peakWords !== 'number' || !Number.isFinite(row.peakWords) || row.peakWords < 0
      || typeof row.anchorWords !== 'number' || !Number.isFinite(row.anchorWords) || row.anchorWords < 0
      || typeof row.anchorText !== 'string'
      || typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt) || row.updatedAt < 0
    ) {
      throw new BackupError('format')
    }
    const key = `${row.clientId}\0${row.library}\0${row.bookId}\0${row.editionId}\0${row.chapterId}`
    if (seen.has(key)) throw new BackupError('format')
    seen.add(key)
    baselines.push({
      clientId: row.clientId,
      library: row.library,
      bookId: row.bookId,
      editionId: row.editionId,
      chapterId: row.chapterId,
      peakWords: row.peakWords,
      anchorWords: row.anchorWords,
      anchorText: row.anchorText,
      updatedAt: row.updatedAt,
    })
  }
  return baselines
}

export type BackupProblem = 'password' | 'format' | 'newer' | 'tooLarge'

export class BackupError extends Error {
  constructor(readonly problem: BackupProblem) {
    super({
      password: t('backup.wrongPassword'),
      format: t('backup.notABackup'),
      newer: t('backup.newerBackup'),
      tooLarge: t('backup.tooLarge'),
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
  const tx = db.transaction([...libraryStores, 'writingDays', 'ideas', 'revisions', 'revisionBlobs', 'ideaRevisions', 'aiBaselines', styleStore, ...taskStores])
  const styleRows: Promise<StyleRecord[]> = resultOf(tx.objectStore(styleStore).getAll())
  const taskReads = Promise.all(taskStores.map(async name => [name, await resultOf(tx.objectStore(name).getAll())]))
  const [books, files, editions, chapters, trash, writingDays, ideas, revisions, revisionBlobRows, ideaRevisions, aiBaselines]: [
    Book[], BookFile[], Edition[], ChapterRecord[], TrashEntry[], WritingDay[], Idea[], ChapterRevision[], RevisionBlobRecord[], IdeaRevision[], AiChapterBaseline[],
  ] = await Promise.all([
    resultOf(tx.objectStore('books').getAll()),
    resultOf(tx.objectStore('files').getAll()),
    resultOf(tx.objectStore('editions').getAll()),
    resultOf(tx.objectStore('chapters').getAll()),
    resultOf(tx.objectStore('trash').getAll()),
    resultOf(tx.objectStore('writingDays').getAll()),
    resultOf(tx.objectStore('ideas').getAll()),
    resultOf(tx.objectStore('revisions').getAll()),
    resultOf(tx.objectStore('revisionBlobs').getAll()),
    resultOf(tx.objectStore('ideaRevisions').getAll()),
    resultOf(tx.objectStore('aiBaselines').getAll()),
  ])

  const blobs: [string, Blob][] = []
  const store = (file: BookFile, folder: string): StoredFile => {
    const path = `${folder}/${file.library}/${file.id}`
    blobs.push([path, file.blob])
    return { library: file.library, id: file.id, path, type: file.blob.type }
  }
  const storedRevisionBlobs: StoredRevisionBlob[] = revisionBlobRows.map((row) => {
    const path = `revision-blobs/${row.hash}`
    const bytes = row.data instanceof Uint8Array ? Uint8Array.from(row.data) : new Uint8Array(row.data)
    blobs.push([path, new Blob([bytes])])
    return {
      hash: row.hash,
      encoding: row.encoding,
      rawBytes: row.rawBytes,
      storedBytes: row.storedBytes,
      createdAt: row.createdAt,
      path,
    }
  })
  // Cover images are blobs on the work records; they go beside the manifest like the original files.
  const pack = (book: Book, folder: string): Book => {
    if (book.metadata !== undefined) validateWorkMetadata(book.metadata)
    const { cover: _stored, ...rest } = book
    const cover = coverOf(book)
    if (!cover) return rest as Book
    const path = `${folder}/${book.library}/${book.id}`
    blobs.push([path, cover])
    return { ...rest, cover: { path, type: cover.type } as unknown as Blob } as Book
  }
  const taskData = Object.fromEntries(await taskReads) as unknown as TaskData
  validateTasks(taskData)
  await validateTaskAssets(taskData)
  const taskAssets = new Set<string>()
  const storedTasks = await encodeTaskResources(taskData, async (id, blob) => {
    const path = `tasks/assets/${id}.bin`
    if (!taskAssets.has(path)) { taskAssets.add(path); blobs.push([path, blob]) }
    return path
  })
  const manifest: Manifest = {
    taskData: storedTasks,
    format: formatName, version: formatVersion, app: runningVersion, createdAt: Date.now(),
    editions, chapters, writingDays, ideas, revisions,
    revisionBlobs: storedRevisionBlobs,
    ideaRevisions,
    aiBaselines,
    writingStyles: await styleRows,
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

function isSafeZipPath(filename: string): boolean {
  if (!filename || filename.startsWith('/') || filename.includes('\\') || filename.includes('\0')) return false
  return !filename.split('/').some((segment) => segment === '..')
}

async function openZip(file: Blob) {
  if (file.size > maxBackupTotalUncompressedBytes) {
    throw new BackupError('tooLarge')
  }
  const zip = new ZipReader(new BlobReader(file), { useWebWorkers: false })
  try {
    const entries = new Map<string, FileEntry>()
    let count = 0
    for await (const entry of zip.getEntriesGenerator()) {
      count++
      if (count > maxBackupZipEntries) {
        throw new BackupError('tooLarge')
      }
      if (entry.directory) continue
      if (!isSafeZipPath(entry.filename) || entries.has(entry.filename)) {
        throw new BackupError('format')
      }
      entries.set(entry.filename, entry)
    }
    return { zip, entries }
  } catch (error) {
    await zip.close()
    if (error instanceof BackupError) throw error
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
    let cumulativeBytes = 0
    const read = async (path: string, type = '', entryLimit = maxBackupEntryBytes) => {
      const entry = entries.get(path)
      if (!entry) throw new BackupError('format')
      if (entry.encrypted && !password) throw new BackupError('password')
      if (
        typeof entry.uncompressedSize === 'number' &&
        (entry.uncompressedSize > entryLimit || cumulativeBytes + entry.uncompressedSize > maxBackupTotalUncompressedBytes)
      ) {
        throw new BackupError('tooLarge')
      }
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let received = 0
      const counter = new WritableStream<Uint8Array>({
        write(chunk) {
          received += chunk.byteLength
          cumulativeBytes += chunk.byteLength
          if (received > entryLimit || cumulativeBytes > maxBackupTotalUncompressedBytes) {
            throw new BackupError('tooLarge')
          }
          chunks.push(Uint8Array.from(chunk))
        },
      })
      try {
        await entry.getData(counter, { password, checkSignature: true })
        return new Blob(chunks, type ? { type } : undefined)
      } catch (error) {
        if (error instanceof BackupError) throw error
        const message = error instanceof Error ? error.message : ''
        if (entry.encrypted && /password/i.test(message)) throw new BackupError('password')
        throw new BackupError('format')
      }
    }

    let manifest: Manifest
    try {
      manifest = JSON.parse(await (await read(manifestName, 'application/json', maxBackupManifestBytes)).text())
    } catch (error) {
      if (error instanceof BackupError) throw error
      throw new BackupError('format')
    }
    if (manifest?.format !== formatName || !Number.isSafeInteger(manifest.version) || manifest.version < 1) throw new BackupError('format')
    if (manifest.version > formatVersion) throw new BackupError('newer')
    if ((manifest.version < 2 && manifest.taskData !== undefined) || (manifest.version >= 2 && manifest.taskData === undefined)) throw new BackupError('format')
    if ((manifest.version < 3 && manifest.aiBaselines !== undefined) || (manifest.version >= 3 && !Array.isArray(manifest.aiBaselines))) throw new BackupError('format')
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
      if (book.metadata !== undefined) validateWorkMetadata(book.metadata)
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
    let revisionBlobs: RevisionBlobRecord[] | undefined
    const validBlobHashes = new Set<string>()
    if (Array.isArray(manifest.revisionBlobs)) {
      revisionBlobs = []
      for (const item of manifest.revisionBlobs) {
        if (
          !item ||
          typeof item.hash !== 'string' ||
          typeof item.path !== 'string' ||
          (item.encoding !== 'gzip' && item.encoding !== 'json') ||
          !Number.isFinite(item.rawBytes) ||
          !Number.isFinite(item.storedBytes)
        ) {
          throw new BackupError('format')
        }
        const rawBlob = await read(item.path)
        const bytes = new Uint8Array(await rawBlob.arrayBuffer())
        revisionBlobs.push({
          hash: item.hash,
          encoding: item.encoding,
          data: bytes,
          rawBytes: item.rawBytes,
          storedBytes: item.storedBytes,
          createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        })
        validBlobHashes.add(item.hash)
      }
    }
    let taskData: TaskData | undefined
    if (manifest.taskData !== undefined) {
      const attachments = [...manifest.taskData.taskAttachments, ...manifest.taskData.taskTemplates.flatMap(t => t.attachments)]
      const types = new Map(attachments.map(a => [(a.content as unknown as { $taskResource?: string })?.$taskResource, a.type]))
      taskData = await decodeTaskResources(manifest.taskData, async (path) => {
        if (!/^tasks\/assets\/[a-f0-9]{64}\.bin$/.test(path) || !types.has(path)) throw new BackupError('format')
        return read(path, types.get(path)!, 16 * 1024 * 1024)
      })
      validateTasks(taskData)
      await validateTaskAssets(taskData)
    }
    return {
      ...(taskData ? { taskData } : {}),
      summary: summarize(manifest),
      books, files, editions: manifest.editions, chapters: manifest.chapters, trash,
      writingDays: (Array.isArray(manifest.writingDays) ? manifest.writingDays : [])
        .filter((day) => typeof day?.date === 'string' && Number.isFinite(day.words)),
      ideas: Array.isArray(manifest.ideas)
        ? manifest.ideas.filter((idea) => typeof idea?.id === 'string' && typeof idea.text === 'string') : undefined,
      revisions: Array.isArray(manifest.revisions)
        ? manifest.revisions.filter(
          (rev) =>
            typeof rev?.id === 'string' &&
            typeof rev.chapterId === 'string' &&
            (rev.content?.type === 'doc' || (typeof rev.blobHash === 'string' && validBlobHashes.has(rev.blobHash))),
        )
        : undefined,
      revisionBlobs,
      ideaRevisions: Array.isArray(manifest.ideaRevisions)
        ? manifest.ideaRevisions.filter((rev) => typeof rev?.id === 'string' && typeof rev.ideaId === 'string' && typeof rev.text === 'string')
        : undefined,
      writingStyles: Array.isArray(manifest.writingStyles)
        ? manifest.writingStyles.filter((row) => typeof row?.id === 'string' && (row.type === 'style' || row.type === 'workDefault'))
        : undefined,
      aiBaselines: manifest.aiBaselines !== undefined ? validateAiBaselines(manifest.aiBaselines) : undefined,
    }
  } finally {
    await zip.close()
  }
}

/** Replaces the whole library with a backup in one transaction: either all of it or nothing. */
export async function restoreBackup(contents: BackupContents) {
  const incomingTasks = contents.taskData === undefined ? undefined : structuredClone(contents.taskData)
  if (incomingTasks) { validateTasks(incomingTasks); await validateTaskAssets(incomingTasks) }
  const db = await openDatabase()
  const tx = db.transaction([...libraryStores, 'writingDays', 'ideas', 'revisions', 'revisionBlobs', 'ideaRevisions', 'aiBaselines', styleStore, ...taskStores], 'readwrite', { durability: 'strict' })
  try {
    if (contents.writingStyles) {
      const styles = tx.objectStore(styleStore)
      styles.clear()
      for (const row of contents.writingStyles) styles.put(row)
    }
    if (incomingTasks) for (const name of taskStores) {
      tx.objectStore(name).clear()
      for (const row of incomingTasks[name]) tx.objectStore(name).add(row)
    }
    for (const name of [...libraryStores, 'revisions', 'revisionBlobs', 'aiBaselines']) tx.objectStore(name).clear()
    if (contents.revisions) {
      const revisions = tx.objectStore('revisions')
      for (const revision of contents.revisions) revisions.add(revision)
    }
    if (contents.revisionBlobs) {
      const revisionBlobs = tx.objectStore('revisionBlobs')
      for (const blob of contents.revisionBlobs) revisionBlobs.put(blob)
    }
    if (contents.aiBaselines) {
      const baselines = tx.objectStore('aiBaselines')
      for (const baseline of contents.aiBaselines) baselines.add(baseline)
    }
    if (contents.ideas) {
      const ideas = tx.objectStore('ideas')
      ideas.clear()
      for (const idea of contents.ideas) ideas.add(idea)
      const ideaRevisions = tx.objectStore('ideaRevisions')
      ideaRevisions.clear()
      if (contents.ideaRevisions) {
        for (const rev of contents.ideaRevisions) ideaRevisions.add(rev)
      }
    } else if (contents.ideaRevisions) {
      const ideaRevisions = tx.objectStore('ideaRevisions')
      ideaRevisions.clear()
      for (const rev of contents.ideaRevisions) ideaRevisions.add(rev)
    }
    // Writing history is kept across restores: each day keeps the larger of the two counts.
    const days = tx.objectStore('writingDays')
    for (const day of contents.writingDays) {
      const stored = days.get(day.date)
      stored.onsuccess = () => {
        const current = (stored.result as WritingDay | undefined)?.words ?? 0
        if (day.words > current) days.put({ date: day.date, words: day.words })
      }
    }
    for (const book of contents.books) tx.objectStore('books').add(book)
    for (const file of contents.files) tx.objectStore('files').add(file)
    for (const edition of contents.editions) tx.objectStore('editions').add(edition)
    for (const chapter of contents.chapters) tx.objectStore('chapters').add(chapter)
    for (const entry of contents.trash) tx.objectStore('trash').add(entry)
    await committed(tx)
  } catch (error) {
    try { tx.abort() } catch { /* Already completed or aborted. */ }
    // Records that break the library's rules mean the backup is damaged; anything else (a full disk) is reported as is.
    if (error instanceof DOMException && ['ConstraintError', 'DataError'].includes(error.name)) throw new BackupError('format')
    throw error
  }
  clearAllBaselines()
  clearWritingSnapshotClock()
  libraryChanges.dispatchEvent(new Event('update'))
  if (contents.writingStyles) styleChanges.dispatchEvent(new Event('change'))
  announceTasks()
}
