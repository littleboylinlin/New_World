import { t } from '../i18n'
import { ConfirmStateConflictError, hashDocumentContent, synchronousContentHash } from '../confirm-state'
import { announced, maxTitleLength, openDatabase, resultOf, trashEntry, writing } from '../library'
import type { AiChapterBaseline, ChapterRevision, LibraryId, RevisionBlobRecord, RevisionSource, TrashEntry } from '../library'
import { recordWriting } from '../writing-stats'
import { chapterText, maxChapters, wordCount } from './model'
import type { ChapterInfo, ChapterRecord, DocumentContent, Edition, EditionKey } from './model'

export { ConfirmStateConflictError, hashDocumentContent, synchronousContentHash }

export const historyWarningCount = 200
export const historyWarningBytes = 16 * 1024 * 1024
export const defaultPruneKeepCount = 5

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

class RetryRevisionPrepError extends Error {}

export interface ExpectedChapterState {
  id: string
  title: string
  revision: number
  contentHash: string
}

export interface ExpectedEditionState {
  editionRevision: number
  chapters?: ExpectedChapterState[]
}

interface PreparedPayload {
  blob: RevisionBlobRecord
  words: number
  plainText: string
}

export interface HistoryStorageStats {
  chapterCount: number
  totalRevisions: number
  ideaRevisions: number
  uniqueBlobs: number
  totalStoredBytes: number
  totalRawBytes: number
  quotaBytes?: number
  usageBytes?: number
  warn: boolean
}

export function cloneDocumentContent(content: DocumentContent): DocumentContent {
  return JSON.parse(JSON.stringify(content)) as DocumentContent
}

async function compressSnapshotJson(json: string): Promise<{
  encoding: 'gzip' | 'json'
  data: Uint8Array
  rawBytes: number
  storedBytes: number
}> {
  const raw = Uint8Array.from(textEncoder.encode(json))
  const rawBytes = raw.byteLength
  if (typeof CompressionStream === 'function') {
    try {
      const readable = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))
      const compressed = new Uint8Array(await new Response(readable).arrayBuffer())
      if (compressed.byteLength > 0 && compressed.byteLength < rawBytes) {
        return { encoding: 'gzip', data: compressed, rawBytes, storedBytes: compressed.byteLength }
      }
    } catch {
      // Fall back cleanly when CompressionStream is unavailable in restricted contexts.
    }
  }
  return { encoding: 'json', data: raw, rawBytes, storedBytes: rawBytes }
}

export async function decodeRevisionBlob(record: RevisionBlobRecord): Promise<DocumentContent> {
  const bytes = record.data instanceof Uint8Array ? Uint8Array.from(record.data) : new Uint8Array(record.data)
  let json: string
  if (record.encoding === 'gzip') {
    if (typeof DecompressionStream !== 'function') {
      throw new Error(t('library.theLocalLibraryOperationFailedTryAgain'))
    }
    const readable = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    json = textDecoder.decode(await new Response(readable).arrayBuffer())
  } else {
    json = textDecoder.decode(bytes)
  }
  return JSON.parse(json) as DocumentContent
}

async function prepareChapterPayload(content: DocumentContent, now = Date.now()): Promise<PreparedPayload> {
  const cloned = cloneDocumentContent(content)
  const json = JSON.stringify(cloned)
  const hash = synchronousContentHash(json)
  const compressed = await compressSnapshotJson(json)
  return {
    blob: {
      hash,
      encoding: compressed.encoding,
      data: compressed.data,
      rawBytes: compressed.rawBytes,
      storedBytes: compressed.storedBytes,
      createdAt: now,
    },
    words: wordCount(cloned),
    plainText: chapterText(cloned, '\n\n'),
  }
}

export async function resolveRevisionPayload(rev: ChapterRevision): Promise<{ content: DocumentContent; plainText: string }> {
  if (rev.content) {
    const content = cloneDocumentContent(rev.content)
    return { content, plainText: rev.plainText ?? chapterText(content, '\n\n') }
  }
  const hash = rev.blobHash ?? rev.contentHash
  const db = await openDatabase()
  const blob: RevisionBlobRecord | undefined = await resultOf(
    db.transaction('revisionBlobs').objectStore('revisionBlobs').get(hash),
  )
  if (!blob) throw new Error(t('revisions.notFound'))
  const content = await decodeRevisionBlob(blob)
  return { content, plainText: chapterText(content, '\n\n') }
}

export interface BuildRevisionInput {
  edition: Pick<Edition, 'library' | 'bookId' | 'id' | 'name'>
  chapter: ChapterRecord
  chapterTitle: string
  source: RevisionSource
  action: string
  clientId?: string
  clientName?: string
  createdAt?: number
}

