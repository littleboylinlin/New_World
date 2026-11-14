import {
  changeChapters,
  chapterWordCounts,
  createEdition,
  createNovel,
  deleteEdition,
  listEditions,
  readBundle,
  readChapter,
  readChapterRecords,
  saveChapter,
} from '../documents/store'
import {
  applyAiChapterUpdate,
  applyAiEditionReplaceBatch,
  ConfirmStateConflictError,
  getAiBaseline,
  hashDocumentContent,
  listEditionAiBaselines,
  synchronousContentHash,
} from '../documents/revisions'
import { hasDirtyOpenChapter, syncOpenEditionFromExternal } from '../documents/editor-view'
import { chapterText, wordCount } from '../documents/model'
import type { ChapterInput, ChapterRecord, Edition } from '../documents/model'
import { convertFile } from '../documents/import'
import {
  deleteBook,
  importBook,
  libraryChanges,
  listBooks,
  maxTitleLength,
  readBook,
  removeWorkOriginal,
  renameBook,
  setArchived,
  storageError,
} from '../library'
import type { Book, ImportedBook, LibraryId } from '../library'
import { addIdea, applyAiIdeaUpdate, deleteIdea, listIdeas, maxIdeaLength } from '../ideas'
import type { Idea } from '../ideas'
import { openText } from '../text-preview'
import { currentStreak, readWritingDays } from '../writing-stats'
import {
  assessBatchEditionUpdate,
  assessChapterUpdate,
  commitChapterBaseline,
  formatChapterOutput,
  parseDocumentInput,
} from './guard'
import {
  canAssignIdeaWork,
  canCreateInsideWork,
  canCreateTopLevelWork,
  filterAuthorizedBooks,
  hasPermission,
  isIdeaInScope,
  isValidLibraryId,
  isWorkInScope,
} from './permissions'
import type {
  AiDispatchRequest,
  AiExecutionFailure,
  AiExecutionResult,
  PermissionKey,
} from './types'

function fail(
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  targetSummary?: string,
  auditReason?: string,
): AiExecutionFailure {
  return { ok: false, statusCode, code, message, details, targetSummary, auditReason }
}

function ok(data: unknown, statusCode = 200, targetSummary?: string, auditReason?: string): AiExecutionResult {
  return { ok: true, statusCode, data, targetSummary, auditReason }
}

function requiredPermissionForAction(action: string): PermissionKey | null {
  switch (action) {
    case 'libraries.list':
    case 'works.list':
    case 'works.get':
    case 'editions.list':
    case 'editions.get':
    case 'chapters.list':
    case 'chapters.get':
    case 'sources.get':
    case 'search':
    case 'stats.get':
    case 'ideas.list':
      return 'read'
    case 'works.create':
    case 'editions.create':
    case 'chapters.create':
    case 'sources.create':
    case 'ideas.create':
      return 'create'
    case 'works.update':
    case 'chapters.update':
    case 'chapters.reorder':
    case 'chapters.replaceBatch':
    case 'ideas.update':
      return 'update'
    case 'works.delete':
    case 'editions.delete':
    case 'chapters.delete':
    case 'sources.delete':
    case 'ideas.delete':
      return 'delete'
    default:
      return null
  }
}

function notifyLibraryUpdated() {
  libraryChanges.dispatchEvent(new Event('update'))
}

function cleanBookSummary(book: Book, allLibraryBooks?: readonly Book[]) {
  const base: Record<string, unknown> = {
    id: book.id,
    library: book.library,
    title: book.title,
    format: book.format,
    importedAt: book.importedAt,
    archived: Boolean(book.archivedAt),
    archivedAt: book.archivedAt ?? null,
    workId: book.workId ?? null,
  }
  if (book.format !== 'draft') {
    base.originalName = book.originalName
    base.size = book.size
  }
  if (!book.workId && allLibraryBooks) {
    const attached = allLibraryBooks.filter((item): item is ImportedBook => item.workId === book.id && item.format !== 'draft')
    base.sources = attached.map((src) => ({
      id: src.id,
      title: src.title,
      originalName: src.originalName,
      format: src.format,
      size: src.size,
      importedAt: src.importedAt,
    }))
  }
  return base
}

async function summarizeEditions(editions: Edition[]) {
  const summaries = []
  for (const edition of editions) {
    const counts = await chapterWordCounts(edition)
    const totalWords = Array.from(counts.values()).reduce((sum, n) => sum + n, 0)
    summaries.push({
      id: edition.id,
      name: edition.name,
      source: edition.source,
      originalId: edition.originalId ?? null,
      copiedFrom: edition.copiedFrom ?? null,
      revision: edition.revision,
      chapterCount: edition.chapters.length,
      totalWords,
    })
  }
  return summaries
}

async function loadWorkInScope(
  client: AiClientSummary,
  libraryRaw: unknown,
  bookIdRaw: unknown,
): Promise<{ ok: true; library: LibraryId; book: Book; isAttachedSource: boolean } | { ok: false; error: AiExecutionFailure }> {
  if (!isValidLibraryId(libraryRaw)) {
    return { ok: false, error: fail(400, 'invalid_library', 'Library must be "original" or "reference".') }
  }
  const bookId = typeof bookIdRaw === 'string' ? bookIdRaw.trim() : ''
  if (!bookId) {
    return { ok: false, error: fail(400, 'invalid_book_id', 'Book ID is required.') }
  }
  // In selected mode we only reveal/query top-level books explicitly listed in scope (never existence-probe unknown IDs).
  if (client.scope.mode === 'none') {
    return { ok: false, error: fail(403, 'forbidden_scope', 'Access to this work is outside the AI client scope.') }
  }
  if (client.scope.mode === 'selected' && !isWorkInScope(client, bookId)) {
    return { ok: false, error: fail(403, 'forbidden_scope', 'Access to this work is outside the AI client scope.') }
  }
  const found = await readBook(libraryRaw, bookId)
  if (!found) {
    return { ok: false, error: fail(404, 'work_not_found', 'Work not found.') }
  }
  const ownerId = found.book.workId || found.book.id
  if (!isWorkInScope(client, ownerId)) {
    return { ok: false, error: fail(403, 'forbidden_scope', 'Access to this work is outside the AI client scope.') }
  }
  return {
    ok: true,
    library: libraryRaw,
    book: found.book,
    isAttachedSource: Boolean(found.book.workId),
  }
}

async function editionChaptersSignature(edition: Edition) {
  const records = await readChapterRecords(edition)
  const byId = new Map<string, ChapterRecord>(records.map((rec) => [rec.id, rec]))
  let totalWords = 0
  const expectedChapters = edition.chapters.map((ch) => {
    const rec = byId.get(ch.id)
    if (rec) totalWords += wordCount(rec.content)
    return {
      id: ch.id,
      title: ch.title,
      revision: rec?.revision ?? 0,
      contentHash: rec ? hashDocumentContent(rec.content) : 'missing',
    }
  })
  return { totalWords, expectedChapters }
}

