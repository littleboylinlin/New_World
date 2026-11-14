import MarkdownIt from 'markdown-it'
import { chapterText, emptyChapter, wordCount } from '../documents/model'
import type { ChapterInfo, ChapterInput, ChapterRecord, DocumentContent } from '../documents/model'
import { cleanMarkup, inertMarkup } from '../documents/markup'
import { checkDocument, fromMarkup, toMarkup } from '../documents/schema'

const markdown = new MarkdownIt({ html: false, breaks: true })

export type ContentFormat = 'markdown' | 'text' | 'html' | 'tiptap'

export interface DestructiveAssessment {
  destructive: boolean
  reason: string
  beforeWords: number
  afterWords: number
  lostWords: number
  baselineWords: number
  retention?: number
}

// Tracks per-client highest observed word baseline for each chapter so repeated small deletions
// ("slow-drip" nibbling) cannot bypass single-step destructive-update checks.
const chapterBaselines = new Map<string, number>()
const MAX_BASELINE_ENTRIES = 5000

function baselineKey(clientId: string, library: string, bookId: string, editionId: string, chapterId: string): string {
  return `${clientId}:${library}:${bookId}:${editionId}:${chapterId}`
}

function setBaseline(key: string, words: number): void {
  if (!chapterBaselines.has(key) && chapterBaselines.size >= MAX_BASELINE_ENTRIES) {
    const oldest = chapterBaselines.keys().next().value
    if (oldest !== undefined) chapterBaselines.delete(oldest)
  }
  chapterBaselines.set(key, words)
}

export function clearChapterBaselinesForClient(clientId: string): void {
  const prefix = `${clientId}:`
  for (const key of Array.from(chapterBaselines.keys())) {
    if (key.startsWith(prefix)) chapterBaselines.delete(key)
  }
}

export function clearAllBaselines(): void {
  chapterBaselines.clear()
}

export function plainTextToDocument(text: string): DocumentContent {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized.trim()) return emptyChapter().content
  const lines = normalized.split('\n')
  return {
    type: 'doc',
    content: lines.map((line) => (
      line
        ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
        : { type: 'paragraph' }
    )),
  }
}

export function parseDocumentInput(rawContent: unknown, rawFormat?: unknown): DocumentContent {
  const format: ContentFormat = rawFormat === 'text' || rawFormat === 'html' || rawFormat === 'tiptap' || rawFormat === 'markdown'
    ? rawFormat
    : (typeof rawContent === 'object' && rawContent !== null ? 'tiptap' : 'markdown')

  if (format === 'tiptap') {
    if (!rawContent || typeof rawContent !== 'object' || Array.isArray(rawContent)) {
      throw new Error('Expected a valid TipTap JSON document object.')
    }
    const candidate = rawContent as DocumentContent
    checkDocument(candidate)
    // Round-trip through safe HTML sanitizer to guarantee zero non-schema or unsafe markup.
    const sanitized = fromMarkup(cleanMarkup(inertMarkup(toMarkup(candidate))))
    checkDocument(sanitized)
    return sanitized
  }

  if (typeof rawContent !== 'string') {
    throw new Error('Chapter content must be a string when format is text, markdown, or html.')
  }

  let doc: DocumentContent
  if (format === 'text') {
    doc = plainTextToDocument(rawContent)
  } else if (format === 'html') {
    doc = fromMarkup(cleanMarkup(inertMarkup(rawContent)))
  } else {
    doc = fromMarkup(cleanMarkup(inertMarkup(markdown.render(rawContent))))
  }
  checkDocument(doc)
  return doc
}

export function formatChapterOutput(chapter: ChapterRecord, title: string, requestedFormat: unknown) {
  const format: ContentFormat | 'all' =
    requestedFormat === 'text' || requestedFormat === 'markdown' || requestedFormat === 'html' || requestedFormat === 'tiptap' || requestedFormat === 'all'
      ? requestedFormat
      : 'all'

  const words = wordCount(chapter.content)
  const text = chapterText(chapter.content, '\n')
  const html = toMarkup(chapter.content)

  const base = {
    id: chapter.id,
    title,
    revision: chapter.revision,
    words,
  }

  if (format === 'text') return { ...base, content: text, format: 'text' }
  if (format === 'html') return { ...base, content: html, format: 'html' }
  if (format === 'tiptap') return { ...base, content: chapter.content, format: 'tiptap' }
  if (format === 'markdown') return { ...base, content: text, html, format: 'markdown' }
  return {
    ...base,
    text,
    html,
    tiptap: chapter.content,
  }
}