export function buildChapterRevision(input: BuildRevisionInput): ChapterRevision {
  const snapshotContent = cloneDocumentContent(input.chapter.content)
  const json = JSON.stringify(snapshotContent)
  const plain = chapterText(snapshotContent, '\n\n')
  const words = wordCount(snapshotContent)
  const contentHash = synchronousContentHash(json)
  return {
    id: crypto.randomUUID(),
    library: input.edition.library,
    bookId: input.edition.bookId,
    editionId: input.edition.id,
    chapterId: input.chapter.id,
    chapterTitle: input.chapterTitle,
    editionName: input.edition.name,
    chapterRevision: input.chapter.revision,
    content: snapshotContent,
    plainText: plain,
    rawBytes: textEncoder.encode(json).byteLength,
    words,
    createdAt: input.createdAt ?? Date.now(),
    source: input.source,
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.clientName ? { clientName: input.clientName } : {}),
    action: input.action,
    contentHash,
  }
}

function buildDeduplicatedRevision(
  input: Omit<BuildRevisionInput, 'chapter'> & { chapter: Pick<ChapterRecord, 'id' | 'revision'> },
  prepared: PreparedPayload,
): ChapterRevision {
  return {
    id: crypto.randomUUID(),
    library: input.edition.library,
    bookId: input.edition.bookId,
    editionId: input.edition.id,
    chapterId: input.chapter.id,
    chapterTitle: input.chapterTitle,
    editionName: input.edition.name,
    chapterRevision: input.chapter.revision,
    blobHash: prepared.blob.hash,
    rawBytes: prepared.blob.rawBytes,
    storedBytes: prepared.blob.storedBytes,
    words: prepared.words,
    createdAt: input.createdAt ?? Date.now(),
    source: input.source,
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.clientName ? { clientName: input.clientName } : {}),
    action: input.action,
    contentHash: prepared.blob.hash,
  }
}

export async function listChapterRevisions(edition: EditionKey, chapterId: string): Promise<ChapterRevision[]> {
  const db = await openDatabase()
  const index = db.transaction('revisions').objectStore('revisions').index('byChapter')
  const rows: ChapterRevision[] = await resultOf(index.getAll([edition.library, edition.bookId, edition.id, chapterId]))
  return rows.sort((a, b) => b.createdAt - a.createdAt || b.chapterRevision - a.chapterRevision)
}

export async function countChapterRevisions(edition: EditionKey, chapterId: string): Promise<number> {
  const db = await openDatabase()
  const index = db.transaction('revisions').objectStore('revisions').index('byChapter')
  return resultOf(index.count([edition.library, edition.bookId, edition.id, chapterId]))
}

export async function getHistoryStorageStats(edition: EditionKey, chapterId: string): Promise<HistoryStorageStats> {
  const db = await openDatabase()
  const tx = db.transaction(['revisions', 'revisionBlobs', 'ideaRevisions'])
  const [allRevs, allBlobs, ideaRevCount] = await Promise.all([
    resultOf<ChapterRevision[]>(tx.objectStore('revisions').getAll()),
    resultOf<RevisionBlobRecord[]>(tx.objectStore('revisionBlobs').getAll()),
    resultOf<number>(tx.objectStore('ideaRevisions').count()),
  ])
  let chapterCount = 0
  let totalRawBytes = 0
  let inlineStoredBytes = 0
  for (const rev of allRevs) {
    if (
      rev.library === edition.library &&
      rev.bookId === edition.bookId &&
      rev.editionId === edition.id &&
      rev.chapterId === chapterId
    ) {
      chapterCount++
    }
    if (typeof rev.rawBytes === 'number') {
      totalRawBytes += rev.rawBytes
    } else if (rev.content) {
      const legacyLen = textEncoder.encode(JSON.stringify(rev.content)).byteLength
      const plainLen = rev.plainText ? textEncoder.encode(rev.plainText).byteLength : 0
      totalRawBytes += legacyLen
      inlineStoredBytes += legacyLen + plainLen
    }
  }
  const blobStoredBytes = allBlobs.reduce((sum, item) => sum + item.storedBytes, 0)
  const totalStoredBytes = blobStoredBytes + inlineStoredBytes
  const totalRevisions = allRevs.length + ideaRevCount
  let quotaBytes: number | undefined
  let usageBytes: number | undefined
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (typeof estimate?.quota === 'number' && Number.isFinite(estimate.quota)) quotaBytes = estimate.quota
    if (typeof estimate?.usage === 'number' && Number.isFinite(estimate.usage)) usageBytes = estimate.usage
  } catch {
    // Storage estimate is advisory only.
  }
  const nearQuota = Boolean(quotaBytes && usageBytes && quotaBytes > 0 && usageBytes / quotaBytes >= 0.8)
  const warn = totalRevisions >= historyWarningCount || totalStoredBytes >= historyWarningBytes || nearQuota
  return {
    chapterCount,
    totalRevisions,
    ideaRevisions: ideaRevCount,
    uniqueBlobs: allBlobs.length,
    totalStoredBytes,
    totalRawBytes,
    quotaBytes,
    usageBytes,
    warn,
  }
}

