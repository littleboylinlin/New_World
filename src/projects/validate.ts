import { getSchema } from '@tiptap/core'
import { documentExtensions, checkDocument } from '../documents/schema'
import { imageInfo } from '../documents/markup'
import { maxChapters, maxEditionImageBytes } from '../documents/model'
import type { DocumentContent } from '../documents/model'
import { validAnnotations } from '../annotations/model'
import { formats, maxImportSize } from '../formats'
import { maxCoverSize, maxTitleLength } from '../library'
import type { Book, ChapterRevision, IdeaRevision } from '../library'
import { synchronousContentHash } from '../confirm-state'
import { limits, projectStores, requireValid as ok, ProjectError, projectSchemaVersion } from './model'
import { validateTasks, projectTaskData } from '../tasks/model'
import { validateTaskAssets } from '../tasks/resources'
import type { Detached, ProjectData, ProjectRoot } from './model'
import { MetadataError, validateWorkMetadata } from '../work-metadata'
import { validStoryRows } from '../story-settings/model'

const schema = getSchema(documentExtensions)
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 255 && !/[\x00-\x1f]/.test(v)
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const title = (v: unknown) => str(v) && !!v.trim() && v.length <= maxTitleLength
const lib = (v: unknown) => v === 'original' || v === 'reference'
export const sha256Pattern = /^[a-f0-9]{64}$/
export async function sha256(blob: Blob) {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Structural fields are closed; inert optional metadata has its own bounded extension envelope. */
function fields(v: object, required: string, optional = '') {
  ok(v && typeof v === 'object' && !Array.isArray(v), 'record object')
  const allowed = new Set((required + ' ' + optional).split(' '))
  const unsupported = Object.keys(v).find((k) => !allowed.has(k))
  if (unsupported !== undefined) throw new ProjectError('unsupported', unsupported.slice(0, 128))
  ok(required.split(' ').filter(Boolean).every((k) => Object.hasOwn(v, k)), 'missing field')
}
export { fields }

export function safeJson(value: unknown, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 1_000_000 || depth > 64) throw new ProjectError('limit')
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || value === undefined) return
  if (typeof value === 'number') { ok(Number.isFinite(value), 'finite number'); return }
  if (value instanceof Blob || value instanceof Uint8Array) return
  ok(typeof value === 'object', 'JSON value')
  if (Array.isArray(value)) for (const item of value) safeJson(item, depth + 1, budget)
  else for (const [key, item] of Object.entries(value)) {
    ok(!['__proto__', 'prototype', 'constructor'].includes(key), 'reserved key')
    safeJson(item, depth + 1, budget)
  }
}

export function validateDocument(content: DocumentContent) {
  safeJson(content)
  let images = 0
  const walk = (node: DocumentContent | NonNullable<DocumentContent['content']>[number]) => {
    fields(node, 'type', 'attrs content marks text')
    ok(str(node.type) && Object.hasOwn(schema.nodes, node.type), 'unsupported document node')
    if (node.text !== undefined) ok(str(node.text), 'text')
    if (node.attrs !== undefined) {
      const allowed = schema.nodes[node.type].spec.attrs ?? {}
      ok(node.attrs && Object.keys(node.attrs).every((k) => Object.hasOwn(allowed, k)), 'unsupported node attribute')
      for (const [key, value] of Object.entries(node.attrs)) {
        if (key === 'src' && node.type === 'image') continue
        if (['alt', 'title', 'language'].includes(key)) ok(value === null || str(value), 'text attribute')
        else if (key === 'colwidth') ok(value === null || (Array.isArray(value) && value.length <= 100 && value.every((n) => num(n) && n <= 10000)), 'table widths')
        else if (['colspan', 'rowspan'].includes(key)) ok(num(value) && Number(value) >= 1 && Number(value) <= 100, 'table span')
        else if (key === 'level') ok(num(value) && Number(value) >= 1 && Number(value) <= 6, 'heading')
        else if (key === 'start') ok(num(value), 'list start')
        else if (key === 'align') ok(value === null || (str(value) && ['left', 'right', 'center'].includes(value)), 'cell alignment')
        else if (key === 'type') ok(value === null || (str(value) && ['1', 'a', 'A', 'i', 'I'].includes(value)), 'list marker')
        else if (key === 'width' || key === 'height') ok(value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100000)
          || (str(value) && /^\d+(?:\.\d+)?(?:px|%)?$/.test(value) && parseFloat(value) <= 100000), 'image dimensions')
        else ok(false, 'unsupported attribute value')
      }
    }
    if (node.type === 'image') {
      const info = imageInfo(node.attrs?.src)
      ok(info, 'unsafe or unavailable embedded image')
      images += info.bytes
    }
    if (node.marks !== undefined) {
      ok(Array.isArray(node.marks), 'marks')
      for (const mark of node.marks) {
        fields(mark, 'type', 'attrs')
        ok(str(mark.type) && Object.hasOwn(schema.marks, mark.type), 'unsupported mark')
        ok(mark.attrs === undefined || (mark.attrs && Object.keys(mark.attrs).every((k) => Object.hasOwn(schema.marks[mark.type].spec.attrs ?? {}, k))), 'mark attrs')
      }
    }
    if (node.content !== undefined) { ok(Array.isArray(node.content), 'content'); node.content.forEach(walk) }
  }
  walk(content)
  ok(images <= maxEditionImageBytes, 'image budget')
  checkDocument(content)
}

