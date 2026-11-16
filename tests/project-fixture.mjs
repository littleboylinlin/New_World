import { getSchema } from '@tiptap/core'
import { Image } from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { StarterKit } from '@tiptap/starter-kit'

// Use the editor's actual JSON serialization, including default attrs and mark ordering, for valid anchors.
export function projectFixture(library, pixel) {
  const content = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '雾港' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '灯塔亮了。', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }, { type: 'strike' }] }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '清点船只' }] }] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: [160] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '潮汐表' }] }] }] }] },
    { type: 'image', attrs: { src: `data:image/png;base64,${pixel}`, alt: '港口插图', title: '夜色' } },
    { type: 'paragraph' },
  ] }
  return { library, pixel, content: getSchema([StarterKit.configure({ link: false }), Image, TableKit]).nodeFromJSON(content).toJSON() }
}

// This function runs in Chromium and seeds real IndexedDB records, not an alternate project encoder.
export async function seedProject({ library = 'original', pixel, content }) {
  const db = await new Promise((resolve, reject) => { const q = indexedDB.open('new-world-library'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error) })
  const id = () => crypto.randomUUID()
  const hash = (text) => {
    let h1 = 0x811c9dc5, h2 = 0x811c9dc5 ^ 0x9e3779b9
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0 }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
  }
  const sha = async (blob) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), (b) => b.toString(16).padStart(2, '0')).join('')
  const now = 1794844800000
  const root = id(), secondOriginal = id(), firstEdition = id(), secondEdition = id(), first = id(), second = id(), copiedChapter = id(), ideaId = id(), deletedChapter = id()
  const image = new Blob([Uint8Array.from(atob(pixel), (c) => c.charCodeAt(0))], { type: 'image/png' })
  const originalText = '# 雾中的港口\r\n\r\n原始字节，不重编码。\r\n'
  const original = new Blob([new Uint8Array([239, 187, 191]), originalText], { type: 'text/markdown' })
  const rootBook = { library, id: root, title: library === 'original' ? '雾港 · 原创验收' : '雾港 · 续写验收', format: 'md', originalName: '原文「雾港」.md', size: original.size, digest: await sha(original), importedAt: now, cover: image }
  const plain = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '旧稿中的灯塔。' }] }] }
  const annotation = { revision: 2, items: [{ id: id(), anchor: { version: 1, kind: 'document', from: 1, to: 3, quote: '雾港', sourceHash: await sha(new Blob([JSON.stringify(content)])) }, text: '开篇的地点', color: '#a1b2c3', inlineColor: '#123456', display: 'inline', collapsed: false, createdAt: now }] }
  rootBook.readingAnnotations = { text: { revision: 1, items: [{ ...annotation.items[0], id: id(), anchor: { version: 1, kind: 'text', from: 2, to: 4, quote: '雾中', sourceHash: await sha(new Blob([originalText])) }, display: 'mark', collapsed: true }] } }
  const edition = { library, bookId: root, id: firstEdition, name: '初稿', source: 'original', originalId: root, notes: ['保留原有导入提示'], chapters: [{ id: first, title: '第一章 · 雾港' }, { id: second, title: '第二章 · 归航' }], createdAt: now, revision: 4 }
  const editionCopy = { ...edition, id: secondEdition, name: '修订稿', source: 'copy', copiedFrom: firstEdition, chapters: [{ id: copiedChapter, title: '新的归航' }], createdAt: now + 1 }
  const raw = new TextEncoder().encode(JSON.stringify(plain))
  const zipped = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  const blobHash = hash(JSON.stringify(plain))
  const data = {
    books: [rootBook], files: [{ library, id: root, blob: original }], editions: [edition, editionCopy],
    chapters: [
      { library, bookId: root, editionId: firstEdition, id: first, content, revision: 2, readingAnnotations: annotation },
      { library, bookId: root, editionId: firstEdition, id: second, content: plain, revision: 1 },
      { library, bookId: root, editionId: secondEdition, id: copiedChapter, content, revision: 0 },
    ],
    ideas: [{ id: ideaId, text: '归航者带回一封信', createdAt: now, library, bookId: root, usedAt: now + 1 }],
    revisions: [{ id: id(), library, bookId: root, editionId: firstEdition, chapterId: first, chapterTitle: '旧章名', editionName: '初稿', chapterRevision: 1, words: 8, contentHash: blobHash, blobHash, rawBytes: raw.length, storedBytes: zipped.length, createdAt: now, source: 'ai', clientId: 'sample-client', clientName: '本地验收', action: 'chapters.update' }],
    revisionBlobs: [{ hash: blobHash, encoding: 'gzip', data: zipped, rawBytes: raw.length, storedBytes: zipped.length, createdAt: now }],
    ideaRevisions: [{ id: id(), ideaId, text: '旧的灵感', ideaCreatedAt: now, createdAt: now, source: 'ai', action: 'ideas.update', contentHash: hash(JSON.stringify({ text: '旧的灵感', library: null, bookId: null, usedAt: null })) }],
    aiBaselines: [{ clientId: 'sample-client', library, bookId: root, editionId: firstEdition, chapterId: first, peakWords: 10, anchorWords: 8, anchorText: '旧稿中的灯塔。', updatedAt: now }],
    trash: [{ id: id(), kind: 'chapter', library, bookId: root, title: '删去的章节', deletedAt: now, books: [], files: [], editions: [], chapters: [{ library, bookId: root, editionId: firstEdition, id: deletedChapter, content: plain, revision: 0 }], position: { editionId: firstEdition, index: 1 } }],
  }
  if (library === 'reference') {
    const source = new Blob(['第二份原文\r\n'], { type: 'text/plain' })
    data.books.push({ library, id: secondOriginal, workId: root, title: '另一份原文', format: 'txt', originalName: '参考 原文.txt', size: source.size, digest: await sha(source), importedAt: now })
    data.files.push({ library, id: secondOriginal, blob: source })
    editionCopy.originalId = secondOriginal
  }
  // A historical chapter with a deleted owner is represented by real history, not invented live records.
  const missingEdition = id(), missingChapter = id()
  data.revisions.push({ ...data.revisions[0], id: id(), editionId: missingEdition, chapterId: missingChapter })
  const tx = db.transaction(Object.keys(data).concat('writingDays'), 'readwrite')
  for (const [name, rows] of Object.entries(data)) for (const row of rows) tx.objectStore(name).add(row)
  // Unrelated work, global idea, trash, activity and local settings must never enter the project.
  const unrelated = id()
  tx.objectStore('books').add({ library: 'original', id: unrelated, title: '无关作品', format: 'draft', importedAt: now })
  tx.objectStore('ideas').add({ id: id(), text: '无关全局灵感', createdAt: now })
  tx.objectStore('trash').add({ ...data.trash[0], id: id(), bookId: unrelated, title: '无关回收记录', chapters: [], position: undefined })
  tx.objectStore('writingDays').put({ date: '2026-11-16', words: 999 })
  await new Promise((r, j) => { tx.oncomplete = r; tx.onabort = () => j(tx.error) })
  db.close()
  localStorage.setItem('project-test-secret', 'should-not-export')
  return { root, library, firstEdition, first, secondEdition, copiedChapter, ideaId, missingEdition, missingChapter, deletedChapter }
}

export async function databaseSnapshot() {
  const db = await new Promise((r) => { const q = indexedDB.open('new-world-library'); q.onsuccess = () => r(q.result) })
  const names = [...db.objectStoreNames]
  const tx = db.transaction(names)
  const rows = await Promise.all(names.map((name) => new Promise((r) => { const q = tx.objectStore(name).getAll(); q.onsuccess = () => r([name, q.result]) })))
  db.close()
  const encode = async (v) => {
    if (v instanceof Blob) return { blob: Array.from(new Uint8Array(await v.arrayBuffer())), type: v.type }
    if (v instanceof Uint8Array) return { bytes: Array.from(v) }
    if (Array.isArray(v)) return Promise.all(v.map(encode))
    if (v && typeof v === 'object') return Object.fromEntries(await Promise.all(Object.entries(v).filter(([,v]) => v !== undefined).map(async ([k,v]) => [k, await encode(v)])))
    return v
  }
  return encode(Object.fromEntries(rows))
}