/**
 * Explicitly prunes older revisions for one chapter after user confirmation,
 * ALWAYS preserving at least one latest recoverable revision (`keepLatest >= 1`),
 * and cleans up orphaned `revisionBlobs` no longer referenced by any revision.
 */
export async function pruneChapterRevisions(
  edition: EditionKey,
  chapterId: string,
  keepLatest = defaultPruneKeepCount,
): Promise<{ deleted: number; freedBlobs: number; remaining: number }> {
  if (!Number.isInteger(keepLatest) || keepLatest < 1) {
    throw new Error(t('revisions.keepAtLeastOne'))
  }
  const db = await openDatabase()
  const tx = db.transaction(['revisions', 'revisionBlobs'], 'readwrite', { durability: 'strict' })
  const revisionsStore = tx.objectStore('revisions')
  const blobsStore = tx.objectStore('revisionBlobs')
  const { step, done } = writing<{ deleted: number; freedBlobs: number; remaining: number }>(tx)
  const allReq = revisionsStore.getAll()

  allReq.onsuccess = step(() => {
    const all: ChapterRevision[] = allReq.result
    const matching = all
      .filter(
        (rev) =>
          rev.library === edition.library &&
          rev.bookId === edition.bookId &&
          rev.editionId === edition.id &&
          rev.chapterId === chapterId,
      )
      .sort((a, b) => b.createdAt - a.createdAt || b.chapterRevision - a.chapterRevision)

    if (matching.length <= keepLatest) {
      return { deleted: 0, freedBlobs: 0, remaining: matching.length }
    }

    const toDelete = matching.slice(keepLatest)
    const deletedIds = new Set(toDelete.map((item) => item.id))
    const candidateHashes = new Set<string>()
    for (const item of toDelete) {
      revisionsStore.delete(item.id)
      if (item.blobHash) candidateHashes.add(item.blobHash)
    }

    const stillReferenced = new Set<string>()
    for (const item of all) {
      if (!deletedIds.has(item.id) && item.blobHash) stillReferenced.add(item.blobHash)
    }

    let freedBlobs = 0
    for (const hash of candidateHashes) {
      if (!stillReferenced.has(hash)) {
        blobsStore.delete(hash)
        freedBlobs++
      }
    }

    return { deleted: toDelete.length, freedBlobs, remaining: keepLatest }
  })

  return announced(done())
}

export async function getAiBaseline(
  clientId: string,
  edition: EditionKey,
  chapterId: string,
): Promise<AiChapterBaseline | undefined> {
  const db = await openDatabase()
  return resultOf(
    db.transaction('aiBaselines').objectStore('aiBaselines').get([clientId, edition.library, edition.bookId, edition.id, chapterId]),
  )
}

export async function listEditionAiBaselines(
  clientId: string,
  edition: EditionKey,
): Promise<Map<string, AiChapterBaseline>> {
  const db = await openDatabase()
  const rows: AiChapterBaseline[] = await resultOf(
    db.transaction('aiBaselines').objectStore('aiBaselines').index('byEdition').getAll([edition.library, edition.bookId, edition.id]),
  )
  const result = new Map<string, AiChapterBaseline>()
  for (const row of rows) {
    if (row.clientId === clientId) result.set(row.chapterId, row)
  }
  return result
}

