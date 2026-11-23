const start = '[NW_CHOICES]'
const end = '[/NW_CHOICES]'

export interface Clarification {
  question: string
  options: string[]
}

export function clarificationInstructions(chinese: boolean) {
  const rules = chinese ? [
    '先查看给出的设定、摘要、正文和对话。有答案、意思清楚，或即使猜错也容易重来时，直接做，开头用一句话说明你对请求的理解。',
    '只有当存在几种合理理解且选错会造成大量返工时才追问。一次回复最多发一轮澄清，问一至三个问题；用户答过的不要重问。每个问题给两至四个可行选项，用户也可以自由回答。',
    '需要澄清时，把下面的纯文字块放在回复末尾，前面可写一句说明。使用合法 JSON，替换示例中的内容，不加代码围栏或块后文字。',
  ] : [
    'Check the supplied setting, summaries, manuscript and conversation first. If the answer is there, the request is clear, or the work is easy to redo, proceed and open with one sentence stating your interpretation.',
    'Clarify only if several interpretations are plausible and a wrong guess would require substantial rework. Ask one round of one to three questions per reply at most, and never repeat a question the user already answered. Offer two to four viable options per question; the user may also answer in their own words.',
    'To clarify, end the reply with the plain-text block below, optionally preceded by a brief explanation. Replace the example with valid JSON and omit code fences and trailing text.',
  ]
  const example = chinese
    ? [{ question: '要保留哪条线索？', options: ['失踪的船', '断掉的钥匙'] }]
    : [{ question: 'Which clue should stay?', options: ['The missing ship', 'The broken key'] }]
  return [...rules, start, JSON.stringify(example), end].join('\n')
}

/** Only consume a complete, well-formed round; keep the original text on any mismatch. */
export function parseClarification(reply: string): { text: string; questions?: Clarification[] } {
  const block = /(?:^|\r?\n)\[NW_CHOICES\][ \t]*\r?\n([\s\S]*?)\r?\n\[\/NW_CHOICES\]\s*$/.exec(reply)
  if (!block || reply.indexOf(start) !== reply.lastIndexOf(start) || reply.indexOf(end) !== reply.lastIndexOf(end)) return { text: reply }
  try {
    const items: unknown = JSON.parse(block[1])
    if (!Array.isArray(items) || items.length < 1 || items.length > 3) return { text: reply }
    const questions: Clarification[] = []
    for (const item of items) {
      if (typeof item?.question !== 'string' || !item.question.trim()
        || !Array.isArray(item.options) || item.options.length < 2 || item.options.length > 4
        || item.options.some((value: unknown) => typeof value !== 'string' || !value.trim())) return { text: reply }
      const question = item.question.trim()
      const options: string[] = item.options.map((value: string) => value.trim())
      if (new Set(options).size !== options.length || questions.some((entry) => entry.question === question)) return { text: reply }
      questions.push({ question, options })
    }
    return { text: reply.slice(0, block.index).trimEnd(), questions }
  } catch {
    return { text: reply }
  }
}
