import { ai } from '../ai-provider'
import type { AiError, AiRun, GenerateRequest } from '../ai-provider'
import { locale } from '../i18n'

const zh = () => locale === 'zh-CN'

// ——— Proofreading ———

/** How many characters of text one proofreading request carries. */
export const proofreadBudget = 2500

/** Groups consecutive paragraphs into requests of about `budget` characters each. */
export function proofreadChunks(texts: readonly string[], budget = proofreadBudget) {
  const chunks: { start: number; count: number }[] = []
  let size = 0
  for (const [index, text] of texts.entries()) {
    const last = chunks[chunks.length - 1]
    if (last && size + text.length <= budget) { last.count++; size += text.length; continue }
    chunks.push({ start: index, count: 1 })
    size = text.length
  }
  return chunks
}

export function proofreadMessages(texts: readonly string[]) {
  const system = zh()
    ? [
      '你是一位严谨的中文校对编辑，只检查错别字、病句（语法错误、成分残缺或搭配不当）和标点错误。',
      '只改确实有错的地方；不要润色、改写风格、调整用词偏好或修改人名设定。',
      '用户给出的每段前有编号 [n]。输出一个 JSON 数组，不要任何其他文字或代码块标记：',
      '[{"p": 段落编号, "before": "出错片段前紧挨着的两到六个字，用于定位，可为空字符串", "original": "出错的片段，必须逐字照抄原文，尽量短", "replacement": "改正后的片段", "reason": "很短的说明"}]',
      '同一处错误只写一次。没有发现问题时输出 []。',
    ]
    : [
      'You are a careful proofreader. Check only for spelling mistakes, grammatical errors and punctuation errors.',
      'Change only what is actually wrong; do not polish, restyle, change word preferences or alter names and setting.',
      'Each paragraph from the user starts with a number [n]. Output one JSON array and nothing else, no code fences:',
      '[{"p": paragraph number, "before": "the two to six characters right before the error, to locate it; may be empty", "original": "the erroneous text, copied exactly from the paragraph, as short as possible", "replacement": "the corrected text", "reason": "a very short note"}]',
      'List each error once. Output [] if there are none.',
    ]
  return [
    { role: 'system' as const, text: system.join('\n') },
    { role: 'user' as const, text: texts.map((text, index) => `[${index + 1}] ${text}`).join('\n') },
  ]
}

export interface ProofreadEdit {
  block: number
  original: string
  replacement: string
  before?: string
  reason?: string
}

/** Reads a proofreading reply; `offset` is the index of the chunk's first paragraph. */
export function parseProofread(reply: string, offset: number, count: number): ProofreadEdit[] {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('invalid')
  const parsed: unknown = JSON.parse(reply.slice(start, end + 1))
  if (!Array.isArray(parsed)) throw new Error('invalid')
  const edits: ProofreadEdit[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const { p, original, replacement, before, reason } = item as Record<string, unknown>
    const index = typeof p === 'number' ? p : Number(p)
    if (!Number.isInteger(index) || index < 1 || index > count) continue
    if (typeof original !== 'string' || typeof replacement !== 'string' || !original) continue
    edits.push({
      block: offset + index - 1, original, replacement,
      ...(typeof before === 'string' && before ? { before } : {}),
      ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim().slice(0, 200) } : {}),
    })
  }
  return edits
}

// ——— Summaries ———

export type SummaryScope = 'selection' | 'chapter' | 'book'
/** Changing the chapter prompt below means bumping this, so cached summaries are made again. */
export const chapterPromptVersion = 'chapter-summary-1'

export function summaryMessages(scope: 'selection' | 'chapter', text: string, title?: string) {
  const system = zh()
    ? `你是小说编辑助手。请用简洁的中文概括用户给出的${scope === 'chapter' ? '这一章' : '这段文字'}：主要情节、出场人物和他们的变化、埋下的伏笔或悬念。分几个要点写，总字数不超过原文的五分之一，最多四百字。不要评价文笔，不要大段引用原文。`
    : `You are a fiction editor's assistant. Summarise ${scope === 'chapter' ? 'this chapter' : 'this passage'} concisely: main events, the characters who appear and how they change, and any foreshadowing or open questions. Use a few bullet points, no more than a fifth of the original and at most 250 words. Do not critique the writing or quote long passages.`
  return [
    { role: 'system' as const, text: system },
    { role: 'user' as const, text: title ? `${title}\n\n${text}` : text },
  ]
}

/** One part of a long chapter, summarised on its own before the parts are joined. */
function chapterPartMessages(title: string, text: string, part: number, parts: number) {
  const system = zh()
    ? `你在为一部小说逐章做摘要。下面是「${title}」的第 ${part}/${parts} 部分。用三到六个要点概括其中发生的事、出场人物和伏笔，不超过两百字。`
    : `You are summarising a novel chapter by chapter. Below is part ${part} of ${parts} of "${title}". Summarise what happens, who appears and any foreshadowing in three to six bullet points, under 150 words.`
  return [{ role: 'system' as const, text: system }, { role: 'user' as const, text }]
}

