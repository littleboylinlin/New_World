import { ai } from '../ai-provider'
import type { AiError, AiRun } from '../ai-provider'
import { locale } from '../i18n'
import { cleanStyle } from './styles'
import type { StyleInput } from './styles'

export const styleFeature = 'extension:styleAnalysis' as const
/** How much of the user's own text is sent to describe their style. */
export const excerptBudget = 6000

export type StyleSource =
  | { kind: 'author'; who: string }
  | { kind: 'own'; excerpts: string[]; basis: string }

const shape = '{"name": "…", "summary": "…", "vocabulary": "…", "rhythm": "…", "perspective": "…", "samples": ["…"]}'

function messages(source: StyleSource) {
  const zh = locale === 'zh-CN'
  const common = zh
    ? [
      '你是一位资深文学编辑，擅长分析和概括作者的文风，写成可以直接指导写作的说明。',
      `只输出一个 JSON 对象，不要任何其他文字或代码块标记，格式：${shape}`,
      'name 是这种文风的简短名称；summary 概括整体风格；vocabulary 写用词和句式特点；rhythm 写节奏和段落安排；perspective 写常用的叙事视角和人称。每项一到三句，具体、可操作。',
    ]
    : [
      'You are a senior fiction editor who analyses an author\'s style and writes it up as instructions a writer can follow.',
      `Output only one JSON object, with no other text or code fences, shaped like: ${shape}`,
      'name is a short name for the style; summary describes it overall; vocabulary covers word choice and sentences; rhythm covers pacing and paragraphing; perspective covers the usual point of view and person. One to three concrete sentences each.',
    ]
  if (source.kind === 'author') {
    return [
      {
        role: 'system' as const,
        text: [...common, zh
          ? 'samples 是两到三段你自己写的原创短段落（每段不超过 120 字），用来示范这种风格。不得引用或改写该作家作品中的任何原文。'
          : 'samples are two or three short original passages you write yourself (under 80 words each) that show the style. Never quote or paraphrase the author\'s actual text.'].join('\n'),
      },
      { role: 'user' as const, text: zh ? `请概括这位作家或这种文风：${source.who}` : `Describe the style of this author or kind of writing: ${source.who}` },
    ]
  }
  return [
    {
      role: 'system' as const,
      text: [...common, zh
        ? 'samples 从用户给出的文字中摘取两到三句最能体现风格的原句（每句不超过 120 字）。这些文字是用户自己的作品。'
        : 'samples are two or three sentences taken from the user\'s text that best show the style (under 80 words each). The text is the user\'s own work.'].join('\n'),
    },
    { role: 'user' as const, text: source.excerpts.map((excerpt, index) => `【${index + 1}】\n${excerpt}`).join('\n\n') },
  ]
}

/** Reads the JSON object in a reply, even if the model wrapped it in a code block. */
export function parseStyleReply(reply: string, source: StyleSource): StyleInput {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('invalid')
  const parsed = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>
  const zh = locale === 'zh-CN'
  const fallback = source.kind === 'author' ? (zh ? `仿${source.who}` : `After ${source.who}`) : (zh ? '我的文风' : 'My style')
  return cleanStyle({
    ...parsed,
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : fallback,
    kind: source.kind,
    basis: source.kind === 'author' ? source.who : source.basis,
  })
}

/** Takes the opening of each chapter, sharing the budget between them. */
export function excerptsFrom(texts: readonly string[], budget = excerptBudget) {
  const share = Math.floor(budget / Math.max(1, texts.length))
  return texts.map((text) => {
    const clean = text.replace(/\n{2,}/g, '\n').trim()
    if (clean.length <= share) return clean
    const cut = clean.lastIndexOf('\n', share)
    return clean.slice(0, cut > share / 2 ? cut : share)
  }).filter(Boolean)
}

export type DraftResult = { ok: true; style: StyleInput } | { ok: false; error?: AiError; cancelled?: boolean; unreadable?: boolean }

/** Asks the AI to describe a style. The run can be stopped; the result is a draft to review. */
export function draftStyle(source: StyleSource, profileId?: string): { run: AiRun; result: Promise<DraftResult> } {
  const run = ai.generate({ feature: styleFeature, profileId, messages: messages(source), stream: false })
  const result = (async (): Promise<DraftResult> => {
    for await (const event of run.events) {
      if (event.type === 'cancelled') return { ok: false, cancelled: true }
      if (event.type === 'error') return { ok: false, error: event.error }
      if (event.type === 'done') {
        try {
          return { ok: true, style: parseStyleReply(event.text, source) }
        } catch {
          return { ok: false, unreadable: true }
        }
      }
    }
    return { ok: false, cancelled: true }
  })()
  return { run, result }
}
