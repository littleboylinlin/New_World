import type { Feature } from '../ai-provider'
import { locale } from '../i18n'

export type AssistAction = 'polish' | 'rewrite' | 'expand' | 'shorten' | 'tone' | 'ask'
export type Tone = 'formal' | 'casual' | 'gentle' | 'cold' | 'humorous' | 'tense'

export const assistFeatures: Record<AssistAction, Feature> = {
  polish: 'polish',
  rewrite: 'extension:rewrite',
  expand: 'extension:expand',
  shorten: 'extension:shorten',
  tone: 'extension:tone',
  ask: 'ask',
}

/** Actions whose reply replaces the selection and is shown as changes to accept one by one. */
export const editingActions: readonly AssistAction[] = ['polish', 'rewrite', 'expand', 'shorten', 'tone']

const zh = {
  base: (count: number, keep: boolean) => [
    '你是一位经验丰富的小说编辑，正在帮作者修改正文。',
    '只输出修改后的正文本身：不要解释，不要标题，不要加引号、编号或 Markdown 标记。',
    keep
      ? `原文共 ${count} 段，每段占一行。输出也必须正好是 ${count} 段、每段一行，并与原文逐段对应；不要合并或拆分段落。`
      : `原文共 ${count} 段，每段占一行。输出时每段也占一行，可以按需要增加段落。`,
    '保持原文使用的语言、人称、时态、人名地名和对话格式；段首缩进保持原样。',
  ],
  polish: '润色这段文字：修正不通顺、重复和用词不当的地方，让语句更流畅、准确、有画面感，尽量少改动情节与原意，不要换掉作者的语气。',
  rewrite: '改写这段文字：情节和信息不变，换一种表达方式重新写，可以调整句式和用词。',
  expand: '扩写这段文字：在不改变情节走向的前提下，补充细节、动作、感官描写和心理活动，篇幅大约扩到原来的一倍半到两倍。',
  shorten: '缩写这段文字：保留关键情节和信息，删去冗余与重复，篇幅大约缩到原来的一半到三分之二。',
  tone: (tone: string) => `调整这段文字的语气，改为「${tone}」，情节和信息不变。`,
  ask: '你是一位小说写作助手。用户选中了作品中的一段文字并提出问题。请结合这段文字直接回答，简洁具体；回答用用户提问的语言。不要大段复述原文。',
  askUser: (question: string, text: string) => `选中的文字：\n<<<\n${text}\n>>>\n\n问题：${question}`,
}

const en = {
  base: (count: number, keep: boolean) => [
    'You are an experienced fiction editor helping an author revise their text.',
    'Output only the revised text itself: no explanations, no headings, no quotes, numbering or Markdown.',
    keep
      ? `The original has ${count} paragraph(s), one per line. Output exactly ${count} paragraph(s), one per line, matching the original paragraph by paragraph; do not merge or split paragraphs.`
      : `The original has ${count} paragraph(s), one per line. Put each paragraph of your output on its own line; you may add paragraphs if needed.`,
    "Keep the original's language, point of view, tense, names and dialogue format, and any leading indentation.",
  ],
  polish: "Polish this text: fix awkward, repetitive or imprecise wording so it reads smoothly and vividly, changing as little of the plot and meaning as possible and keeping the author's voice.",
  rewrite: 'Rewrite this text: keep the events and information, but express them differently, varying sentences and wording.',
  expand: 'Expand this text without changing where the plot goes: add detail, action, sensory description and inner thoughts, to about one and a half to two times the length.',
  shorten: 'Shorten this text: keep the key events and information, cut redundancy and repetition, to about half to two thirds of the length.',
  tone: (tone: string) => `Change the tone of this text to "${tone}", keeping the events and information.`,
  ask: 'You are a fiction writing assistant. The user selected a passage from their work and asked a question. Answer directly and concretely with that passage in mind, in the language of the question. Do not repeat long parts of the passage.',
  askUser: (question: string, text: string) => `Selected text:\n<<<\n${text}\n>>>\n\nQuestion: ${question}`,
}

export interface PromptInput {
  action: AssistAction
  /** The selected paragraphs, one per line. */
  text: string
  paragraphs: number
  tone?: string
  question?: string
  /** Extra instructions placed before the task, such as a writing style. */
  system?: string
}

export function assistMessages(input: PromptInput) {
  const words = locale === 'zh-CN' ? zh : en
  if (input.action === 'ask') {
    return [
      { role: 'system' as const, text: [words.ask, input.system].filter(Boolean).join('\n\n') },
      { role: 'user' as const, text: words.askUser(input.question ?? '', input.text) },
    ]
  }
  const keep = input.action !== 'expand'
  const task = input.action === 'tone' ? words.tone(input.tone ?? '') : words[input.action]
  return [
    { role: 'system' as const, text: [...words.base(input.paragraphs, keep), input.system, task].filter(Boolean).join('\n') },
    { role: 'user' as const, text: input.text },
  ]
}

/** Whether a finish reason means the reply was cut off by the output limit. */
export function wasTruncated(finishReason: string | undefined) {
  return Boolean(finishReason && /length|max|incomplete/i.test(finishReason))
}
