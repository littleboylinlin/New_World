import { fileFormat, maxImportSize } from './formats'
import type { Format } from './formats'

export type LibraryId = 'original' | 'reference'

export interface Book {
  library: LibraryId
  id: string
  title: string
  originalName: string
  format: Format
  size: number
  importedAt: number
  digest: string
}

interface BookFile {
  library: LibraryId
  id: string
  blob: Blob
}

let connection: Promise<IDBDatabase> | undefined
export const maxTitleLength = 255

function openDatabase() {
  if (connection) return connection
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('new-world-library', 1)
    let blocked = false
    request.onupgradeneeded = () => {
      const db = request.result
      const books = db.createObjectStore('books', { keyPath: ['library', 'id'] })
      books.createIndex('byLibrary', 'library')
      books.createIndex('byLibraryDigest', ['library', 'digest'], { unique: true })
      db.createObjectStore('files', { keyPath: ['library', 'id'] })
    }
    request.onsuccess = () => {
      const db = request.result
      const disconnect = () => {
        db.close()
        if (connection === opening) connection = undefined
      }
      db.onversionchange = disconnect
      db.onclose = disconnect
      if (blocked) disconnect()
      else resolve(db)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => {
      blocked = true
      reject(new Error('其他 New World 页面正在使用旧版书库。关闭那些页面后再试。'))
    }
  })
  connection = opening
  void opening.catch(() => {
    if (connection === opening) connection = undefined
  })
  return opening
}

function resultOf<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('书库操作已中断。'))
  })
}

export async function listBooks(library: LibraryId): Promise<Book[]> {
  const db = await openDatabase()
  const index = db.transaction('books').objectStore('books').index('byLibrary')
  const books: Book[] = await resultOf(index.getAll(library))
  return books.sort((a, b) => b.importedAt - a.importedAt || a.title.localeCompare(b.title, 'zh-CN'))
}

export async function readBook(library: LibraryId, id: string) {
  const db = await openDatabase()
  const tx = db.transaction(['books', 'files'])
  const key = [library, id]
  const [book, file]: [Book | undefined, BookFile | undefined] = await Promise.all([
    resultOf(tx.objectStore('books').get(key)),
    resultOf(tx.objectStore('files').get(key)),
  ])
  if (!book) return null
  if (!file) throw new Error('此作品的原文件在本地书库中缺失。')
  return { book, blob: file.blob }
}

export async function importBook(library: LibraryId, file: File) {
  const format = fileFormat(file.name)
  if (!format) throw new Error('此文件扩展名不在导入列表中。')
  if (file.size === 0) throw new Error('文件为空。')
  if (file.size > maxImportSize) throw new Error('单个文件不能超过 128 MiB。')
  if (!globalThis.crypto?.subtle) throw new Error('请在 HTTPS 或本机 localhost 中打开 New World。')

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
  const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const book: Book = {
    library, format, digest,
    id: crypto.randomUUID(),
    title: (file.name.replace(/\.[^.]+$/, '').trim() || file.name).slice(0, maxTitleLength),
    originalName: file.name,
    size: file.size,
    importedAt: Date.now(),
  }

  const db = await openDatabase()
  const tx = db.transaction(['books', 'files'], 'readwrite', { durability: 'strict' })
  const books = tx.objectStore('books')
  const files = tx.objectStore('files')
  const existing = books.index('byLibraryDigest').get([library, digest])
  let duplicate: Book | undefined
  existing.onsuccess = () => {
    duplicate = existing.result
    if (!duplicate) {
      books.add(book)
      files.add({ library, id: book.id, blob: file } satisfies BookFile)
    }
  }
  await committed(tx)
  return duplicate ? { book: duplicate, duplicate: true } : { book, duplicate: false }
}

export async function renameBook(library: LibraryId, id: string, value: string) {
  const title = value.trim()
  if (!title || title.length > maxTitleLength) throw new Error('请输入有效的作品名。')
  const db = await openDatabase()
  const tx = db.transaction('books', 'readwrite', { durability: 'strict' })
  const books = tx.objectStore('books')
  const request = books.get([library, id])
  let found = false
  request.onsuccess = () => {
    const book: Book | undefined = request.result
    if (book) {
      found = true
      books.put({ ...book, title })
    }
  }
  await committed(tx)
  if (!found) throw new Error('此作品已从书库移除。')
}

export async function deleteBook(library: LibraryId, id: string) {
  const db = await openDatabase()
  const tx = db.transaction(['books', 'files'], 'readwrite', { durability: 'strict' })
  const key = [library, id]
  tx.objectStore('books').delete(key)
  tx.objectStore('files').delete(key)
  await committed(tx)
}

export function storageError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'QuotaExceededError') return '本地存储空间不足，未保存本次更改。'
    if (error.name === 'SecurityError' || error.name === 'InvalidStateError') {
      return '当前浏览器环境无法访问本地书库。请检查网站存储权限后重试。'
    }
    return '本地书库操作失败，请重试。'
  }
  return error instanceof Error ? error.message : '本地书库操作失败，请重试。'
}
