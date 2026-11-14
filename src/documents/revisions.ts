import { t } from '../i18n'
import { announced, maxTitleLength, openDatabase, resultOf, trashEntry, writing } from '../library'
import type { AiChapterBaseline, ChapterRevision, LibraryId, RevisionSource, TrashEntry } from '../library'
import { recordWriting } from '../writing-stats'
import { chapterText, maxChapters, wordCount } from './model'
import type { ChapterInfo, ChapterRecord, DocumentContent, Edition, EditionKey } from './model'

/** Fast synchronous 64-bit FNV-1a hex fingerprint, safe inside IDB transaction handlers. */
export function synchronousContentHash(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x811c9dc5 ^ 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

export function cloneDocumentContent(content: DocumentContent): DocumentContent {
  return JSON.parse(JSON.stringify(content)) as DocumentContent
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
  const plain = chapterText(snapshotContent, '\n\n')
  const words = wordCount(snapshotContent)
  const contentHash = synchronousContentHash(JSON.stringify(snapshotContent))
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
    words,
    createdAt: input.createdAt ?? Date.now(),
    source: input.source,
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.clientName ? { clientName: input.clientName } : {}),
    action: input.action,
    contentHash,
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

/** Restores a historical revision while atomically snapshotting the current chapter first. */
export async function restoreChapterRevision(edition: EditionKey, chapterId: string, revisionId: string) {
  const db = await openDatabase()
  const tx = db.transaction(['editions', 'chapters', 'writingDays', 'revisions', 'aiBaselines'], 'readwrite', { durability: 'strict' })
  const editions = tx.objectStore('editions')
  const chapters = tx.objectStore('chapters')
  const days = tx.objectStore('writingDays')
  const revisions = tx.objectStore('revisions')
  const baselines = tx.objectStore('aiBaselines')
  const key = [edition.library, edition.bookId, edition.id]
  const { step, done } = writing<{ chapter: ChapterRecord; backupRevision: ChapterRevision; restoredFrom: ChapterRevision }>(tx)

  const editionReq = editions.get(key)
  const chapterReq = chapters.get([...key, chapterId])
  const revisionReq = revisions.get(revisionId)
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
    const info = storedEdition.chapters.find((item) => item.id === chapterId)
    if (!info) throw new Error(t('store.theChapterWasNotFoundInThisEditable'))

    const backupRevision = buildChapterRevision({
      edition: storedEdition,
      chapter: currentChapter,
      chapterTitle: info.title,
      source: 'user-restore',
      action: 'restore.backup',
    })
    revisions.add(backupRevision)

    const restoredContent = cloneDocumentContent(targetRev.content)
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

    return { chapter: nextChapter, backupRevision, restoredFrom: targetRev }
  })

  return announced(done())
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
}): Promise<{
  edition: Edition
  chapter: ChapterRecord
  snapshot: ChapterRevision
  baseline: AiChapterBaseline
}> {
  const db = await openDatabase()
  const tx = db.transaction(['editions', 'chapters', 'writingDays', 'revisions', 'aiBaselines'], 'readwrite', { durability: 'strict' })
  const editions = tx.objectStore('editions')
  const chapters = tx.objectStore('chapters')
  const days = tx.objectStore('writingDays')
  const revisions = tx.objectStore('revisions')
  const baselines = tx.objectStore('aiBaselines')
  const key = [params.edition.library, params.edition.bookId, params.edition.id]
  const { step, done } = writing<{
    edition: Edition
    chapter: ChapterRecord
    snapshot: ChapterRevision
    baseline: AiChapterBaseline
  }>(tx)

  const editionReq = editions.get(key)
  const chapterReq = chapters.get([...key, params.chapterId])
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
    const trimmedTitle = params.nextTitle !== undefined ? params.nextTitle.trim() : currentInfo.title
    if (!trimmedTitle || trimmedTitle.length > maxTitleLength) {
      throw new Error(t('store.enterAChapterTitle'))
    }

    const snapshot = buildChapterRevision({
      edition: storedEdition,
      chapter: currentChapter,
      chapterTitle: currentInfo.title,
      source: 'ai',
      action: params.action ?? 'chapters.update',
      clientId: params.clientId,
      clientName: params.clientName,
    })
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

    const beforeWords = snapshot.words
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
      beforeText: snapshot.plainText,
      afterText,
      resetToNew: params.resetBaseline,
    })
    baselines.put(baseline)

    return { edition: nextEdition, chapter: nextChapter, snapshot, baseline }
  })

  return announced(done())
}