function validateIdea(v: ProjectData['ideas'][number]) {
  fields(v, 'id text createdAt', 'library bookId usedAt')
  ok(id(v.id) && str(v.text) && v.text.length <= 20000 && num(v.createdAt), 'idea')
  ok((v.library === undefined && v.bookId === undefined) || (lib(v.library) && id(v.bookId)), 'idea owner')
  if (v.usedAt !== undefined) ok(num(v.usedAt), 'idea usedAt')
}
function revision(v: ChapterRevision | IdeaRevision) {
  ok(id(v.id) && num(v.createdAt) && ['ai', 'user-restore', 'writing'].includes(v.source) && str(v.action) && str(v.contentHash), 'revision')
  if (v.clientId !== undefined) ok(id(v.clientId), 'client provenance')
  if (v.clientName !== undefined) ok(str(v.clientName), 'client name')
}
function validateBook(v: Book, schemaVersion: number) {
  fields(v, 'library id title importedAt format', 'workId archivedAt cover originalName size digest readingAnnotations' + (schemaVersion >= 2 ? ' metadata' : ''))
  if (v.metadata !== undefined) {
    try { validateWorkMetadata(v.metadata) } catch (error) {
      if (error instanceof MetadataError) throw new ProjectError('metadata', error.field)
      throw error
    }
  }
  ok(lib(v.library) && uuid(v.id) && title(v.title) && num(v.importedAt), 'book identity')
  if (v.workId !== undefined) ok(v.library === 'reference' && id(v.workId) && v.workId !== v.id && v.format !== 'draft', 'source parent')
  if (v.archivedAt !== undefined) ok(num(v.archivedAt) && !v.workId, 'archive state')
  if (v.cover !== undefined) ok(v.cover instanceof Blob && v.cover.size > 0 && v.cover.size <= maxCoverSize
    && /^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(v.cover.type), 'cover')
  if (v.format === 'draft') {
    ok(!['size', 'originalName', 'digest', 'readingAnnotations'].some((k) => Object.hasOwn(v, k)), 'draft metadata')
  } else {
    ok(Object.hasOwn(formats, v.format) && str(v.originalName) && v.originalName.length > 0 && num(v.size) && v.size > 0 && v.size <= maxImportSize && sha256Pattern.test(v.digest), 'original metadata')
    if (v.readingAnnotations !== undefined) {
      ok(v.readingAnnotations && typeof v.readingAnnotations === 'object' && !Array.isArray(v.readingAnnotations), 'source annotations')
      for (const [key, annotations] of Object.entries(v.readingAnnotations)) {
        ok(id(key), 'annotation surface')
        annotationsValid(annotations)
      }
    }
  }
}
function annotationsValid(v: NonNullable<ProjectData['chapters'][number]['readingAnnotations']>) {
  ok(validAnnotations(v), 'reading annotations')
  fields(v, 'revision items')
  for (const item of v.items) {
    fields(item, 'id anchor text color display collapsed createdAt', 'inlineColor')
    fields(item.anchor, 'version kind from to quote sourceHash')
    ok(num(item.createdAt), 'annotation time')
  }
}