function tokenizeForSimilarity(text: string): string[] {
  const normalized = text.toLowerCase().normalize('NFKC')
  const matches = normalized.match(/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]|[\p{L}\p{N}]+/gu)
  return matches ?? []
}

function buildBigramCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  if (tokens.length === 0) return counts
  if (tokens.length === 1) {
    counts.set(tokens[0], 1)
    return counts
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    const gram = `${tokens[i]}\u0000${tokens[i + 1]}`
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

/** Measures how much of baselineText's token-bigram multiset is retained in targetText (0..1). */
export function computeTextRetention(baselineText: string, targetText: string): number {
  const beforeTokens = tokenizeForSimilarity(baselineText)
  if (beforeTokens.length === 0) return 1
  const afterTokens = tokenizeForSimilarity(targetText)
  if (afterTokens.length === 0) return 0
  const beforeGrams = buildBigramCounts(beforeTokens)
  const afterGrams = buildBigramCounts(afterTokens)
  let totalBefore = 0
  let overlap = 0
  for (const [gram, count] of beforeGrams) {
    totalBefore += count
    const afterCount = afterGrams.get(gram) ?? 0
    if (afterCount > 0) overlap += Math.min(count, afterCount)
  }
  return totalBefore === 0 ? 1 : overlap / totalBefore
}

export interface DestructiveEvaluation {
  destructive: boolean
  reason: string
  retention?: number
}

export function evaluateDestructiveWords(beforeWords: number, afterWords: number, peakWords: number): { destructive: boolean; reason: string } {
  const lostFromBefore = Math.max(0, beforeWords - afterWords)
  const effectivePeak = Math.max(beforeWords, peakWords)
  const lostFromPeak = Math.max(0, effectivePeak - afterWords)

  // Clearing any non-empty chapter (even 1-4 words) to empty must require confirmation.
  if (beforeWords > 0 && afterWords === 0) {
    return { destructive: true, reason: 'chapter_cleared_to_empty' }
  }
  if (beforeWords >= 20 && afterWords <= 3) {
    return { destructive: true, reason: 'chapter_reduced_to_stub' }
  }
  if (beforeWords >= 100 && lostFromBefore >= 80 && lostFromBefore / beforeWords >= 0.5) {
    return { destructive: true, reason: 'single_update_massive_loss' }
  }
  if (effectivePeak >= 100 && lostFromPeak >= 100 && lostFromPeak / effectivePeak >= 0.65 && afterWords < beforeWords) {
    return { destructive: true, reason: 'cumulative_massive_loss' }
  }
  if (effectivePeak >= 20 && afterWords <= 3 && beforeWords > afterWords) {
    return { destructive: true, reason: 'cumulative_reduced_to_stub' }
  }
  return { destructive: false, reason: '' }
}

/** Evaluates word loss, empty clears, and equal-word wholesale text replacements against persistent baseline. */
export function evaluateChapterMutation(params: {
  beforeText: string
  afterText: string
  beforeWords: number
  afterWords: number
  peakWords: number
  anchorText?: string
  anchorWords?: number
}): DestructiveEvaluation {
  const { beforeText, afterText, beforeWords, afterWords, peakWords, anchorText, anchorWords } = params
  if (beforeText.trim().length > 0 && afterText.trim().length === 0) {
    return { destructive: true, reason: 'chapter_cleared_to_empty', retention: 0 }
  }
  const wordCheck = evaluateDestructiveWords(beforeWords, afterWords, peakWords)
  if (wordCheck.destructive) {
    return {
      ...wordCheck,
      retention: computeTextRetention(beforeText, afterText),
    }
  }
  const singleRetention = computeTextRetention(beforeText, afterText)
  if (beforeWords >= 20 && singleRetention < 0.25) {
    return { destructive: true, reason: 'wholesale_content_replacement', retention: singleRetention }
  }
  if (beforeWords >= 10 && singleRetention < 0.15) {
    return { destructive: true, reason: 'wholesale_content_replacement', retention: singleRetention }
  }
  if (anchorText && (anchorWords ?? 0) >= 40 && afterWords >= 20) {
    const cumulativeRetention = computeTextRetention(anchorText, afterText)
    if (cumulativeRetention < 0.20) {
      return { destructive: true, reason: 'cumulative_wholesale_replacement', retention: cumulativeRetention }
    }
  }
  return { destructive: false, reason: '', retention: singleRetention }
}

export function assessChapterUpdate(
  clientId: string,
  library: string,
  bookId: string,
  editionId: string,
  chapter: ChapterRecord,
  nextContent: DocumentContent,
  persistedBaseline?: { peakWords: number; anchorWords: number; anchorText: string },
): DestructiveAssessment {
  const key = baselineKey(clientId, library, bookId, editionId, chapter.id)
  const beforeWords = wordCount(chapter.content)
  const afterWords = wordCount(nextContent)
  const tracked = chapterBaselines.get(key)
  const baselineWords = Math.max(tracked ?? 0, persistedBaseline?.peakWords ?? 0, beforeWords)

  const check = evaluateChapterMutation({
    beforeText: chapterText(chapter.content, '\n\n'),
    afterText: chapterText(nextContent, '\n\n'),
    beforeWords,
    afterWords,
    peakWords: baselineWords,
    anchorText: persistedBaseline?.anchorText,
    anchorWords: persistedBaseline?.anchorWords,
  })
  return {
    destructive: check.destructive,
    reason: check.reason,
    beforeWords,
    afterWords,
    lostWords: Math.max(0, beforeWords - afterWords),
    baselineWords,
    retention: check.retention,
  }
}

export function commitChapterBaseline(
  clientId: string,
  library: string,
  bookId: string,
  editionId: string,
  chapterId: string,
  observedPeakWords: number,
  newWords: number,
  resetToNew = false,
): void {
  const key = baselineKey(clientId, library, bookId, editionId, chapterId)
  if (resetToNew) {
    setBaseline(key, newWords)
    return
  }
  const previous = chapterBaselines.get(key) ?? 0
  setBaseline(key, Math.max(previous, observedPeakWords, newWords))
}

export function assessBatchEditionUpdate(
  existingInfos: readonly ChapterInfo[],
  existingInputs: readonly ChapterInput[],
  incomingChapters: readonly { id?: string; content: DocumentContent }[],
  persistedBaselines?: ReadonlyMap<string, { peakWords: number; anchorWords: number; anchorText: string }>,
): { destructive: boolean; reason: string; beforeWords: number; afterWords: number; lostWords: number; removedChapters: number; retention?: number } {
  const existingById = new Map<string, ChapterInput>()
  existingInfos.forEach((info, index) => {
    const input = existingInputs[index]
    if (input) existingById.set(info.id, input)
  })
  const incomingIds = new Set(incomingChapters.map((c) => c.id).filter((id): id is string => typeof id === 'string'))

  let removedChapters = 0
  for (const existing of existingInfos) {
    if (!incomingIds.has(existing.id)) removedChapters++
  }

  const beforeWords = existingInputs.reduce((sum, ch) => sum + wordCount(ch.content), 0)
  const afterWords = incomingChapters.reduce((sum, ch) => sum + wordCount(ch.content), 0)
  const lostWords = Math.max(0, beforeWords - afterWords)

  if (existingInfos.length > 0 && incomingChapters.length === 0) {
    return { destructive: true, reason: 'edition_emptied', beforeWords, afterWords, lostWords, removedChapters }
  }
  if (removedChapters > 0) {
    return { destructive: true, reason: 'chapters_omitted_in_batch', beforeWords, afterWords, lostWords, removedChapters }
  }

  for (const incoming of incomingChapters) {
    if (!incoming.id) continue
    const prior = existingById.get(incoming.id)
    if (!prior) continue
    const baseline = persistedBaselines?.get(incoming.id)
    const priorWords = wordCount(prior.content)
    const nextWords = wordCount(incoming.content)
    const single = evaluateChapterMutation({
      beforeText: chapterText(prior.content, '\n\n'),
      afterText: chapterText(incoming.content, '\n\n'),
      beforeWords: priorWords,
      afterWords: nextWords,
      peakWords: Math.max(baseline?.peakWords ?? 0, priorWords),
      anchorText: baseline?.anchorText,
      anchorWords: baseline?.anchorWords,
    })
    if (single.destructive) {
      return { destructive: true, reason: single.reason, beforeWords, afterWords, lostWords, removedChapters, retention: single.retention }
    }
  }

  if (beforeWords >= 100 && lostWords >= 80 && lostWords / beforeWords >= 0.4) {
    return { destructive: true, reason: 'batch_massive_loss', beforeWords, afterWords, lostWords, removedChapters }
  }

  return { destructive: false, reason: '', beforeWords, afterWords, lostWords, removedChapters }
}