async function workImpactAndFingerprint(library: LibraryId, book: Book) {
  const editions = (await listEditions(library, book.id)).sort((a, b) => a.id.localeCompare(b.id))
  let totalChapters = 0
  let totalWords = 0
  const editionSummaries: Array<{
    id: string
    name: string
    revision: number
    chapters: Array<{ id: string; title: string; revision: number; contentHash: string }>
  }> = []
  for (const edition of editions) {
    totalChapters += edition.chapters.length
    const sig = await editionChaptersSignature(edition)
    totalWords += sig.totalWords
    editionSummaries.push({
      id: edition.id,
      name: edition.name,
      revision: edition.revision,
      chapters: sig.expectedChapters,
    })
  }
  const attachedSources = library === 'reference'
    ? (await listBooks('reference'))
      .filter((item): item is ImportedBook => item.workId === book.id && item.format !== 'draft')
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((src) => ({ id: src.id, title: src.title, originalName: src.originalName, size: src.size, digest: src.digest }))
    : []
  const stateHash = synchronousContentHash(JSON.stringify({
    library,
    id: book.id,
    title: book.title,
    archivedAt: book.archivedAt ?? 0,
    coverSize: book.cover?.size ?? 0,
    editions: editionSummaries,
    sources: attachedSources,
  }))
  return {
    editions,
    totalChapters,
    totalWords,
    fingerprint: `work:${library}:${book.id}:${stateHash}`,
  }
}

async function editionImpactAndFingerprint(library: LibraryId, bookId: string, edition: Edition) {
  const sig = await editionChaptersSignature(edition)
  const stateHash = synchronousContentHash(JSON.stringify({
    library,
    bookId,
    id: edition.id,
    name: edition.name,
    revision: edition.revision,
    chapters: sig.expectedChapters,
  }))
  return {
    totalWords: sig.totalWords,
    fingerprint: `edition:${library}:${bookId}:${edition.id}:${stateHash}`,
  }
}

function chapterTitleInEdition(edition: Edition, chapterId: string): string {
  return edition.chapters.find((c) => c.id === chapterId)?.title ?? chapterId
}