/** All references must resolve to stored data or to an explicit detached identity. */
export function referencedIds(data: ProjectData) {
  const refs = { books: new Set<string>(), editions: new Set<string>(), chapters: new Set<string>(), ideas: new Set<string>(),tasks: new Set<string>(), cards: new Set<string>() }
  const visit = (d: Pick<ProjectData, 'books' | 'editions' | 'chapters' | 'ideas'>) => {
    d.books.forEach((v) => { refs.books.add(v.id); if (v.workId) refs.books.add(v.workId) })
    d.editions.forEach((v) => { refs.books.add(v.bookId); refs.editions.add(v.id); if (v.originalId) refs.books.add(v.originalId); if (v.copiedFrom) refs.editions.add(v.copiedFrom); v.chapters.forEach((c) => refs.chapters.add(c.id)) })
    d.chapters.forEach((v) => { refs.books.add(v.bookId); refs.editions.add(v.editionId); refs.chapters.add(v.id) })
    d.ideas.forEach((v) => { refs.ideas.add(v.id); if (v.bookId) refs.books.add(v.bookId) })
  }
  visit(data)
  data.trash.forEach((v) => { refs.books.add(v.bookId); if (v.position) refs.editions.add(v.position.editionId); visit({ ...v, ideas: v.ideas ?? [] }) })
  data.revisions.forEach((v) => { refs.books.add(v.bookId); refs.editions.add(v.editionId); refs.chapters.add(v.chapterId) })
  data.ideaRevisions.forEach((v) => { refs.ideas.add(v.ideaId); if (v.bookId) refs.books.add(v.bookId) })
  data.aiBaselines.forEach((v) => { refs.books.add(v.bookId); refs.editions.add(v.editionId); refs.chapters.add(v.chapterId) })
  data.tasks.forEach(t=>{refs.tasks.add(t.id);if(t.link){refs.books.add(t.link.bookId);if(t.link.editionId)refs.editions.add(t.link.editionId);if(t.link.chapterId)refs.chapters.add(t.link.chapterId)}})
  data.taskCompletions.forEach(e=>e.cycle?.forEach(c=>refs.tasks.add(c.taskId)))
  for (const card of [...data.storyCards, ...data.trash.flatMap((entry) => entry.storyCards ?? [])]) {
    refs.cards.add(card.id)
    for (const relation of card.relations) refs.cards.add(relation.targetCardId)
    for (const chapter of [...card.chapters, ...card.states]) {
      refs.editions.add(chapter.editionId)
      refs.chapters.add(chapter.chapterId)
    }
  }
  return refs
}
export function detachedIds(data: ProjectData): Detached {
  const refs = referencedIds(data)
  const all = {
    books: [...data.books, ...data.trash.flatMap((v) => v.books)],
    editions: [...data.editions, ...data.trash.flatMap((v) => v.editions)],
    chapters: [...data.chapters, ...data.trash.flatMap((v) => v.chapters)],
    ideas: [...data.ideas, ...data.trash.flatMap((v) => v.ideas ?? [])],
    tasks: data.tasks,
    cards: [...data.storyCards, ...data.trash.flatMap((entry) => entry.storyCards ?? [])],
  }
  return Object.fromEntries(Object.entries(refs).map(([key, ids]) => {
    const stored = new Set(all[key as keyof Detached].map((v) => v.id))
    return [key, [...ids].filter((id) => !stored.has(id)).sort()]
  })) as unknown as Detached
}