export function nextBaselineRecord(
  existing: AiChapterBaseline | undefined,
  params: {
    clientId: string
    library: LibraryId
    bookId: string
    editionId: string
    chapterId: string
    beforeWords: number
    afterWords: number
    beforeText: string
    afterText: string
    resetToNew?: boolean
    now?: number
  },
): AiChapterBaseline {
  if (params.resetToNew) {
    return {
      clientId: params.clientId,
      library: params.library,
      bookId: params.bookId,
      editionId: params.editionId,
      chapterId: params.chapterId,
      peakWords: params.afterWords,
      anchorWords: params.afterWords,
      anchorText: params.afterText.slice(0, 64_000),
      updatedAt: params.now ?? Date.now(),
    }
  }
  const peakWords = Math.max(existing?.peakWords ?? 0, params.beforeWords, params.afterWords)
  const existingAnchorWords = existing?.anchorWords ?? 0
  const hasAnchor = Boolean(existing?.anchorText && existingAnchorWords >= 20)
  // Upgrade anchor only on substantial chapter growth so slow-drip substitutions stay anchored against original prose.
  const grewSubstantially = hasAnchor && params.beforeWords >= Math.max(existingAnchorWords * 1.35, existingAnchorWords + 50)
  const useBefore = (!hasAnchor && params.beforeWords >= 20) || grewSubstantially
  const anchorWords = useBefore
    ? params.beforeWords
    : hasAnchor
      ? existingAnchorWords
      : params.afterWords
  const anchorText = useBefore
    ? params.beforeText
    : hasAnchor
      ? existing!.anchorText
      : params.afterText
  return {
    clientId: params.clientId,
    library: params.library,
    bookId: params.bookId,
    editionId: params.editionId,
    chapterId: params.chapterId,
    peakWords,
    anchorWords,
    anchorText: anchorText.slice(0, 64_000),
    updatedAt: params.now ?? Date.now(),
  }
}

/** Restores a historical revision (content + original chapter title) while atomically snapshotting the current chapter first. */
export async function restoreChapterRevision(edition: EditionKey, chapterId: string, revisionId: string) {
  const db = await openDatabase()
  const key = [edition.library, edition.bookId, edition.id]

  // Resolve target snapshot payload outside the write transaction (may need async gzip decompression).
  const preReadTx = db.transaction(['revisions', 'chapters'], 'readonly')
  const [preTargetRev, preCurrentChapter] = await Promise.all([
    resultOf<ChapterRevision | undefined>(preReadTx.objectStore('revisions').get(revisionId)),
    resultOf<ChapterRecord | undefined>(preReadTx.objectStore('chapters').get([...key, chapterId])),
  ])
  if (
    !preTargetRev ||
    preTargetRev.library !== edition.library ||
    preTargetRev.bookId !== edition.bookId ||
    preTargetRev.editionId !== edition.id ||
    preTargetRev.chapterId !== chapterId
  ) {
    throw new Error(t('revisions.notFound'))
  }
  if (!preCurrentChapter) throw new Error(t('store.theChapterWasNotFoundInThisEditable'))
  const resolvedTarget = await resolveRevisionPayload(preTargetRev)
  const restoredTitle = preTargetRev.chapterTitle?.trim()
  if (!restoredTitle || restoredTitle.length > maxTitleLength) {
    throw new Error(t('store.enterAChapterTitle'))
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const latestCurrent = attempt === 0
      ? preCurrentChapter
      : await resultOf<ChapterRecord | undefined>(db.transaction('chapters').objectStore('chapters').get([...key, chapterId]))
    if (!latestCurrent) throw new Error(t('store.theChapterWasNotFoundInThisEditable'))
    const preparedBackup = await prepareChapterPayload(latestCurrent.content)

    const tx = db.transaction(
      ['editions', 'chapters', 'writingDays', 'revisions', 'revisionBlobs', 'aiBaselines'],
      'readwrite',
      { durability: 'strict' },
    )
    const editions = tx.objectStore('editions')
    const chapters = tx.objectStore('chapters')
    const days = tx.objectStore('writingDays')
    const revisions = tx.objectStore('revisions')
    const revisionBlobs = tx.objectStore('revisionBlobs')
    const baselines = tx.objectStore('aiBaselines')
    const { step, done } = writing<{
      edition: Edition
      chapter: ChapterRecord
      backupRevision: ChapterRevision
      restoredFrom: ChapterRevision
    }>(tx)

    const editionReq = editions.get(key)
    const chapterReq = chapters.get([...key, chapterId])
    const revisionReq = revisions.get(revisionId)
    const blobReq = revisionBlobs.get(preparedBackup.blob.hash)
    const baselinesReq = baselines.index('byEdition').getAll(key)

    baselinesReq.onsuccess = step(() => {
      const storedEdition: Edition | undefined = editionReq.result
      const currentChapter: ChapterRecord | undefined = chapterReq.result
      const targetRev: ChapterRevision | undefined = revisionReq.result
      if (!storedEdition || !currentChapter) throw new Error(t('store.theChapterWasNotFoundInThisEditable'))
      if (
        !targetRev ||
        targetRev.library !== edition.library ||
        targetRev.bookId !== edition.bookId ||
        targetRev.editionId !== edition.id ||
        targetRev.chapterId !== chapterId
      ) {
        throw new Error(t('revisions.notFound'))
      }
      if (hashDocumentContent(currentChapter.content) !== preparedBackup.blob.hash) {
        throw new RetryRevisionPrepError()
      }
      const infoIndex = storedEdition.chapters.findIndex((item) => item.id === chapterId)
      if (infoIndex < 0) throw new Error(t('store.theChapterWasNotFoundInThisEditable'))
      const info = storedEdition.chapters[infoIndex]

      if (!blobReq.result) revisionBlobs.put(preparedBackup.blob)
      const backupRevision = buildDeduplicatedRevision(
        {
          edition: storedEdition,
          chapter: currentChapter,
          chapterTitle: info.title,
          source: 'user-restore',
          action: 'restore.backup',
        },
        preparedBackup,
      )
      revisions.add(backupRevision)

      let nextEdition = storedEdition
      if (restoredTitle !== info.title) {
        const updatedList = [...storedEdition.chapters]
        updatedList[infoIndex] = { id: info.id, title: restoredTitle }
        nextEdition = { ...storedEdition, chapters: updatedList, revision: storedEdition.revision + 1 }
        editions.put(nextEdition)
      }

      const restoredContent = cloneDocumentContent(resolvedTarget.content)
      const nextChapter: ChapterRecord = {
        ...currentChapter,
        content: restoredContent,
        revision: currentChapter.revision + 1,
      }
      chapters.put(nextChapter)

      const delta = wordCount(restoredContent) - wordCount(currentChapter.content)
      if (delta !== 0) recordWriting(days, delta)

      for (const row of (baselinesReq.result as AiChapterBaseline[])) {
        if (row.chapterId === chapterId) {
          baselines.delete([row.clientId, row.library, row.bookId, row.editionId, row.chapterId])
        }
      }

      return { edition: nextEdition, chapter: nextChapter, backupRevision, restoredFrom: targetRev }
    })

    try {
      return await announced(done())
    } catch (error) {
      if (error instanceof RetryRevisionPrepError && attempt < 2) continue
      throw error
    }
  }
  throw new Error(t('library.theLocalLibraryOperationFailedTryAgain'))
}