function chapterJoinMessages(title: string, parts: readonly string[]) {
  const system = zh()
    ? `下面是「${title}」各部分的摘要。把它们合并成这一章的一份完整摘要：三到八个要点，不超过三百字，按情节顺序。`
    : `Below are summaries of the parts of "${title}". Merge them into one summary of the chapter: three to eight bullet points, under 200 words, in story order.`
  return [{ role: 'system' as const, text: system }, { role: 'user' as const, text: parts.map((part, index) => `(${index + 1}) ${part}`).join('\n\n') }]
}

export function bookMessages(bookTitle: string, chapters: readonly { title: string; summary: string }[]) {
  const system = zh()
    ? `下面是小说《${bookTitle}》各章的摘要。请写出整本书的总结：故事梗概、主要人物及其关系和变化、主要矛盾与主题、尚未解决的伏笔。分小标题书写，简洁清楚。`
    : `Below are chapter summaries of the novel "${bookTitle}". Write a summary of the whole book: an outline of the story, the main characters with their relationships and arcs, the central conflicts and themes, and unresolved threads. Use short headings and keep it clear.`
  return [
    { role: 'system' as const, text: system },
    { role: 'user' as const, text: chapters.map((chapter) => `## ${chapter.title}\n${chapter.summary}`).join('\n\n') },
  ]
}

export type Outcome = { ok: true; text: string; finishReason?: string } | { ok: false; error?: AiError; cancelled?: boolean }

/** Runs a request to the end without showing it as it streams. */
export async function collect(run: AiRun): Promise<Outcome> {
  for await (const event of run.events) {
    if (event.type === 'done') return { ok: true, text: event.text, finishReason: event.finishReason }
    if (event.type === 'cancelled') return { ok: false, cancelled: true }
    if (event.type === 'error') return { ok: false, error: event.error }
  }
  return { ok: false, cancelled: true }
}

export interface BookProgress {
  done: number
  total: number
  cached: number
  title: string
}

/**
 * Summarises every chapter for a book summary, reusing cached summaries of chapters whose text,
 * model and prompt are unchanged. `track` receives each request so it can be stopped.
 */
export async function chapterSummaries(chapters: readonly { title: string; text: string }[], options: {
  profileId?: string
  track: (run: AiRun) => void
  progress: (state: BookProgress) => void
  stopped: () => boolean
}): Promise<{ ok: true; summaries: { title: string; summary: string }[]; cached: number } | { ok: false; error?: AiError; cancelled?: boolean }> {
  const summaries: { title: string; summary: string }[] = []
  let cached = 0
  const generate = async (request: GenerateRequest) => {
    const run = ai.generate({ ...request, stream: false })
    options.track(run)
    return collect(run)
  }
  for (const [index, chapter] of chapters.entries()) {
    if (options.stopped()) return { ok: false, cancelled: true }
    options.progress({ done: index, total: chapters.length, cached, title: chapter.title })
    const text = `${chapter.title}\n\n${chapter.text}`
    let summary: string | undefined
    for (let attempt = 0; attempt < 2 && summary === undefined; attempt++) {
      const plan = await ai.prepareChapterSummary({ feature: 'bookSummary', profileId: options.profileId, text, promptVersion: chapterPromptVersion, reservedPromptTokens: 400 })
      if (!plan.ok) return { ok: false, error: plan.error }
      if (plan.data.hit) { summary = plan.data.summary; cached++; break }
      const { route, chunks, cacheToken } = plan.data
      const parts: string[] = []
      let changed = false
      for (const [part, chunk] of chunks.entries()) {
        const outcome = await generate({ ...route, messages: chunks.length === 1 ? summaryMessages('chapter', chunk.text) : chapterPartMessages(chapter.title, chunk.text, part + 1, chunks.length) })
        if (!outcome.ok) {
          if (outcome.error?.code === 'profile_changed') { changed = true; break }
          return outcome
        }
        parts.push(outcome.text.trim())
      }
      if (changed) continue
      let joined = parts[0] ?? ''
      if (parts.length > 1) {
        const outcome = await generate({ ...route, messages: chapterJoinMessages(chapter.title, parts) })
        if (!outcome.ok) {
          if (outcome.error?.code === 'profile_changed') continue
          return outcome
        }
        joined = outcome.text.trim()
      }
      summary = joined
      // A cache cleared meanwhile refuses the write; the summary is still good for this run.
      await ai.saveChapterSummary(cacheToken, joined)
    }
    if (summary === undefined) return { ok: false, error: { code: 'profile_changed', message: '' } }
    summaries.push({ title: chapter.title, summary })
  }
  options.progress({ done: chapters.length, total: chapters.length, cached, title: '' })
  return { ok: true, summaries, cached }
}
