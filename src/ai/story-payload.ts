export interface CardDraft {
  name: string
  aliases: string[]
  tags: string[]
  fields: { key: string; value: string }[]
  body: string
  chapters: number[]
}

export interface CardAddition {
  cardId: string
  aliases: string[]
  fields: CardDraft['fields']
}

export interface ConflictDraft {
  paragraph: number
  original: string
  before: string
  cardId: string
  field: string
  reason: string
  replacement: string
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function line(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.trim().length <= 255 && !/[\x00-\x1f]/.test(value.trim())
}

function lines(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(line)
}

function fields(value: unknown): value is CardDraft['fields'] {
  return Array.isArray(value) && value.every((item) => object(item) && line(item.key)
    && typeof item.value === 'string' && item.value.trim())
}

function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function parse(reply: string): Record<string, unknown> | undefined {
  if (reply.length > 512_000) return
  const body = reply.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/i, '$1')
  try {
    const json: unknown = JSON.parse(body)
    return object(json) ? json : undefined
  } catch {
    return undefined
  }
}

function newCard(value: unknown): value is CardDraft {
  return object(value) && line(value.name) && lines(value.aliases) && lines(value.tags) && fields(value.fields)
    && typeof value.body === 'string' && Array.isArray(value.chapters) && value.chapters.length > 0 && value.chapters.every(number)
}

function addition(value: unknown): value is CardAddition {
  return object(value) && line(value.cardId) && lines(value.aliases) && fields(value.fields)
}

export function parseExtraction(reply: string) {
  const value = parse(reply)
  if (!Array.isArray(value?.cards) || !Array.isArray(value.additions)) return
  const cards = value.cards.filter(newCard)
  const additions = value.additions.filter(addition)
  return { cards, additions, unreadable: value.cards.length - cards.length + value.additions.length - additions.length }
}

function conflict(value: unknown): value is ConflictDraft {
  return object(value) && number(value.paragraph) && line(value.cardId) && line(value.field)
    && typeof value.original === 'string' && Boolean(value.original.trim()) && value.original.length <= 1500
    && typeof value.before === 'string' && value.before.length <= 180
    && typeof value.reason === 'string' && Boolean(value.reason.trim()) && value.reason.length <= 1500
    && typeof value.replacement === 'string' && value.replacement.length <= 1500 && !/[\r\n]/.test(value.replacement)
}

export function parseConflicts(reply: string) {
  const value = parse(reply)
  if (!Array.isArray(value?.conflicts)) return
  const conflicts = value.conflicts.filter(conflict)
  return { conflicts, unreadable: value.conflicts.length - conflicts.length }
}