/**
 * Atomically snapshots pre-edit chapter state, saves updated content/title, updates persistent
 * AI baseline tracking, and credits writing statistics in a single strict IndexedDB transaction.
 */
export async function applyAiChapterUpdate(params: {
  edition: EditionKey
  chapterId: string
  clientId: string
  clientName: string
  nextTitle?: string
  nextContent?: DocumentContent
  action?: string
  resetBaseline?: boolean
  expected?: ExpectedChapterState & { editionRevision?: number }
}): Promise<{
  edition: Edition
  chapter: ChapterRecord
  snapshot: ChapterRevision
  baseline: AiChapterBaseline
}> {
  const db = await openDatabase()
  const key = [params.edition.library, params.edition.bookId, params.edition.id]

  for (let attempt = 0; attempt < 3; attempt++) {
    const preChapter = await resultOf<ChapterRecord | undefined>(
      db.transaction('chapters').objectStore('chapters').get([...key, params.chapterId]),
    )
    if (!preChapter) throw new Error(t('store.theChapterWasNotFoundInThisEditable'))
    const prepared = await prepareChapterPayload(preChapter.content)

    const tx = db.transaction(
      ['editions', 'chapters', 'writingDays', 'revisions', 'revisionBlobs', 'aiBaselines'],
      'readwrite',
      { durability: 'strict' },
    )
    const editions = tx.objectStore('editions')
    const chapters = tx.objectStore('chapters')
    const days = tx.objectStore('writingDays')
    const revisions = tx.objectStore('revisions')
    const revisionBlobs = tx.objectStore('revisionBlobs')
    const baselines = tx.objectStore('aiBaselines')
    const { step, done } = writing<{
      edition: Edition
      chapter: ChapterRecord
      snapshot: ChapterRevision
      baseline: AiChapterBaseline
    }>(tx)

    const editionReq = editions.get(key)
    const chapterReq = chapters.get([...key, params.chapterId])
    const blobReq = revisionBlobs.get(prepared.blob.hash)
    const baselineReq = baselines.get([params.clientId, params.edition.library, params.edition.bookId, params.edition.id, params.chapterId])

    baselineReq.onsuccess = step(() => {
      const storedEdition: Edition | undefined = editionReq.result
      const currentChapter: ChapterRecord | undefined = chapterReq.result
      if (!storedEdition || !currentChapter) {
        throw new Error(t('store.theChapterWasNotFoundInThisEditable'))
      }
      const index = storedEdition.chapters.findIndex((item) => item.id === params.chapterId)
      if (index < 0) {
        throw new Error(t('store.theChapterWasNotFoundInThisEditable'))
      }
      const currentInfo = storedEdition.chapters[index]
      const currentHash = hashDocumentContent(currentChapter.content)

      if (params.expected) {
        if (
          (params.expected.editionRevision !== undefined && storedEdition.revision !== params.expected.editionRevision) ||
          currentChapter.revision !== params.expected.revision ||
          currentInfo.title !== params.expected.title ||
          currentHash !== params.expected.contentHash
        ) {
          throw new ConfirmStateConflictError()
        }
      }
      if (currentHash !== prepared.blob.hash) {
        throw new RetryRevisionPrepError()
      }

      const trimmedTitle = params.nextTitle !== undefined ? params.nextTitle.trim() : currentInfo.title
      if (!trimmedTitle || trimmedTitle.length > maxTitleLength) {
        throw new Error(t('store.enterAChapterTitle'))
      }

      if (!blobReq.result) revisionBlobs.put(prepared.blob)
      const snapshot = buildDeduplicatedRevision(
        {
          edition: storedEdition,
          chapter: currentChapter,
          chapterTitle: currentInfo.title,
          source: 'ai',
          action: params.action ?? 'chapters.update',
          clientId: params.clientId,
          clientName: params.clientName,
        },
        prepared,
      )
      revisions.add(snapshot)

      let nextEdition = storedEdition
      if (trimmedTitle !== currentInfo.title) {
        const updatedList = [...storedEdition.chapters]
        updatedList[index] = { id: currentInfo.id, title: trimmedTitle }
        nextEdition = { ...storedEdition, chapters: updatedList, revision: storedEdition.revision + 1 }
        editions.put(nextEdition)
      }

      const updatedContent = params.nextContent ? cloneDocumentContent(params.nextContent) : cloneDocumentContent(currentChapter.content)
      const nextChapter: ChapterRecord = {
        ...currentChapter,
        content: updatedContent,
        revision: currentChapter.revision + 1,
      }
      chapters.put(nextChapter)

      const beforeWords = prepared.words
      const afterWords = wordCount(updatedContent)
      const afterText = chapterText(updatedContent, '\n\n')
      const delta = afterWords - beforeWords
      if (delta !== 0) recordWriting(days, delta)

      const baseline = nextBaselineRecord(baselineReq.result as AiChapterBaseline | undefined, {
        clientId: params.clientId,
        library: storedEdition.library,
        bookId: storedEdition.bookId,
        editionId: storedEdition.id,
        chapterId: params.chapterId,
        beforeWords,
        afterWords,
        beforeText: prepared.plainText,
        afterText,
        resetToNew: params.resetBaseline,
      })
      baselines.put(baseline)

      return { edition: nextEdition, chapter: nextChapter, snapshot, baseline }
    })

    try {
      return await announced(done())
    } catch (error) {
      if (error instanceof RetryRevisionPrepError && !params.expected && attempt < 2) continue
      throw error
    }
  }
  throw new Error(t('library.theLocalLibraryOperationFailedTryAgain'))
}