export interface ReplaceBatchChapterInput {
  id?: string
  title: string
  content: DocumentContent
}

/**
 * Atomically applies a batch chapter replacement on an edition in one strict IndexedDB transaction:
 * snapshots every modified/removed chapter into `revisions`, moves removed chapters to `trash`,
 * updates `chapters` + `editions`, and persists `aiBaselines`.
 */
export async function applyAiEditionReplaceBatch(params: {
  edition: EditionKey
  clientId: string
  clientName: string
  chapters: ReplaceBatchChapterInput[]
  resetBaseline?: boolean
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
  const tx = db.transaction(['editions', 'chapters', 'trash', 'writingDays', 'revisions', 'aiBaselines'], 'readwrite', { durability: 'strict' })
  const editions = tx.objectStore('editions')
  const chaptersStore = tx.objectStore('chapters')
  const trashStore = tx.objectStore('trash')
  const days = tx.objectStore('writingDays')
  const revisions = tx.objectStore('revisions')
  const baselines = tx.objectStore('aiBaselines')
  const key = [params.edition.library, params.edition.bookId, params.edition.id]
  const { step, done } = writing<{
    edition: Edition
    chapters: ChapterRecord[]
    snapshots: ChapterRevision[]
    trashed: TrashEntry[]
  }>(tx)

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
    let totalDelta = 0
    const now = Date.now()

    for (let index = 0; index < storedEdition.chapters.length; index++) {
      const oldInfo = storedEdition.chapters[index]
      if (retainedIds.has(oldInfo.id)) continue
      const oldRecord = existingRecords.get(oldInfo.id)
      if (!oldRecord) {
        throw new Error(t('store.theChapterWasNotFoundInThisEditable'))
      }
      const removedSnapshot = buildChapterRevision({
        edition: storedEdition,
        chapter: oldRecord,
        chapterTitle: oldInfo.title,
        source: 'ai',
        action: 'chapters.replaceBatch.remove',
        clientId: params.clientId,
        clientName: params.clientName,
        createdAt: now,
      })
      revisions.add(removedSnapshot)
      snapshots.push(removedSnapshot)

      const entry = trashEntry('chapter', storedEdition.library, storedEdition.bookId, oldInfo.title)
      entry.chapters = [oldRecord]
      entry.position = { editionId: storedEdition.id, index }
      trashStore.add(entry)
      trashed.push(entry)

      chaptersStore.delete([...key, oldInfo.id])
      baselines.delete([params.clientId, storedEdition.library, storedEdition.bookId, storedEdition.id, oldInfo.id])
      totalDelta -= removedSnapshot.words
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
        const oldTitle = infoById.get(matchedId)?.info.title ?? cleanTitle
        const snapshot = buildChapterRevision({
          edition: storedEdition,
          chapter: oldRecord,
          chapterTitle: oldTitle,
          source: 'ai',
          action: 'chapters.replaceBatch',
          clientId: params.clientId,
          clientName: params.clientName,
          createdAt: now,
        })
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
        totalDelta += afterWords - snapshot.words

        const updatedBaseline = nextBaselineRecord(existingBaselines.get(matchedId), {
          clientId: params.clientId,
          library: storedEdition.library,
          bookId: storedEdition.bookId,
          editionId: storedEdition.id,
          chapterId: matchedId,
          beforeWords: snapshot.words,
          afterWords,
          beforeText: snapshot.plainText,
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

  return announced(done())
}