export function validateData(data: ProjectData, root: ProjectRoot, detached: Detached, schemaVersion = projectSchemaVersion) {
  fields(data, projectStores.join(' '))
  safeJson(data)
  ok(lib(root.library) && uuid(root.id), 'root')
  let count = 0
  for (const key of projectStores) {
    ok(Array.isArray(data[key]), key)
    count += data[key].length
  }
  if (count > limits.records) throw new ProjectError('limit')
  const taskData=projectTaskData(data);validateTasks(taskData)
  if(schemaVersion<3)ok(!taskData.tasks.length&&!taskData.taskProjects.length&&!taskData.taskSections.length&&!taskData.taskLabels.length&&!taskData.taskCompletions.length&&!taskData.taskAttachments.length,'tasks require Schema 3')
  for(const task of data.tasks){ok(task.link&&!task.link.unconfirmed&&task.link.library===root.library&&task.link.bookId===root.id,'unrelated/unconfirmed task');const chapter=task.link.chapterId?[...data.chapters,...data.trash.flatMap(t=>t.chapters)].find(c=>c.id===task.link!.chapterId):undefined;if(chapter)ok(chapter.editionId===task.link.editionId,'task chapter relation')}
  const neededProjects=new Set(data.tasks.flatMap(t=>t.projectId?[t.projectId]:[]));for(let i=0;i<32;i++)for(const p of data.taskProjects)if(neededProjects.has(p.id)&&p.parentId)neededProjects.add(p.parentId)
  ok(data.taskProjects.every(p=>neededProjects.has(p.id))&&data.taskSections.every(s=>data.tasks.some(t=>t.sectionId===s.id))&&data.taskLabels.every(l=>data.tasks.some(t=>t.labelIds.includes(l.id))),'unrelated task organization')
  const rootBook = data.books.find((v) => v.id === root.id)
  ok(rootBook && rootBook.library === root.library && !rootBook.workId, 'root book')
  const belongs = (v: { library: string; bookId: string }) => v.library === root.library && v.bookId === root.id
  const books = [...data.books, ...data.trash.flatMap((v) => v.books)]
  const bookIds = new Set(books.map((b) => b.id))
  const belongsIdea = (v: { library?: string; bookId?: string }) => v.library === root.library && !!v.bookId && bookIds.has(v.bookId)
  for (const b of books) { validateBook(b, schemaVersion); ok(b.library === root.library && (b.id === root.id || b.workId === root.id), 'unrelated book') }
  const validateRows = (rows: Pick<ProjectData, 'books' | 'files' | 'editions' | 'chapters' | 'ideas'>, active: boolean) => {
    rows.files.forEach((v) => { fields(v, 'library id blob'); ok(v.library === root.library && id(v.id) && v.blob instanceof Blob && books.some((b) => b.id === v.id && b.format !== 'draft'), 'original file') })
    for (const b of rows.books) if (b.format !== 'draft') ok(rows.files.some((v) => v.id === b.id && v.blob.size === b.size), 'missing original')
    for (const e of rows.editions) {
      fields(e, 'library bookId id name source notes chapters createdAt revision', 'copiedFrom originalId')
      ok(belongs(e) && uuid(e.id) && title(e.name) && ['blank', 'original', 'copy'].includes(e.source) && num(e.createdAt) && num(e.revision), 'edition')
      ok(Array.isArray(e.notes) && e.notes.every(str) && Array.isArray(e.chapters) && e.chapters.length > 0 && e.chapters.length <= maxChapters, 'edition chapters')
      if (e.copiedFrom !== undefined) ok(id(e.copiedFrom), 'copy provenance')
      if (e.originalId !== undefined) ok(id(e.originalId), 'original provenance')
      ok(new Set(e.chapters.map((c) => c.id)).size === e.chapters.length, 'duplicate chapter order')
      for (const c of e.chapters) { fields(c, 'id title'); ok(id(c.id) && title(c.title) && rows.chapters.some((r) => r.editionId === e.id && r.id === c.id), 'missing chapter') }
    }
    for (const c of rows.chapters) {
      fields(c, 'library bookId editionId id content revision', 'readingAnnotations')
      ok(belongs(c) && uuid(c.id) && uuid(c.editionId) && num(c.revision), 'chapter')
      if (active) ok(rows.editions.some((e) => e.id === c.editionId && e.chapters.some((i) => i.id === c.id)), 'orphan chapter')
      validateDocument(c.content)
      if (c.readingAnnotations !== undefined) annotationsValid(c.readingAnnotations)
    }
    rows.ideas.forEach((v) => { validateIdea(v); ok(belongsIdea(v), 'unrelated idea') })
  }
  validateRows(data, true)
  if (schemaVersion < 4) ok(!data.storyCards.length, 'story cards require Schema 4')
  for (const v of data.trash) {
    fields(v, 'id kind library bookId title deletedAt books files editions chapters', 'ideas position' + (schemaVersion >= 4 ? ' storyCards' : ''))
    ok(uuid(v.id) && (belongs(v) || (v.kind === 'idea' && belongsIdea(v))) && (['original', 'edition', 'chapter', 'idea'].includes(v.kind) || (schemaVersion >= 4 && v.kind === 'storyCard')) && str(v.title) && num(v.deletedAt), 'trash ownership')
    for (const k of ['books', 'files', 'editions', 'chapters'] as const) ok(Array.isArray(v[k]), 'trash list')
    if (v.ideas !== undefined) ok(Array.isArray(v.ideas), 'trash ideas')
    if (v.position) { fields(v.position, 'editionId index'); ok(id(v.position.editionId) && num(v.position.index), 'trash position') }
    ok((v.kind === 'chapter' && v.chapters.length === 1 && !!v.position && !v.editions.length && !v.books.length && !v.files.length && !v.ideas?.length)
      || (v.kind === 'edition' && v.editions.length === 1 && !v.books.length && !v.files.length && !v.ideas?.length)
      || (v.kind === 'original' && v.books.length === 1 && v.files.length === 1 && !v.editions.length && !v.chapters.length && !v.ideas?.length)
      || (v.kind === 'idea' && v.ideas?.length === 1 && !v.books.length && !v.files.length && !v.editions.length && !v.chapters.length)
      || v.kind === 'storyCard', 'trash shape')
    if (v.position && v.kind === 'chapter') ok(v.position.editionId === v.chapters[0].editionId, 'trash chapter edition')
    validateRows({ ...v, ideas: v.ideas ?? [] }, false)
  }
  ok(validStoryRows(data.storyCards, data.books, data.chapters, data.trash), 'story cards')
  const unique = <T>(rows: T[], key: (v: T) => string) => ok(new Set(rows.map(key)).size === rows.length, 'duplicate record')
  unique(data.books, (v) => v.id); unique(data.files, (v) => v.id)
  unique(data.editions, (v) => v.id); unique(data.editions, (v) => v.name)
  unique(data.chapters, (v) => `${v.editionId}/${v.id}`)
  for (const key of ['ideas', 'revisions', 'ideaRevisions', 'trash'] as const) unique<{ id: string }>(data[key], (v) => v.id)
  unique(data.revisionBlobs, (v) => v.hash)
  unique(data.aiBaselines, (v) => `${v.clientId}/${v.editionId}/${v.chapterId}`)
  for (const v of data.revisions) {
    fields(v, 'id library bookId editionId chapterId chapterTitle words createdAt source action contentHash', 'editionName chapterRevision content plainText blobHash rawBytes storedBytes clientId clientName')
    revision(v)
    ok(belongs(v) && id(v.editionId) && id(v.chapterId) && title(v.chapterTitle) && num(v.words), 'chapter revision')
    if (v.editionName !== undefined) ok(title(v.editionName), 'historical edition name')
    if (v.chapterRevision !== undefined) ok(num(v.chapterRevision), 'historical revision number')
    if (v.plainText !== undefined) ok(str(v.plainText), 'revision text')
    for (const k of ['rawBytes', 'storedBytes'] as const) if (v[k] !== undefined) ok(num(v[k]) && v[k]! <= limits.entry, 'revision bytes')
    ok(v.content || (id(v.blobHash) && data.revisionBlobs.some((b) => b.hash === v.blobHash)), 'missing history payload')
    if (v.content) { validateDocument(v.content); ok(synchronousContentHash(JSON.stringify(v.content)) === v.contentHash, 'history content hash') }
  }
  const ideaIds = new Set([...data.ideas, ...data.trash.flatMap((v) => v.ideas ?? [])].map((v) => v.id))
  for (const v of data.ideaRevisions) {
    fields(v, 'id ideaId text ideaCreatedAt createdAt source action contentHash', 'library bookId usedAt clientId clientName')
    revision(v)
    ok(id(v.ideaId) && str(v.text) && v.text.length <= 20000 && num(v.ideaCreatedAt), 'idea revision')
    ok(ideaIds.has(v.ideaId) || belongsIdea(v), 'unrelated idea history')
    ok((v.library === undefined && v.bookId === undefined) || (lib(v.library) && id(v.bookId)), 'historical idea owner')
    if (v.usedAt !== undefined) ok(num(v.usedAt), 'historical usedAt')
    ok(synchronousContentHash(JSON.stringify({ text: v.text, library: v.library ?? null, bookId: v.bookId ?? null, usedAt: v.usedAt ?? null })) === v.contentHash, 'idea hash')
  }
  for (const v of data.aiBaselines) {
    fields(v, 'clientId library bookId editionId chapterId peakWords anchorWords anchorText updatedAt')
    ok(belongs(v) && id(v.clientId) && id(v.editionId) && id(v.chapterId) && num(v.peakWords) && num(v.anchorWords) && str(v.anchorText) && num(v.updatedAt), 'work safety baseline')
  }
  fields(detached, 'books editions chapters ideas tasks cards')
  const expected = detachedIds(data)
  for (const key of Object.keys(expected) as (keyof Detached)[]) {
    ok(Array.isArray(detached[key]) && detached[key].every(id) && new Set(detached[key]).size === detached[key].length
      && JSON.stringify([...detached[key]].sort()) === JSON.stringify(expected[key]), 'detached references')
  }
}