export interface ReplaceBatchChapterInput {
  id?: string
  title: string
  content: DocumentContent
}

/**
 * Atomically applies a batch chapter replacement on an edition in one strict IndexedDB transaction:
 * snapshots every modified/removed chapter into `revisions` + deduplicated `revisionBlobs`,
 * moves removed chapters to `trash`, updates `chapters` + `editions`, and persists `aiBaselines`.
 */
export async function applyAiEditionReplaceBatch(params: {
  edition: EditionKey
  clientId: string
  clientName: string
  chapters: ReplaceBatchChapterInput[]
  resetBaseline?: boolean
  expected?: ExpectedEditionState
}): Promise<{
  edition: Edition
  chapters: ChapterRecord[]
  snapshots: ChapterRevision[]
  trashed: TrashEntry[]
}> {
  if (!params.chapters.length || params.chapters.length > maxChapters) {
    throw new Error(t('store.eachEditableVersionCanContainUpToChapters', [maxChapters]))
  }
  const db = await openDatabase()
  const key = [params.edition.library, params.edition.bookId, params.edition.id]

  for (let attempt = 0; attempt < 3; attempt++) {
    const preTx = db.transaction(['editions', 'chapters'], 'readonly')
    const [preEdition, preChapters] = await Promise.all([
      resultOf<Edition | undefined>(preTx.objectStore('editions').get(key)),
      resultOf<ChapterRecord[]>(preTx.objectStore('chapters').index('byEdition').getAll(key)),
    ])
    if (!preEdition) throw new Error(t('store.theEditableVersionWasNotFound'))

    const preChapterMap = new Map<string, ChapterRecord>(preChapters.map((row) => [row.id, row]))
    const preparedMap = new Map<string, PreparedPayload>()
    for (const info of preEdition.chapters) {
      const rec = preChapterMap.get(info.id)
      if (!rec) throw new Error(t('store.theChapterWasNotFoundInThisEditable'))
      preparedMap.set(info.id, await prepareChapterPayload(rec.content))
    }

    const uniqueHashes = Array.from(new Set(Array.from(preparedMap.values()).map((item) => item.blob.hash)))

    const tx = db.transaction(
      ['editions', 'chapters', 'trash', 'writingDays', 'revisions', 'revisionBlobs', 'aiBaselines'],
      'readwrite',
      { durability: 'strict' },
    )
    const editions = tx.objectStore('editions')
    const chaptersStore = tx.objectStore('chapters')
    const trashStore = tx.objectStore('trash')
    const days = tx.objectStore('writingDays')
    const revisions = tx.objectStore('revisions')
    const revisionBlobs = tx.objectStore('revisionBlobs')
    const baselines = tx.objectStore('aiBaselines')
    const { step, done } = writing<{
      edition: Edition
      chapters: ChapterRecord[]
      snapshots: ChapterRevision[]
      trashed: TrashEntry[]
    }>(tx)

    const blobExistReqs = new Map<string, IDBRequest<RevisionBlobRecord | undefined>>()
    for (const hash of uniqueHashes) {
      blobExistReqs.set(hash, revisionBlobs.get(hash))
    }
    const editionReq = editions.get(key)
    const existingChaptersReq = chaptersStore.index('byEdition').getAll(key)
    const baselinesReq = baselines.index('byEdition').getAll(key)

    baselinesReq.onsuccess = step(() => {
      const storedEdition: Edition | undefined = editionReq.result
      if (!storedEdition) {
        throw new Error(t('store.theEditableVersionWasNotFound'))
      }
      const existingRecords = new Map<string, ChapterRecord>(
        (existingChaptersReq.result as ChapterRecord[]).map((row) => [row.id, row]),
      )

      if (params.expected) {
        if (storedEdition.revision !== params.expected.editionRevision) {
          throw new ConfirmStateConflictError()
        }
        if (params.expected.chapters) {
          if (storedEdition.chapters.length !== params.expected.chapters.length) {
            throw new ConfirmStateConflictError()
          }
          for (let i = 0; i < storedEdition.chapters.length; i++) {
            const curInfo = storedEdition.chapters[i]
            const exp = params.expected.chapters[i]
            const curRec = existingRecords.get(curInfo.id)
            if (
              !curRec ||
              curInfo.id !== exp.id ||
              curInfo.title !== exp.title ||
              curRec.revision !== exp.revision ||
              hashDocumentContent(curRec.content) !== exp.contentHash
            ) {
              throw new ConfirmStateConflictError()
            }
          }
        }
      }

      if (storedEdition.chapters.length !== preparedMap.size) {
        throw new RetryRevisionPrepError()
      }
      for (const info of storedEdition.chapters) {
        const curRec = existingRecords.get(info.id)
        const prep = preparedMap.get(info.id)
        if (!curRec || !prep || hashDocumentContent(curRec.content) !== prep.blob.hash) {
          throw new RetryRevisionPrepError()
        }
      }

      const infoById = new Map<string, { info: ChapterInfo; index: number }>(
        storedEdition.chapters.map((info, index) => [info.id, { info, index }]),
      )
      const existingBaselines = new Map<string, AiChapterBaseline>()
      for (const row of (baselinesReq.result as AiChapterBaseline[])) {
        if (row.clientId === params.clientId) existingBaselines.set(row.chapterId, row)
      }

      const retainedIds = new Set<string>()
      for (const item of params.chapters) {
        if (item.id && infoById.has(item.id)) retainedIds.add(item.id)
      }

      const snapshots: ChapterRevision[] = []
      const trashed: TrashEntry[] = []
      const writtenHashes = new Set<string>()
      let totalDelta = 0
      const now = Date.now()

      const ensureBlob = (prep: PreparedPayload) => {
        const existingReq = blobExistReqs.get(prep.blob.hash)
        if (!existingReq?.result && !writtenHashes.has(prep.blob.hash)) {
          revisionBlobs.put(prep.blob)
          writtenHashes.add(prep.blob.hash)
        }
      }

      for (let index = 0; index < storedEdition.chapters.length; index++) {
        const oldInfo = storedEdition.chapters[index]
        if (retainedIds.has(oldInfo.id)) continue
        const oldRecord = existingRecords.get(oldInfo.id)
        const prepared = preparedMap.get(oldInfo.id)
        if (!oldRecord || !prepared) {
          throw new Error(t('store.theChapterWasNotFoundInThisEditable'))
        }
        ensureBlob(prepared)
        const removedSnapshot = buildDeduplicatedRevision(
          {
            edition: storedEdition,
            chapter: oldRecord,
            chapterTitle: oldInfo.title,
            source: 'ai',
            action: 'chapters.replaceBatch.remove',
            clientId: params.clientId,
            clientName: params.clientName,
            createdAt: now,
          },
          prepared,
        )
        revisions.add(removedSnapshot)
        snapshots.push(removedSnapshot)

        const entry = trashEntry('chapter', storedEdition.library, storedEdition.bookId, oldInfo.title)
        entry.chapters = [oldRecord]
        entry.position = { editionId: storedEdition.id, index }
        trashStore.add(entry)
        trashed.push(entry)

        chaptersStore.delete([...key, oldInfo.id])
        baselines.delete([params.clientId, storedEdition.library, storedEdition.bookId, storedEdition.id, oldInfo.id])
        totalDelta -= prepared.words
      }

      const nextInfos: ChapterInfo[] = []
      const nextRecords: ChapterRecord[] = []
      const usedIds = new Set<string>()
      for (const item of params.chapters) {
        const cleanTitle = item.title.trim()
        if (!cleanTitle || cleanTitle.length > maxTitleLength) {
          throw new Error(t('store.enterAChapterTitle'))
        }
        const nextContent = cloneDocumentContent(item.content)
        const afterWords = wordCount(nextContent)
        const afterText = chapterText(nextContent, '\n\n')
        const matchedId = item.id && !usedIds.has(item.id) && existingRecords.has(item.id) ? item.id : undefined

        if (matchedId) {
          usedIds.add(matchedId)
          const oldRecord = existingRecords.get(matchedId)!
          const prepared = preparedMap.get(matchedId)!
          const oldTitle = infoById.get(matchedId)?.info.title ?? cleanTitle
          ensureBlob(prepared)
          const snapshot = buildDeduplicatedRevision(
            {
              edition: storedEdition,
              chapter: oldRecord,
              chapterTitle: oldTitle,
              source: 'ai',
              action: 'chapters.replaceBatch',
              clientId: params.clientId,
              clientName: params.clientName,
              createdAt: now,
            },
            prepared,
          )
          revisions.add(snapshot)
          snapshots.push(snapshot)

          const updatedRecord: ChapterRecord = {
            ...oldRecord,
            content: nextContent,
            revision: oldRecord.revision + 1,
          }
          chaptersStore.put(updatedRecord)
          nextInfos.push({ id: matchedId, title: cleanTitle })
          nextRecords.push(updatedRecord)
          totalDelta += afterWords - prepared.words

          const updatedBaseline = nextBaselineRecord(existingBaselines.get(matchedId), {
            clientId: params.clientId,
            library: storedEdition.library,
            bookId: storedEdition.bookId,
            editionId: storedEdition.id,
            chapterId: matchedId,
            beforeWords: prepared.words,
            afterWords,
            beforeText: prepared.plainText,
            afterText,
            resetToNew: params.resetBaseline,
            now,
          })
          baselines.put(updatedBaseline)
        } else {
          const createdId = crypto.randomUUID()
          usedIds.add(createdId)
          const newRecord: ChapterRecord = {
            library: storedEdition.library,
            bookId: storedEdition.bookId,
            editionId: storedEdition.id,
            id: createdId,
            content: nextContent,
            revision: 1,
          }
          chaptersStore.add(newRecord)
          nextInfos.push({ id: createdId, title: cleanTitle })
          nextRecords.push(newRecord)
          totalDelta += afterWords

          const seededBaseline = nextBaselineRecord(undefined, {
            clientId: params.clientId,
            library: storedEdition.library,
            bookId: storedEdition.bookId,
            editionId: storedEdition.id,
            chapterId: createdId,
            beforeWords: afterWords,
            afterWords,
            beforeText: afterText,
            afterText,
            now,
          })
          baselines.put(seededBaseline)
        }
      }

      const nextEdition: Edition = {
        ...storedEdition,
        chapters: nextInfos,
        revision: storedEdition.revision + 1,
      }
      editions.put(nextEdition)
      if (totalDelta !== 0) recordWriting(days, totalDelta)

      return { edition: nextEdition, chapters: nextRecords, snapshots, trashed }
    })

    try {
      return await announced(done())
    } catch (error) {
      if (error instanceof RetryRevisionPrepError && !params.expected && attempt < 2) continue
      throw error
    }
  }
  throw new Error(t('library.theLocalLibraryOperationFailedTryAgain'))
}