export async function executeAiDispatch(request: AiDispatchRequest): Promise<AiExecutionResult> {
  const { phase, client, action, params, query, body } = request

  if (!client || !client.enabled) {
    return fail(403, 'client_disabled', 'AI client is disabled.')
  }

  if (
    action === 'recovery_access_forbidden'
    || action.startsWith('trash.')
    || action.startsWith('revisions.')
    || action.startsWith('revisionBlobs')
    || action.startsWith('ideaRevisions')
    || action.startsWith('history.')
    || action.startsWith('backup')
  ) {
    return fail(
      403,
      'recovery_data_forbidden',
      'Trash, revision history, and backup recovery storage cannot be accessed by AI.',
      undefined,
      undefined,
      'recovery_data_forbidden',
    )
  }

  if (
    body?.skipHistory === true
    || body?.preserveHistory === false
    || query?.skipHistory === 'true'
    || query?.skipHistory === '1'
    || query?.preserveHistory === 'false'
    || query?.preserveHistory === '0'
  ) {
    return fail(
      403,
      'history_protection_non_bypassable',
      'Automatic pre-edit revision history protection cannot be skipped or disabled.',
      undefined,
      undefined,
      'history_protection_non_bypassable',
    )
  }

  const requiredPerm = requiredPermissionForAction(action)
  if (requiredPerm && !hasPermission(client, requiredPerm)) {
    return fail(403, 'permission_denied', `Missing required "${requiredPerm}" permission.`)
  }

  if (phase === 'execute-confirmed') {
    if (!hasPermission(client, 'delete')) {
      return fail(403, 'permission_denied', 'Delete permission is required.')
    }
    if (!request.confirmationId || !request.approvalGrant || !request.expectedFingerprint) {
      return fail(403, 'missing_human_confirmation', 'Confirmed execution requires a valid human approval grant.')
    }
  }

  try {
    switch (action) {
      case 'libraries.list': {
        const origTop = filterAuthorizedBooks(client, await listBooks('original')).filter((b) => !b.workId)
        const refTop = filterAuthorizedBooks(client, await listBooks('reference')).filter((b) => !b.workId)
        const countGroup = (items: Book[]) => ({
          total: items.length,
          active: items.filter((b) => !b.archivedAt).length,
          archived: items.filter((b) => Boolean(b.archivedAt)).length,
        })
        return ok({
          libraries: [
            { id: 'original', ...countGroup(origTop) },
            { id: 'reference', ...countGroup(refTop) },
          ],
          groups: {
            original: countGroup(origTop),
            reference: countGroup(refTop),
            archivedCount: [...origTop, ...refTop].filter((b) => Boolean(b.archivedAt)).length,
          },
        })
      }

      case 'works.list': {
        if (query.library && !isValidLibraryId(query.library)) {
          return fail(400, 'invalid_library', 'Library filter must be "original" or "reference".')
        }
        const libraries: LibraryId[] = query.library && isValidLibraryId(query.library)
          ? [query.library]
          : ['original', 'reference']
        const searchTerm = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
        const archivedFilter = query.archived

        const collected: Record<string, unknown>[] = []
        for (const lib of libraries) {
          const allInLib = filterAuthorizedBooks(client, await listBooks(lib))
          const topLevel = allInLib.filter((b) => !b.workId)
          for (const book of topLevel) {
            const isArchived = Boolean(book.archivedAt)
            if (archivedFilter === 'true' && !isArchived) continue
            if (archivedFilter === 'false' && isArchived) continue
            if (searchTerm && !book.title.toLowerCase().includes(searchTerm)) continue
            collected.push(cleanBookSummary(book, allInLib))
          }
        }
        return ok({ works: collected, total: collected.length })
      }

      case 'works.get': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        const allInLib = filterAuthorizedBooks(client, await listBooks(loaded.library))
        const editions = await summarizeEditions(await listEditions(loaded.library, loaded.book.id))
        return ok({
          work: cleanBookSummary(loaded.book, allInLib),
          editions,
        }, 200, `${loaded.library}:${loaded.book.title}`)
      }

      case 'works.create': {
        if (!canCreateTopLevelWork(client)) {
          return fail(403, 'create_scope_forbidden', 'Creating top-level works requires "create" permission with "all" library scope.')
        }
        const library = body.library
        if (!isValidLibraryId(library)) {
          return fail(400, 'invalid_library', 'Library must be "original" or "reference".')
        }
        const title = typeof body.title === 'string' ? body.title.trim() : typeof body.name === 'string' ? body.name.trim() : ''
        if (!title || title.length > maxTitleLength) {
          return fail(400, 'invalid_title', `Work title must be 1-${maxTitleLength} characters.`)
        }

        const created = await createNovel(library, title)
        let currentEdition = created.edition

        if (body.archived === true) {
          await setArchived(library, created.book.id, true)
        }

        if (Array.isArray(body.initialChapters) && body.initialChapters.length > 0) {
          const parsedChapters: { title: string; content: ReturnType<typeof parseDocumentInput> }[] = []
          for (const entry of body.initialChapters) {
            if (!entry || typeof entry !== 'object') {
              return fail(400, 'invalid_chapter_input', 'Each entry in initialChapters must be an object.')
            }
            const item = entry as Record<string, unknown>
            const chTitle = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : created.edition.chapters[0].title
            const content = item.content !== undefined ? parseDocumentInput(item.content, item.format) : parseDocumentInput('', 'text')
            parsedChapters.push({ title: chTitle, content })
          }
          const first = parsedChapters[0]
          if (first.title !== currentEdition.chapters[0].title) {
            const renamed = await changeChapters(currentEdition, { type: 'rename', id: currentEdition.chapters[0].id, title: first.title })
            currentEdition = renamed.edition
          }
          const firstRecord = await readChapter(currentEdition, currentEdition.chapters[0].id)
          await saveChapter(currentEdition, firstRecord, first.content)
          for (let i = 1; i < parsedChapters.length; i++) {
            const added = await changeChapters(currentEdition, { type: 'add', title: parsedChapters[i].title })
            currentEdition = added.edition
            const newRecord = await readChapter(currentEdition, added.selected)
            await saveChapter(currentEdition, newRecord, parsedChapters[i].content)
          }
        }

        if (library === 'reference' && typeof body.sourceText === 'string' && body.sourceText.trim()) {
          const sourceName = typeof body.sourceName === 'string' && body.sourceName.trim()
            ? body.sourceName.trim().slice(0, 120)
            : 'source.txt'
          const file = new File([body.sourceText], sourceName, { type: 'text/plain' })
          await importBook('reference', file, created.book.id)
        }

        const fresh = await readBook(library, created.book.id)
        const allInLib = await listBooks(library)
        const editions = await listEditions(library, created.book.id)
        notifyLibraryUpdated()
        return ok({
          work: cleanBookSummary(fresh?.book ?? created.book, allInLib),
          editions: await summarizeEditions(editions),
        }, 201, `${library}:${title}`)
      }

      case 'works.update': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        const hasName = typeof body.title === 'string' || typeof body.name === 'string'
        const hasArchived = typeof body.archived === 'boolean'
        if (!hasName && !hasArchived) {
          return fail(400, 'missing_update_fields', 'Provide "title" (or "name") and/or "archived".')
        }
        if (hasName) {
          const nextTitle = typeof body.title === 'string' ? body.title : String(body.name)
          await renameBook(loaded.library, loaded.book.id, nextTitle)
        }
        if (hasArchived) {
          await setArchived(loaded.library, loaded.book.id, body.archived as boolean)
        }
        const updated = await readBook(loaded.library, loaded.book.id)
        const allInLib = filterAuthorizedBooks(client, await listBooks(loaded.library))
        notifyLibraryUpdated()
        return ok({ work: updated ? cleanBookSummary(updated.book, allInLib) : null }, 200, `${loaded.library}:${loaded.book.id}`)
      }

      case 'works.delete': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        if (loaded.isAttachedSource) {
          return fail(400, 'use_sources_delete', 'Attached continuation sources must be removed via DELETE /sources/:sourceId.')
        }
        if (hasDirtyOpenChapter(loaded.library, loaded.book.id)) {
          return fail(409, 'editor_has_unsaved_changes', 'A chapter of this work has unsaved changes in the editor.')
        }
        const info = await workImpactAndFingerprint(loaded.library, loaded.book)
        if (phase === 'prepare-delete') {
          return {
            ok: false,
            requiresConfirmation: true,
            confirmedAction: 'works.delete',
            fingerprint: info.fingerprint,
            targetSummary: `${loaded.library}:${loaded.book.title}`,
            impact: {
              kind: 'work',
              library: loaded.library,
              bookId: loaded.book.id,
              bookTitle: loaded.book.title,
              affectedChapters: info.totalChapters,
              affectedWords: info.totalWords,
              summary: `${loaded.book.title} (${info.editions.length} edition(s), ${info.totalChapters} chapter(s), ${info.totalWords} words)`,
            },
          }
        }
        if (info.fingerprint !== request.expectedFingerprint) {
          return fail(409, 'stale_confirmation_target', 'The target work changed before confirmation completed; nothing was deleted.')
        }
        const entry = await deleteBook(loaded.library, loaded.book.id)
        notifyLibraryUpdated()
        return ok(
          { deleted: true, movedToTrash: true, library: loaded.library, bookId: loaded.book.id, title: loaded.book.title },
          200,
          `${loaded.library}:${loaded.book.title}`,
          `trashed:${entry.id}`,
        )
      }

      case 'editions.list': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        const editions = await summarizeEditions(await listEditions(loaded.library, loaded.book.id))
        return ok({ workId: loaded.book.id, library: loaded.library, editions })
      }

      case 'editions.get': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        const editions = await listEditions(loaded.library, loaded.book.id)
        const edition = editions.find((e) => e.id === params.editionId)
        if (!edition) return fail(404, 'edition_not_found', 'Edition not found.')
        const counts = await chapterWordCounts(edition)
        return ok({
          edition: {
            id: edition.id,
            name: edition.name,
            source: edition.source,
            originalId: edition.originalId ?? null,
            copiedFrom: edition.copiedFrom ?? null,
            revision: edition.revision,
            chapters: edition.chapters.map((ch, order) => ({
              id: ch.id,
              title: ch.title,
              order,
              words: counts.get(ch.id) ?? 0,
            })),
          },
        })
      }

      case 'editions.create': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        if (!canCreateInsideWork(client, loaded.book.id)) {
          return fail(403, 'forbidden_scope', 'Cannot create editions outside authorized work scope.')
        }
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined
        let inputs: ChapterInput[]
        let sourceOption: 'blank' | 'copy' = 'blank'
        let copiedFrom: string | undefined

        if (typeof body.copyFromEditionId === 'string' && body.copyFromEditionId.trim()) {
          const sameBookEditions = await listEditions(loaded.library, loaded.book.id)
          const sourceEdition = sameBookEditions.find((e) => e.id === body.copyFromEditionId)
          if (!sourceEdition) {
            return fail(404, 'source_edition_not_found', 'copyFromEditionId must refer to an edition inside the same work.')
          }
          const bundle = await readBundle(sourceEdition)
          inputs = bundle.chapters
          sourceOption = 'copy'
          copiedFrom = sourceEdition.name
        } else if (Array.isArray(body.chapters) && body.chapters.length > 0) {
          inputs = body.chapters.map((item) => {
            if (!item || typeof item !== 'object') throw new Error('Invalid chapter input item.')
            const obj = item as Record<string, unknown>
            const chTitle = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : 'Chapter 1'
            return {
              title: chTitle,
              content: obj.content !== undefined ? parseDocumentInput(obj.content, obj.format) : parseDocumentInput('', 'text'),
            }
          })
        } else {
          inputs = [{ title: 'Chapter 1', content: parseDocumentInput('', 'text') }]
        }

        const created = await createEdition(
          loaded.book,
          inputs,
          sourceOption === 'copy' ? { source: 'copy', copiedFrom } : { source: 'blank' },
          name,
        )
        notifyLibraryUpdated()
        return ok({ edition: created }, 201, `${loaded.library}:${loaded.book.id}:${created.id}`)
      }

      case 'editions.delete': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        const editions = await listEditions(loaded.library, loaded.book.id)
        const edition = editions.find((e) => e.id === params.editionId)
        if (!edition) return fail(404, 'edition_not_found', 'Edition not found.')
        if (hasDirtyOpenChapter(loaded.library, loaded.book.id, edition.id)) {
          return fail(409, 'editor_has_unsaved_changes', 'This edition currently has unsaved edits open.')
        }
        const info = await editionImpactAndFingerprint(loaded.library, loaded.book.id, edition)
        if (phase === 'prepare-delete') {
          return {
            ok: false,
            requiresConfirmation: true,
            confirmedAction: 'editions.delete',
            fingerprint: info.fingerprint,
            targetSummary: `${loaded.book.title} / ${edition.name}`,
            impact: {
              kind: 'edition',
              library: loaded.library,
              bookId: loaded.book.id,
              bookTitle: loaded.book.title,
              editionId: edition.id,
              editionTitle: edition.name,
              affectedChapters: edition.chapters.length,
              affectedWords: info.totalWords,
              summary: `${loaded.book.title} — ${edition.name} (${edition.chapters.length} chapter(s), ${info.totalWords} words)`,
            },
          }
        }
        if (info.fingerprint !== request.expectedFingerprint) {
          return fail(409, 'stale_confirmation_target', 'Edition changed before confirmation completed.')
        }
        const entry = await deleteEdition(edition)
        notifyLibraryUpdated()
        await syncOpenEditionFromExternal(loaded.library, loaded.book.id, edition.id)
        return ok({ deleted: true, movedToTrash: true, editionId: edition.id }, 200, `${loaded.book.title} / ${edition.name}`, `trashed:${entry.id}`)
      }

      case 'chapters.list': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        const editions = await listEditions(loaded.library, loaded.book.id)
        const edition = editions.find((e) => e.id === params.editionId)
        if (!edition) return fail(404, 'edition_not_found', 'Edition not found.')
        const counts = await chapterWordCounts(edition)
        const offset = Math.max(0, Number.parseInt(query.offset || '0', 10) || 0)
        const limit = Math.max(1, Math.min(2000, Number.parseInt(query.limit || '2000', 10) || 2000))
        const mapped = edition.chapters.map((ch, order) => ({
          id: ch.id,
          title: ch.title,
          order,
          words: counts.get(ch.id) ?? 0,
        }))
        const totalWords = mapped.reduce((sum, ch) => sum + ch.words, 0)
        return ok({
          editionId: edition.id,
          editionName: edition.name,
          revision: edition.revision,
          totalChapters: mapped.length,
          totalWords,
          chapters: mapped.slice(offset, offset + limit),
        })
      }

      case 'chapters.get': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        const editions = await listEditions(loaded.library, loaded.book.id)
        const edition = editions.find((e) => e.id === params.editionId)
        if (!edition) return fail(404, 'edition_not_found', 'Edition not found.')
        const order = edition.chapters.findIndex((c) => c.id === params.chapterId)
        if (order < 0) return fail(404, 'chapter_not_found', 'Chapter not found in this edition.')
        const record = await readChapter(edition, params.chapterId)
        const title = edition.chapters[order].title
        return ok({
          workId: loaded.book.id,
          library: loaded.library,
          editionId: edition.id,
          order,
          chapter: formatChapterOutput(record, title, query.format),
        })
      }

      case 'chapters.create': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        if (!canCreateInsideWork(client, loaded.book.id)) {
          return fail(403, 'forbidden_scope', 'Cannot create chapters outside authorized work scope.')
        }
        const editions = await listEditions(loaded.library, loaded.book.id)
        let edition = editions.find((e) => e.id === params.editionId)
        if (!edition) return fail(404, 'edition_not_found', 'Edition not found.')
        if (hasDirtyOpenChapter(loaded.library, loaded.book.id, edition.id)) {
          return fail(409, 'editor_has_unsaved_changes', 'Current edition has unsaved changes in the editor.')
        }
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : ''
        if (!title) return fail(400, 'invalid_title', 'Chapter title is required.')
        const added = await changeChapters(edition, { type: 'add', title })
        edition = added.edition
        const createdId = added.selected

        if (body.content !== undefined) {
          const parsedDoc = parseDocumentInput(body.content, body.format)
          const createdRecord = await readChapter(edition, createdId)
          await saveChapter(edition, createdRecord, parsedDoc)
        }

        if (typeof body.insertAfterId === 'string' && body.insertAfterId !== createdId) {
          const ids = edition.chapters.map((c) => c.id).filter((id) => id !== createdId)
          const targetIdx = ids.indexOf(body.insertAfterId)
          if (targetIdx < 0) return fail(400, 'invalid_insert_after_id', 'insertAfterId does not exist in this edition.')
          ids.splice(targetIdx + 1, 0, createdId)
          const reordered = await changeChapters(edition, { type: 'reorder', order: ids })
          edition = reordered.edition
        } else if (typeof body.position === 'number' && Number.isInteger(body.position)) {
          const ids = edition.chapters.map((c) => c.id).filter((id) => id !== createdId)
          const clamped = Math.max(0, Math.min(ids.length, body.position))
          ids.splice(clamped, 0, createdId)
          const reordered = await changeChapters(edition, { type: 'reorder', order: ids })
          edition = reordered.edition
        }

        const finalRecord = await readChapter(edition, createdId)
        const finalTitle = chapterTitleInEdition(edition, createdId)
        notifyLibraryUpdated()
        await syncOpenEditionFromExternal(loaded.library, loaded.book.id, edition.id)
        return ok({
          editionRevision: edition.revision,
          chapter: formatChapterOutput(finalRecord, finalTitle, query.format),
        }, 201, `${loaded.book.title} / ${finalTitle}`)
      }

      case 'chapters.update': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        const editions = await listEditions(loaded.library, loaded.book.id)
        let edition = editions.find((e) => e.id === params.editionId)
        if (!edition) return fail(404, 'edition_not_found', 'Edition not found.')
        const info = edition.chapters.find((c) => c.id === params.chapterId)
        if (!info) return fail(404, 'chapter_not_found', 'Chapter not found.')

        if (hasDirtyOpenChapter(loaded.library, loaded.book.id, edition.id, params.chapterId)) {
          return fail(409, 'chapter_dirty_in_editor', 'User is actively editing unsaved changes in this chapter.')
        }

        const hasTitle = typeof body.title === 'string' && body.title.trim().length > 0
        const hasContent = body.content !== undefined
        if (!hasTitle && !hasContent) {
          return fail(400, 'missing_update_fields', 'Provide "title" and/or "content".')
        }

        const current = await readChapter(edition, params.chapterId)
        const nextTitle = hasTitle ? String(body.title).trim() : info.title
        const nextContent = hasContent ? parseDocumentInput(body.content, body.format) : current.content
        const persistedBaseline = await getAiBaseline(client.id, edition, current.id)
        const assessment = assessChapterUpdate(
          client.id,
          loaded.library,
          loaded.book.id,
          edition.id,
          current,
          nextContent,
          persistedBaseline,
        )
        const retentionPct = Math.round((assessment.retention ?? 1) * 100)
        const currentHash = hashDocumentContent(current.content)
        const nextHash = hashDocumentContent(nextContent)
        const updateHash = synchronousContentHash(JSON.stringify({
          library: loaded.library,
          bookId: loaded.book.id,
          editionId: edition.id,
          chapterId: current.id,
          editionRevision: edition.revision,
          chapterRevision: current.revision,
          currentTitle: info.title,
          currentHash,
          nextTitle,
          nextHash,
          beforeWords: assessment.beforeWords,
          afterWords: assessment.afterWords,
          retentionPct,
        }))
        const fingerprint = `chapter-update:${loaded.library}:${loaded.book.id}:${edition.id}:${current.id}:${updateHash}`

        if (phase === 'execute') {
          if (assessment.destructive) {
            if (!hasPermission(client, 'delete')) {
              return fail(
                403,
                'destructive_update_forbidden',
                'Destructive content reduction, wholesale rewrite, or clearing is blocked without delete permission.',
                {
                  reason: assessment.reason,
                  beforeWords: assessment.beforeWords,
                  afterWords: assessment.afterWords,
                  lostWords: assessment.lostWords,
                  retention: assessment.retention,
                },
                `${loaded.book.title} / ${info.title}`,
              )
            }
            const replacedPct = Math.max(0, 100 - retentionPct)
            const reasonDetail = assessment.reason.includes('replacement')
              ? `${assessment.reason}, ~${replacedPct}% replaced`
              : assessment.reason
            return {
              ok: false,
              requiresConfirmation: true,
              confirmedAction: 'chapters.update',
              fingerprint,
              targetSummary: `${loaded.book.title} / ${info.title}`,
              impact: {
                kind: 'destructive_update',
                library: loaded.library,
                bookId: loaded.book.id,
                bookTitle: loaded.book.title,
                editionId: edition.id,
                editionTitle: edition.name,
                chapterId: current.id,
                chapterTitle: info.title,
                beforeWords: assessment.beforeWords,
                afterWords: assessment.afterWords,
                lostWords: assessment.lostWords,
                summary: `${loaded.book.title} / ${info.title}: ${assessment.beforeWords} -> ${assessment.afterWords} words (${reasonDetail})`,
              },
            }
          }
        } else if (phase === 'execute-confirmed') {
          if (fingerprint !== request.expectedFingerprint) {
            return fail(409, 'stale_confirmation_target', 'Chapter changed before confirmation completed; update aborted.')
          }
        }

        const applied = await applyAiChapterUpdate({
          edition,
          chapterId: current.id,
          clientId: client.id,
          clientName: client.name,
          nextTitle: hasTitle ? nextTitle : undefined,
          nextContent: hasContent ? nextContent : undefined,
          action: 'chapters.update',
          resetBaseline: phase === 'execute-confirmed',
          expected: phase === 'execute-confirmed'
            ? {
                editionRevision: edition.revision,
                id: current.id,
                title: info.title,
                revision: current.revision,
                contentHash: currentHash,
              }
            : undefined,
        })
        edition = applied.edition
        commitChapterBaseline(
          client.id,
          loaded.library,
          loaded.book.id,
          edition.id,
          current.id,
          assessment.baselineWords,
          assessment.afterWords,
          phase === 'execute-confirmed',
        )
        const updatedRecord = applied.chapter
        const updatedTitle = chapterTitleInEdition(edition, current.id)
        notifyLibraryUpdated()
        await syncOpenEditionFromExternal(loaded.library, loaded.book.id, edition.id)
        return ok({
          editionRevision: edition.revision,
          snapshotSaved: true,
          snapshotId: applied.snapshot.id,
          chapter: formatChapterOutput(updatedRecord, updatedTitle, query.format),
        }, 200, `${loaded.book.title} / ${updatedTitle}`, `snapshot:${applied.snapshot.id}`)
      }

      case 'chapters.replaceBatch': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        const editions = await listEditions(loaded.library, loaded.book.id)
        let edition = editions.find((e) => e.id === params.editionId)
        if (!edition) return fail(404, 'edition_not_found', 'Edition not found.')
        if (hasDirtyOpenChapter(loaded.library, loaded.book.id, edition.id)) {
          return fail(409, 'editor_has_unsaved_changes', 'Current edition has unsaved changes in the editor.')
        }
        if (!Array.isArray(body.chapters)) {
          return fail(400, 'invalid_batch_payload', 'Expected "chapters" array.')
        }

        const sig = await editionChaptersSignature(edition)
        const existingInputs = await readBundle(edition)
        const parsedIncoming = body.chapters.map((entry) => {
          if (!entry || typeof entry !== 'object') throw new Error('Each chapter entry must be an object.')
          const obj = entry as Record<string, unknown>
          const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : 'Chapter'
          const content = obj.content !== undefined ? parseDocumentInput(obj.content, obj.format) : parseDocumentInput('', 'text')
          return {
            id: typeof obj.id === 'string' ? obj.id : undefined,
            title,
            content,
          }
        })

        const persistedBaselines = await listEditionAiBaselines(client.id, edition)
        const batchCheck = assessBatchEditionUpdate(edition.chapters, existingInputs.chapters, parsedIncoming, persistedBaselines)
        const retentionPct = Math.round((batchCheck.retention ?? 1) * 100)
        const batchHash = synchronousContentHash(JSON.stringify({
          library: loaded.library,
          bookId: loaded.book.id,
          editionId: edition.id,
          editionRevision: edition.revision,
          existingChapters: sig.expectedChapters,
          incoming: parsedIncoming.map((item) => ({
            id: item.id ?? '',
            title: item.title,
            contentHash: hashDocumentContent(item.content),
          })),
          beforeWords: batchCheck.beforeWords,
          afterWords: batchCheck.afterWords,
          retentionPct,
        }))
        const fingerprint = `batch:${loaded.library}:${loaded.book.id}:${edition.id}:${batchHash}`

        if (phase === 'execute') {
          if (batchCheck.destructive) {
            if (!hasPermission(client, 'delete')) {
              return fail(
                403,
                'destructive_update_forbidden',
                'Batch update that drops chapters, wholesale-rewrites chapters, or massively reduces content is blocked without delete permission.',
                { ...batchCheck },
                `${loaded.book.title} / ${edition.name}`,
              )
            }
            return {
              ok: false,
              requiresConfirmation: true,
              confirmedAction: 'chapters.replaceBatch',
              fingerprint,
              targetSummary: `${loaded.book.title} / ${edition.name}`,
              impact: {
                kind: 'destructive_update',
                library: loaded.library,
                bookId: loaded.book.id,
                bookTitle: loaded.book.title,
                editionId: edition.id,
                editionTitle: edition.name,
                affectedChapters: batchCheck.removedChapters || edition.chapters.length,
                beforeWords: batchCheck.beforeWords,
                afterWords: batchCheck.afterWords,
                lostWords: batchCheck.lostWords,
                summary: `${loaded.book.title} / ${edition.name}: ${batchCheck.reason} (removed ${batchCheck.removedChapters} chapter(s), ${batchCheck.beforeWords} -> ${batchCheck.afterWords} words)`,
              },
            }
          }
        } else if (phase === 'execute-confirmed') {
          if (fingerprint !== request.expectedFingerprint) {
            return fail(409, 'stale_confirmation_target', 'Edition changed before confirmation completed.')
          }
        }

        const applied = await applyAiEditionReplaceBatch({
          edition,
          clientId: client.id,
          clientName: client.name,
          chapters: parsedIncoming,
          resetBaseline: phase === 'execute-confirmed',
          expected: phase === 'execute-confirmed'
            ? {
                editionRevision: edition.revision,
                chapters: sig.expectedChapters,
              }
            : undefined,
        })
        edition = applied.edition
        for (const ch of applied.chapters) {
          const words = wordCount(ch.content)
          commitChapterBaseline(client.id, loaded.library, loaded.book.id, edition.id, ch.id, words, words, phase === 'execute-confirmed')
        }
        notifyLibraryUpdated()
        await syncOpenEditionFromExternal(loaded.library, loaded.book.id, edition.id)
        const reasonParts = [`snapshots:${applied.snapshots.length}`]
        if (applied.trashed.length) reasonParts.push(`trashed:${applied.trashed.length}`)
        return ok(
          {
            editionRevision: edition.revision,
            chapterCount: edition.chapters.length,
            snapshotCount: applied.snapshots.length,
            trashedCount: applied.trashed.length,
          },
          200,
          `${loaded.book.title} / ${edition.name}`,
          reasonParts.join(';'),
        )
      }

      case 'chapters.reorder': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        const editions = await listEditions(loaded.library, loaded.book.id)
        const edition = editions.find((e) => e.id === params.editionId)
        if (!edition) return fail(404, 'edition_not_found', 'Edition not found.')
        if (hasDirtyOpenChapter(loaded.library, loaded.book.id, edition.id)) {
          return fail(409, 'editor_has_unsaved_changes', 'Current edition has unsaved changes in the editor.')
        }

        let updatedEdition: Edition
        if (Array.isArray(body.chapterIds)) {
          const order = body.chapterIds.map((id) => String(id))
          if (order.length !== edition.chapters.length) {
            return fail(400, 'invalid_chapter_reorder', 'chapterIds must include every existing chapter ID in this edition.')
          }
          const existingSet = new Set(edition.chapters.map((c) => c.id))
          const incomingSet = new Set(order)
          if (incomingSet.size !== existingSet.size || !order.every((id) => existingSet.has(id))) {
            return fail(400, 'invalid_chapter_reorder', 'chapterIds must be an exact permutation of existing chapters.')
          }
          const result = await changeChapters(edition, { type: 'reorder', order })
          updatedEdition = result.edition
        } else if (typeof body.chapterId === 'string' && (body.offset === -1 || body.offset === 1)) {
          const result = await changeChapters(edition, { type: 'move', id: body.chapterId, offset: body.offset })
          updatedEdition = result.edition
        } else {
          return fail(400, 'invalid_chapter_reorder', 'Provide { chapterIds: string[] } or { chapterId: string, offset: -1 | 1 }.')
        }

        notifyLibraryUpdated()
        await syncOpenEditionFromExternal(loaded.library, loaded.book.id, updatedEdition.id)
        return ok({
          editionId: updatedEdition.id,
          revision: updatedEdition.revision,
          chapters: updatedEdition.chapters.map((c, order) => ({ id: c.id, title: c.title, order })),
        }, 200, `${loaded.book.title} / ${updatedEdition.name}`)
      }

      case 'chapters.delete': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        const editions = await listEditions(loaded.library, loaded.book.id)
        const edition = editions.find((e) => e.id === params.editionId)
        if (!edition) return fail(404, 'edition_not_found', 'Edition not found.')
        const infoEntry = edition.chapters.find((c) => c.id === params.chapterId)
        if (!infoEntry) return fail(404, 'chapter_not_found', 'Chapter not found.')
        if (hasDirtyOpenChapter(loaded.library, loaded.book.id, edition.id, params.chapterId)) {
          return fail(409, 'chapter_dirty_in_editor', 'User has unsaved edits in this chapter.')
        }
        const record = await readChapter(edition, params.chapterId)
        const chapterIndex = edition.chapters.findIndex((c) => c.id === params.chapterId)
        const words = wordCount(record.content)
        const chHash = synchronousContentHash(JSON.stringify({
          index: chapterIndex,
          title: infoEntry.title,
          editionRevision: edition.revision,
          chapterRevision: record.revision,
          contentHash: hashDocumentContent(record.content),
        }))
        const fingerprint = `chapter-delete:${loaded.library}:${loaded.book.id}:${edition.id}:${record.id}:${chHash}`
        if (phase === 'prepare-delete') {
          return {
            ok: false,
            requiresConfirmation: true,
            confirmedAction: 'chapters.delete',
            fingerprint,
            targetSummary: `${loaded.book.title} / ${infoEntry.title}`,
            impact: {
              kind: 'chapter',
              library: loaded.library,
              bookId: loaded.book.id,
              bookTitle: loaded.book.title,
              editionId: edition.id,
              editionTitle: edition.name,
              chapterId: record.id,
              chapterTitle: infoEntry.title,
              affectedChapters: 1,
              affectedWords: words,
              summary: `${loaded.book.title} — ${edition.name} / ${infoEntry.title} (${words} words)`,
            },
          }
        }
        if (fingerprint !== request.expectedFingerprint) {
          return fail(409, 'stale_confirmation_target', 'Chapter changed before confirmation completed.')
        }
        const deleted = await changeChapters(edition, { type: 'delete', id: params.chapterId })
        notifyLibraryUpdated()
        await syncOpenEditionFromExternal(loaded.library, loaded.book.id, deleted.edition.id)
        return ok(
          { deleted: true, movedToTrash: Boolean(deleted.trashed), chapterId: params.chapterId, editionRevision: deleted.edition.revision },
          200,
          `${loaded.book.title} / ${infoEntry.title}`,
          deleted.trashed ? `trashed:${deleted.trashed.id}` : undefined,
        )
      }

      case 'sources.create': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        if (loaded.library !== 'reference' || loaded.isAttachedSource) {
          return fail(400, 'sources_require_reference_work', 'Sources can only be attached to reference continuation works.')
        }
        if (!canCreateInsideWork(client, loaded.book.id)) {
          return fail(403, 'forbidden_scope', 'Cannot import sources outside authorized scope.')
        }
        const content = typeof body.content === 'string' ? body.content : ''
        if (!content.trim()) {
          return fail(400, 'missing_source_content', 'Source text content is required.')
        }
        const fileName = typeof body.fileName === 'string' && body.fileName.trim() ? body.fileName.trim().slice(0, 120) : 'source.txt'
        const mimeType = fileName.endsWith('.md') ? 'text/markdown' : 'text/plain'
        const file = new File([content], fileName, { type: mimeType })
        const imported = await importBook('reference', file, loaded.book.id)
        notifyLibraryUpdated()
        return ok({ source: cleanBookSummary(imported.book), duplicate: imported.duplicate }, 201, `${loaded.book.title} / ${fileName}`)
      }

      case 'sources.get': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        if (loaded.isAttachedSource) {
          return fail(400, 'invalid_parent_work', 'Use the parent work ID when reading an attached source.')
        }
        const origRes = await readBook(loaded.library, params.sourceId)
        const isOwnedSource = loaded.library === 'reference' && origRes?.book.workId === loaded.book.id
        const isSelfFile = params.sourceId === loaded.book.id && !origRes?.book.workId && loaded.book.format !== 'draft'
        if (!origRes || !origRes.blob || (!isOwnedSource && !isSelfFile)) {
          return fail(404, 'source_not_found', 'Source not found on this work.')
        }
        const origBook = origRes.book
        let text = ''
        if (origBook.format === 'txt' || origBook.format === 'md' || origBook.format === 'html') {
          const decoded = await openText(origRes.blob, origBook.format === 'html')
          text = decoded.text
        } else {
          const controller = new AbortController()
          const converted = await convertFile(origBook.format, origRes.blob, controller.signal)
          text = converted.chapters.map((ch) => `# ${ch.title}\n\n${chapterText(ch.content, '\n')}`).join('\n\n')
        }
        return ok({
          source: {
            id: origBook.id,
            title: origBook.title,
            format: origBook.format,
            originalName: origBook.originalName,
            text,
          },
        })
      }

      case 'sources.delete': {
        const loaded = await loadWorkInScope(client, params.library, params.bookId)
        if (!loaded.ok) return loaded.error
        if (loaded.library !== 'reference' || loaded.isAttachedSource) {
          return fail(400, 'sources_require_reference_work', 'Sources only belong to reference continuation works.')
        }
        const origRes = await readBook('reference', params.sourceId)
        if (!origRes || origRes.book.workId !== loaded.book.id) {
          return fail(404, 'source_not_found', 'Source not found on this continuation project.')
        }
        const src = origRes.book
        const srcHash = synchronousContentHash(JSON.stringify({
          id: src.id,
          workId: src.workId ?? '',
          title: src.title,
          originalName: src.format === 'draft' ? '' : src.originalName,
          size: src.format === 'draft' ? 0 : src.size,
          digest: src.format === 'draft' ? '' : src.digest,
          importedAt: src.importedAt,
        }))
        const fingerprint = `source-delete:${loaded.book.id}:${src.id}:${srcHash}`
        if (phase === 'prepare-delete') {
          return {
            ok: false,
            requiresConfirmation: true,
            confirmedAction: 'sources.delete',
            fingerprint,
            targetSummary: `${loaded.book.title} / ${origRes.book.title}`,
            impact: {
              kind: 'source',
              library: 'reference',
              bookId: loaded.book.id,
              bookTitle: loaded.book.title,
              sourceId: origRes.book.id,
              sourceName: origRes.book.title,
              summary: `${loaded.book.title} — Source "${origRes.book.title}"`,
            },
          }
        }
        if (fingerprint !== request.expectedFingerprint) {
          return fail(409, 'stale_confirmation_target', 'Work changed before confirmation completed.')
        }
        const entry = await removeWorkOriginal(loaded.book.id, params.sourceId)
        notifyLibraryUpdated()
        return ok({ deleted: true, movedToTrash: true, bookId: loaded.book.id, sourceId: params.sourceId }, 200, `${loaded.book.title} / ${origRes.book.title}`, `trashed:${entry.id}`)
      }

      case 'search': {
        if (client.scope.mode === 'none') {
          return fail(403, 'forbidden_scope', 'Search is denied when AI access scope is "none".')
        }
        const q = (query.q || '').trim().toLowerCase()
        if (!q) return fail(400, 'missing_search_query', 'Query parameter "q" is required.')
        if (query.library && !isValidLibraryId(query.library)) {
          return fail(400, 'invalid_library', 'Library must be "original" or "reference".')
        }
        if (query.bookId && !isWorkInScope(client, query.bookId)) {
          return fail(403, 'forbidden_scope', 'Requested bookId is outside AI client scope.')
        }
        const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit || '30', 10) || 30))
        const libs: LibraryId[] = query.library && isValidLibraryId(query.library)
          ? [query.library]
          : ['original', 'reference']
        const results: Record<string, unknown>[] = []

        for (const lib of libs) {
          const books = filterAuthorizedBooks(client, await listBooks(lib)).filter((b) => !b.workId)
          for (const book of books) {
            if (query.bookId && book.id !== query.bookId) continue
            if (book.title.toLowerCase().includes(q)) {
              results.push({ type: 'work', library: lib, bookId: book.id, title: book.title })
              if (results.length >= limit) break
            }
            const editions = await listEditions(lib, book.id)
            for (const edition of editions) {
              const bundle = await readBundle(edition)
              for (let idx = 0; idx < bundle.chapters.length; idx++) {
                const ch = bundle.chapters[idx]
                const chInfo = edition.chapters[idx]
                const text = chapterText(ch.content, '\n')
                const titleHit = ch.title.toLowerCase().includes(q)
                const bodyIndex = text.toLowerCase().indexOf(q)
                if (titleHit || bodyIndex >= 0) {
                  const start = Math.max(0, bodyIndex - 40)
                  const snippet = bodyIndex >= 0 ? text.slice(start, bodyIndex + q.length + 60) : text.slice(0, 100)
                  results.push({
                    type: 'chapter',
                    library: lib,
                    bookId: book.id,
                    bookTitle: book.title,
                    editionId: edition.id,
                    editionName: edition.name,
                    chapterId: chInfo?.id ?? '',
                    chapterTitle: ch.title,
                    snippet,
                  })
                  if (results.length >= limit) break
                }
              }
              if (results.length >= limit) break
            }
            if (results.length >= limit) break
          }
          if (results.length >= limit) break
        }

        if (results.length < limit && !query.bookId && !query.library) {
          const ideas = (await listIdeas()).filter((idea) => isIdeaInScope(client, idea))
          for (const idea of ideas) {
            if (idea.text.toLowerCase().includes(q)) {
              results.push({
                type: 'idea',
                ideaId: idea.id,
                library: idea.library ?? null,
                bookId: idea.bookId ?? null,
                snippet: idea.text.slice(0, 140),
              })
              if (results.length >= limit) break
            }
          }
        }
        return ok({ query: query.q, results })
      }

      case 'stats.get': {
        const libs: LibraryId[] = ['original', 'reference']
        let works = 0
        let editionsCount = 0
        let chaptersCount = 0
        let wordsCount = 0
        for (const lib of libs) {
          const authorized = filterAuthorizedBooks(client, await listBooks(lib)).filter((b) => !b.workId)
          for (const book of authorized) {
            works++
            const editions = await listEditions(lib, book.id)
            for (const ed of editions) {
              editionsCount++
              chaptersCount += ed.chapters.length
              const counts = await chapterWordCounts(ed)
              for (const n of counts.values()) wordsCount += n
            }
          }
        }
        const payload: Record<string, unknown> = {
          authorizedWorks: works,
          authorizedEditions: editionsCount,
          authorizedChapters: chaptersCount,
          authorizedWords: wordsCount,
        }
        if (client.scope.mode === 'all') {
          const days = await readWritingDays()
          payload.streak = currentStreak(days)
        }
        return ok(payload)
      }

      case 'ideas.list': {
        if (client.scope.mode === 'none') {
          return fail(403, 'forbidden_scope', 'Ideas cannot be read when AI scope is "none".')
        }
        const allIdeas = await listIdeas()
        const visible = allIdeas.filter((idea) => isIdeaInScope(client, idea))
        return ok({ ideas: visible })
      }

      case 'ideas.create': {
        const text = typeof body.text === 'string' ? body.text : ''
        if (!text.trim() || text.length > maxIdeaLength) {
          return fail(400, 'invalid_idea_text', `Idea text must be 1-${maxIdeaLength} characters.`)
        }
        const work = body.work && typeof body.work === 'object' ? (body.work as { library?: unknown; bookId?: unknown }) : undefined
        let linkedWork: { library: LibraryId; bookId: string } | undefined
        if (work) {
          if (!isValidLibraryId(work.library) || typeof work.bookId !== 'string' || !work.bookId.trim()) {
            return fail(400, 'invalid_idea_work', 'Idea work link requires valid library and bookId.')
          }
          const loaded = await loadWorkInScope(client, work.library, work.bookId)
          if (!loaded.ok) return loaded.error
          linkedWork = { library: loaded.library, bookId: loaded.book.id }
        }
        if (!canAssignIdeaWork(client, linkedWork)) {
          return fail(403, 'forbidden_scope', 'Ideas created under selected scope must link to an authorized work.')
        }
        const created = await addIdea(text, linkedWork)
        return ok({ idea: created }, 201, created.id)
      }

      case 'ideas.update': {
        const ideas = await listIdeas()
        const existing = ideas.find((i) => i.id === params.ideaId)
        if (!existing) {
          if (client.scope.mode !== 'all') return fail(403, 'forbidden_scope', 'Idea is outside scope or unavailable.')
          return fail(404, 'idea_not_found', 'Idea not found.')
        }
        if (!isIdeaInScope(client, existing)) {
          return fail(403, 'forbidden_scope', 'Idea is outside AI client scope.')
        }
        const hasText = typeof body.text === 'string'
        const hasWork = body.work !== undefined
        const hasUsed = typeof body.used === 'boolean'
        if (!hasText && !hasWork && !hasUsed) {
          return fail(400, 'missing_update_fields', 'Provide "text", "work", and/or "used".')
        }

        let nextWork: { library: LibraryId; bookId: string } | null | undefined
        if (hasText || hasWork) {
          let nextLib = existing.library
          let nextBookId = existing.bookId
          if (body.work === null) {
            nextLib = undefined
            nextBookId = undefined
            nextWork = null
          } else if (body.work && typeof body.work === 'object') {
            const raw = body.work as { library?: unknown; bookId?: unknown }
            if (!isValidLibraryId(raw.library) || typeof raw.bookId !== 'string') {
              return fail(400, 'invalid_idea_work', 'Idea work requires library and bookId.')
            }
            const loaded = await loadWorkInScope(client, raw.library, raw.bookId)
            if (!loaded.ok) return loaded.error
            nextLib = loaded.library
            nextBookId = loaded.book.id
            nextWork = { library: loaded.library, bookId: loaded.book.id }
          }
          const linked = nextLib && nextBookId ? { library: nextLib, bookId: nextBookId } : undefined
          if (!canAssignIdeaWork(client, linked)) {
            return fail(403, 'forbidden_scope', 'Cannot unlink or reassign idea outside authorized scope.')
          }
        }
        if (hasText) {
          const clean = String(body.text).trim()
          if (!clean || clean.length > maxIdeaLength) {
            return fail(400, 'invalid_idea_text', `Idea text must be 1-${maxIdeaLength} characters.`)
          }
        }

        const updated = await applyAiIdeaUpdate({
          id: existing.id,
          clientId: client.id,
          clientName: client.name,
          ...(hasText ? { nextText: String(body.text) } : {}),
          ...(nextWork !== undefined ? { nextWork } : {}),
          ...(hasUsed ? { nextUsed: body.used as boolean } : {}),
          action: 'ideas.update',
        })
        return ok({ idea: updated.idea, snapshotSaved: true }, 200, updated.idea.id, `snapshot:${updated.snapshot.id}`)
      }

      case 'ideas.delete': {
        const ideas = await listIdeas()
        const existing = ideas.find((i) => i.id === params.ideaId)
        if (!existing) {
          if (client.scope.mode !== 'all') return fail(403, 'forbidden_scope', 'Idea is outside scope or unavailable.')
          return fail(404, 'idea_not_found', 'Idea not found.')
        }
        if (!isIdeaInScope(client, existing)) {
          return fail(403, 'forbidden_scope', 'Idea is outside AI client scope.')
        }
        const ideaHash = synchronousContentHash(JSON.stringify({
          id: existing.id,
          text: existing.text,
          library: existing.library ?? '',
          bookId: existing.bookId ?? '',
          createdAt: existing.createdAt,
          usedAt: existing.usedAt ?? 0,
        }))
        const fingerprint = `idea-delete:${existing.id}:${ideaHash}`
        if (phase === 'prepare-delete') {
          return {
            ok: false,
            requiresConfirmation: true,
            confirmedAction: 'ideas.delete',
            fingerprint,
            targetSummary: existing.text.slice(0, 80),
            impact: {
              kind: 'idea',
              ideaId: existing.id,
              ideaPreview: existing.text.slice(0, 120),
              summary: `Idea: ${existing.text.slice(0, 80)}`,
            },
          }
        }
        if (fingerprint !== request.expectedFingerprint) {
          return fail(409, 'stale_confirmation_target', 'Idea changed before confirmation completed.')
        }
        const entry = await deleteIdea(existing.id)
        return ok({ deleted: true, movedToTrash: Boolean(entry), ideaId: existing.id }, 200, existing.text.slice(0, 80), entry ? `trashed:${entry.id}` : 'already_deleted')
      }

      default:
        return fail(400, 'unsupported_action', `Unsupported action: ${action}`)
    }
  } catch (error) {
    if (error instanceof ConfirmStateConflictError) {
      return fail(409, 'stale_confirmation_target', error.message)
    }
    const message = storageError(error) || (error instanceof Error ? error.message : String(error))
    return fail(400, 'operation_failed', message, undefined, undefined, message)
  }
}
