/** Reading metadata is stored beside its owner, never inside the document tree. */
export interface ReadingAnchor {
  version: 1
  kind: 'document' | 'text'
  from: number
  to: number
  quote: string
  sourceHash: string
}

export interface ReadingAnnotation {
  id: string
  anchor: ReadingAnchor
  text: string
  color: string
  display: 'inline' | 'mark'
  collapsed: boolean
  createdAt: number
}

export interface ReadingAnnotations {
  revision: number
  items: ReadingAnnotation[]
}

export const maxAnnotationLength = 10_000
export const annotationColors = ['#f5c542', '#83c995', '#78b8ed', '#c39bea', '#ed9bb2']
export const emptyAnnotations = (): ReadingAnnotations => ({ revision: 0, items: [] })

export async function sourceHash(source: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function validColor(color: string) { return /^#[\da-f]{6}$/i.test(color) }

export function anchorMatches(anchor: ReadingAnchor, hash: string, kind: ReadingAnchor['kind'], size: number, quote: (from: number, to: number) => string) {
  return anchor?.version === 1 && anchor.kind === kind && anchor.sourceHash === hash
    && Number.isInteger(anchor.from) && Number.isInteger(anchor.to)
    && anchor.from >= 0 && anchor.to > anchor.from && anchor.to <= size
    && quote(anchor.from, anchor.to) === anchor.quote
}

/** Split overlaps into disjoint runs. Every run retains all owners, in a stable order. */
export function annotationSegments(items: ReadingAnnotation[]) {
  const events = new Map<number, { add: ReadingAnnotation[]; remove: ReadingAnnotation[] }>()
  for (const item of items) {
    for (const [at, action] of [[item.anchor.from, 'add'], [item.anchor.to, 'remove']] as const) {
      if (!events.has(at)) events.set(at, { add: [], remove: [] })
      events.get(at)![action].push(item)
    }
  }
  const active = new Map<string, ReadingAnnotation>()
  const segments: { from: number; to: number; items: ReadingAnnotation[] }[] = []
  const positions = [...events.keys()].sort((a, b) => a - b)
  for (let i = 0; i < positions.length - 1; i++) {
    const from = positions[i]
    for (const item of events.get(from)!.remove) active.delete(item.id)
    for (const item of events.get(from)!.add) active.set(item.id, item)
    if (active.size) segments.push({ from, to: positions[i + 1], items: [...active.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) })
  }
  return segments
}

export function markAttributes(items: ReadingAnnotation[]) {
  const colors = items.map((item) => validColor(item.color) ? item.color : annotationColors[0])
  const stops = colors.map((color, i) => `color-mix(in srgb, ${color} 26%, transparent) ${i / colors.length * 100}% ${(i + 1) / colors.length * 100}%`)
  return {
    class: 'annotation-mark',
    'data-annotation-ids': items.map((item) => item.id).join(' '),
    tabindex: '0', role: 'button',
    style: colors.length === 1 ? `background: color-mix(in srgb, ${colors[0]} 26%, transparent)` : `background: linear-gradient(to bottom, ${stops.join(', ')})`,
  }
}

export interface PopupRect { left: number; top: number; right: number; bottom: number }
export function popupPosition(anchor: PopupRect, width: number, height: number, viewport: { left: number; top: number; width: number; height: number }) {
  const margin = 10
  const right = viewport.left + viewport.width - margin
  const bottom = viewport.top + viewport.height - margin
  const left = Math.max(viewport.left + margin, Math.min(anchor.left, right - width))
  const below = anchor.bottom + 8
  const top = Math.max(viewport.top + margin, Math.min(below + height <= bottom ? below : anchor.top - height - 8, bottom - height))
  return { left, top }
}

/** Reject malformed optional metadata from a damaged backup before it can decorate text. */
export function validAnnotations(value: ReadingAnnotations) {
  return Number.isSafeInteger(value?.revision) && value.revision >= 0 && Array.isArray(value.items)
    && new Set(value.items.map((item) => item?.id)).size === value.items.length
    && value.items.every((item) => item && typeof item.id === 'string' && /^[\da-f-]{36}$/i.test(item.id)
      && typeof item.text === 'string' && !!item.text.trim() && item.text.length <= maxAnnotationLength
      && typeof item.color === 'string' && validColor(item.color) && ['inline', 'mark'].includes(item.display)
      && typeof item.collapsed === 'boolean' && Number.isFinite(item.createdAt)
      && item.anchor && item.anchor.version === 1 && ['document', 'text'].includes(item.anchor.kind)
      && Number.isSafeInteger(item.anchor.from) && Number.isSafeInteger(item.anchor.to)
      && item.anchor.from >= 0 && item.anchor.to > item.anchor.from && typeof item.anchor.quote === 'string'
      && typeof item.anchor.sourceHash === 'string' && /^[\da-f]{64}$/i.test(item.anchor.sourceHash))
}