/** Bounded nested gzip decoding: ZIP limits alone do not protect history payloads. */
export async function validatePayloads(data: ProjectData) {
  await validateTaskAssets(projectTaskData(data))
  const books = [...data.books, ...data.trash.flatMap((v) => v.books)]
  for (const book of books) if (book.cover) {
    const bytes = new Uint8Array(await book.cover.slice(0, 32).arrayBuffer())
    const prefix = String.fromCharCode(...bytes)
    const mime = book.cover.type
    ok((mime === 'image/png' && prefix.startsWith('\x89PNG\r\n\x1a\n'))
      || (mime === 'image/jpeg' && prefix.startsWith('\xff\xd8\xff'))
      || (mime === 'image/gif' && /^GIF8[79]a/.test(prefix))
      || (mime === 'image/webp' && prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP')
      || (mime === 'image/bmp' && prefix.startsWith('BM'))
      || (mime === 'image/avif' && prefix.slice(4, 8) === 'ftyp' && /avif|avis/.test(prefix.slice(8))), 'cover signature')
  }
  for (const file of [...data.files, ...data.trash.flatMap((v) => v.files)]) {
    const owner = books.find((v) => v.id === file.id && v.format !== 'draft' && v.size === file.blob.size)
    ok(owner && owner.format !== 'draft' && await sha256(file.blob) === owner.digest, 'original SHA-256')
  }
  const used = new Set(data.revisions.filter((v) => !v.content).map((v) => v.blobHash))
  let rawTotal = 0
  for (const b of data.revisionBlobs) {
    fields(b, 'hash encoding data rawBytes storedBytes createdAt')
    ok(id(b.hash) && used.has(b.hash) && ['gzip', 'json'].includes(b.encoding) && b.data instanceof Uint8Array
      && num(b.rawBytes) && b.rawBytes <= limits.json && b.storedBytes === b.data.byteLength && num(b.createdAt), 'revision blob')
    const blob = new Blob([Uint8Array.from(b.data)])
    const stream = b.encoding === 'gzip' ? blob.stream().pipeThrough(new DecompressionStream('gzip')) : blob.stream()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength; rawTotal += value.byteLength
        if (size > b.rawBytes || rawTotal > limits.total) throw new ProjectError('limit')
        chunks.push(Uint8Array.from(value))
      }
    } finally { await reader.cancel().catch(() => {}) }
    ok(size === b.rawBytes, 'revision raw size')
    const json = new TextDecoder('utf-8', { fatal: true }).decode(await new Blob(chunks).arrayBuffer())
    ok(synchronousContentHash(json) === b.hash, 'revision payload hash')
    validateDocument(JSON.parse(json))
    for (const r of data.revisions.filter((v) => !v.content && v.blobHash === b.hash)) {
      ok(r.contentHash === b.hash && (r.rawBytes === undefined || r.rawBytes === b.rawBytes) && (r.storedBytes === undefined || r.storedBytes === b.storedBytes), 'history blob reference')
    }
  }
}
