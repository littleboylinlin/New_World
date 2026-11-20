import { Extension } from '@tiptap/core'
import { Fragment, Mark, Slice } from '@tiptap/pm/model'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import { diffText, splitAtBoundaries } from '../ai/text-diff'
import { t } from '../i18n'

/**
 * One suggested change, in document positions. A text change replaces `[from, to)` with `insert`
 * inside one run of the same format; a block change (used when the reply's paragraphs don't line up
 * with the original's) replaces the whole range with plain paragraphs.
 */
export interface Suggestion {
  id: string
  from: number
  to: number
  insert: string
  paragraphs?: string[]
  /** Why the change is suggested, e.g. a proofreading note. */
  note?: string
}

interface SuggestionState {
  items: Suggestion[]
  /** Suggestions dropped because the text under them was edited. */
  stale: number
}

type Meta =
  | { type: 'set'; items: Suggestion[] }
  | { type: 'clear' }
  | { type: 'remove'; ids: string[]; applied: boolean }

export interface SuggestionHandlers {
  accept: (id: string) => void
  reject: (id: string) => void
  /** Called after every change to the list, with what is left. */
  changed: (state: { items: readonly Suggestion[]; stale: number }) => void
}

const key = new PluginKey<SuggestionState>('aiSuggestions')
const handlers = new WeakMap<EditorView, SuggestionHandlers>()
const empty: SuggestionState = { items: [], stale: 0 }

function mapItems(tr: Transaction, value: SuggestionState, own: boolean): SuggestionState {
  const items: Suggestion[] = []
  let stale = value.stale
  for (const item of value.items) {
    let { from, to } = item
    let touched = false
    for (const map of tr.mapping.maps) {
      // An edit by the user that reaches a suggestion makes it meaningless; our own applying of a
      // neighbour only moves it.
      if (!own) map.forEach((start, end) => { if (start <= to && end >= from) touched = true })
      from = map.map(from, 1)
      to = Math.max(from, map.map(to, -1))
    }
    if (touched) stale++
    else items.push({ ...item, from, to })
  }
  return { items, stale }
}

function widget(view: EditorView, item: Suggestion, index: number) {
  const box = document.createElement('span')
  box.className = 'ai-sg-widget'
  box.contentEditable = 'false'
  box.dataset.suggestion = item.id
  if (item.note) box.title = item.note
  const text = item.paragraphs ? item.paragraphs.join('\n') : item.insert
  if (item.note) {
    const note = document.createElement('span')
    note.className = 'ai-sg-note'
    note.textContent = item.note
    box.append(note)
  }
  if (text) {
    const added = document.createElement('ins')
    added.className = item.paragraphs ? 'ai-sg-ins ai-sg-block' : 'ai-sg-ins'
    added.textContent = text
    box.append(added)
  }
  const actions = document.createElement('span')
  actions.className = 'ai-sg-actions'
  for (const [kind, label, glyph] of [
    ['accept', t('aiAssist.acceptOne', [index + 1]) + (item.note ? `：${item.note}` : ''), '✓'],
    ['reject', t('aiAssist.rejectOne', [index + 1]), '✕'],
  ] as const) {
    const control = document.createElement('button')
    control.type = 'button'
    control.className = `ai-sg-${kind}`
    control.textContent = glyph
    control.title = label
    control.setAttribute('aria-label', label)
    control.addEventListener('mousedown', (event) => event.preventDefault())
    control.addEventListener('click', (event) => {
      event.preventDefault()
      handlers.get(view)?.[kind](item.id)
    })
    actions.append(control)
  }
  box.append(actions)
  return box
}

function decorations(state: EditorState) {
  const value = key.getState(state)
  if (!value?.items.length) return DecorationSet.empty
  const list: Decoration[] = []
  value.items.forEach((item, index) => {
    if (item.to > item.from) list.push(Decoration.inline(item.from, item.to, { class: 'ai-sg-del', 'data-suggestion': item.id }))
    list.push(Decoration.widget(item.to, (view) => widget(view, item, index), {
      side: 1, key: `${item.id}:${index}`, ignoreSelection: true, stopEvent: () => true,
    }))
  })
  return DecorationSet.create(state.doc, list)
}

export const AiSuggestions = Extension.create({
  name: 'aiSuggestions',
  addProseMirrorPlugins() {
    return [new Plugin<SuggestionState>({
      key,
      state: {
        init: () => empty,
        apply(tr, value) {
          const meta = tr.getMeta(key) as Meta | undefined
          if (meta?.type === 'set') return { items: meta.items, stale: 0 }
          if (meta?.type === 'clear') return empty
          let next = value
          if (meta?.type === 'remove') next = { ...value, items: value.items.filter((item) => !meta.ids.includes(item.id)) }
          if (tr.docChanged && next.items.length) next = mapItems(tr, next, meta?.type === 'remove' && meta.applied)
          return next
        },
      },
      props: { decorations },
      view: (view) => ({
        update(_, previous) {
          const now = key.getState(view.state)
          if (now && now !== key.getState(previous)) handlers.get(view)?.changed({ items: now.items, stale: now.stale })
        },
      }),
    })]
  },
})

// ——— Reading the selection ———

/** A textblock's selected text, with the document position of every character. */
export interface TextBlock {
  text: string
  /** `positions[i]` is where character i starts; the last entry is where the block's text ends. */
  positions: number[]
  /** Offsets where the format changes or a non-text item (image, line break) sits. */
  boundaries: number[]
}

export function readBlocks(doc: ProseNode, from: number, to: number): TextBlock[] {
  const blocks: TextBlock[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true
    const start = Math.max(from, pos + 1)
    const end = Math.min(to, pos + 1 + node.content.size)
    if (end < start) return false
    const block: TextBlock = { text: '', positions: [], boundaries: [] }
    let previous: readonly Mark[] | null = null
    node.forEach((child, offset) => {
      const childStart = pos + 1 + offset
      const childEnd = childStart + child.nodeSize
      if (childEnd <= start || childStart >= end) return
      if (!child.isText) {
        if (block.text.length) block.boundaries.push(block.text.length)
        previous = null
        return
      }
      const from = Math.max(start, childStart)
      const until = Math.min(end, childEnd)
      if (previous && !Mark.sameSet(previous, child.marks) && block.text.length) block.boundaries.push(block.text.length)
      previous = child.marks
      const piece = child.text!.slice(from - childStart, until - childStart)
      for (let i = 0; i < piece.length; i++) block.positions.push(from + i)
      block.text += piece
    })
    block.positions.push(block.positions.length ? block.positions[block.positions.length - 1]! + 1 : start)
    if (block.text.trim()) blocks.push(block)
    return false
  })
  return blocks
}

/** The selected paragraphs as plain text, one per line, ready to send. */
export function blocksText(blocks: readonly TextBlock[]) {
  return blocks.map((block) => block.text).join('\n')
}

/** Splits a reply into paragraphs the same way the request joined them. */
export function replyParagraphs(reply: string) {
  return reply.replace(/\r\n?/g, '\n').split(/\n+/).map((line) => line.trim()).filter(Boolean)
}

let sequence = 0
const nextId = () => `sg${++sequence}`

function docRange(block: TextBlock, from: number, to: number) {
  const start = block.positions[from]!
  // Ends right after the last replaced character, so an image or break after it stays out.
  const end = to > from ? block.positions[to - 1]! + 1 : start
  return { from: start, to: end }
}

/**
 * Turns a rewritten reply into suggestions. When the reply has as many paragraphs as the
 * selection, each paragraph is compared with its original and every change is cut at format
 * boundaries; otherwise the whole selection becomes one block change.
 */
export function suggestionsFor(blocks: readonly TextBlock[], reply: string): Suggestion[] {
  const paragraphs = replyParagraphs(reply)
  if (!blocks.length || !paragraphs.length) return []
  if (paragraphs.length !== blocks.length) {
    const first = blocks[0]!
    const last = blocks[blocks.length - 1]!
    return [{ id: nextId(), from: first.positions[0]!, to: last.positions[last.positions.length - 1]!, insert: '', paragraphs }]
  }
  const items: Suggestion[] = []
  blocks.forEach((block, index) => {
    const original = block.text.trim()
    const lead = block.text.indexOf(original)
    const boundaries = block.boundaries.map((at) => at - lead)
    for (const hunk of diffText(original, paragraphs[index]!, { boundaries })) {
      const shifted = { from: hunk.from + lead, to: hunk.to + lead, insert: hunk.insert }
      for (const piece of splitAtBoundaries(block.text, shifted, block.boundaries)) {
        items.push({ id: nextId(), ...docRange(block, piece.from, piece.to), insert: piece.insert })
      }
    }
  })
  return items
}

/**
 * Suggestions located by quoting: each names the paragraph (by index among `blocks`) and the exact
 * original text, optionally with text before it to pick the right occurrence. Used by proofreading.
 */
export function suggestionsFromEdits(blocks: readonly TextBlock[], edits: readonly { block: number; original: string; replacement: string; before?: string; reason?: string }[]) {
  const items: Suggestion[] = []
  for (const edit of edits) {
    const block = blocks[edit.block]
    if (!block || !edit.original || edit.original === edit.replacement) continue
    let at = -1
    if (edit.before) {
      const anchor = block.text.indexOf(edit.before + edit.original)
      if (anchor >= 0) at = anchor + edit.before.length
    }
    if (at < 0) {
      at = block.text.indexOf(edit.original)
      // Ambiguous without context: leave it rather than change the wrong place.
      if (at < 0 || block.text.indexOf(edit.original, at + 1) >= 0) continue
    }
    for (const hunk of diffText(edit.original, edit.replacement)) {
      const shifted = { from: hunk.from + at, to: hunk.to + at, insert: hunk.insert }
      for (const piece of splitAtBoundaries(block.text, shifted, block.boundaries)) {
        items.push({ id: nextId(), ...docRange(block, piece.from, piece.to), insert: piece.insert, ...(edit.reason ? { note: edit.reason } : {}) })
      }
    }
  }
  return items.sort((a, b) => a.from - b.from).filter((item, index, all) => !index || item.from >= all[index - 1]!.to)
}

// ——— Showing and applying ———

export function showSuggestions(view: EditorView, items: Suggestion[], on: SuggestionHandlers) {
  handlers.set(view, on)
  view.dispatch(view.state.tr.setMeta(key, { type: 'set', items } satisfies Meta).setMeta('addToHistory', false))
}

export function currentSuggestions(state: EditorState) {
  return key.getState(state) ?? empty
}

export function clearSuggestions(view: EditorView) {
  if (view.isDestroyed) return
  if (!currentSuggestions(view.state).items.length && !currentSuggestions(view.state).stale) return
  view.dispatch(view.state.tr.setMeta(key, { type: 'clear' } satisfies Meta).setMeta('addToHistory', false))
}

function apply(tr: Transaction, item: Suggestion) {
  const schema = tr.doc.type.schema
  if (item.paragraphs) {
    const nodes = item.paragraphs.map((text) => schema.nodes.paragraph!.create(null, text ? schema.text(text) : null))
    tr.replace(item.from, item.to, new Slice(Fragment.fromArray(nodes), 1, 1))
    return
  }
  if (!item.insert) { tr.delete(item.from, item.to); return }
  const $from = tr.doc.resolve(item.from)
  const marks = item.to > item.from ? $from.marksAcross(tr.doc.resolve(item.to)) ?? Mark.none : $from.marks()
  tr.replaceWith(item.from, item.to, schema.text(item.insert, marks))
}

/** Applies one suggestion as its own undoable step. */
export function acceptSuggestion(view: EditorView, id: string) {
  const item = currentSuggestions(view.state).items.find((entry) => entry.id === id)
  if (!item) return false
  const tr = view.state.tr
  apply(tr, item)
  view.dispatch(tr.setMeta(key, { type: 'remove', ids: [id], applied: true } satisfies Meta))
  return true
}

export function rejectSuggestion(view: EditorView, id: string) {
  view.dispatch(view.state.tr.setMeta(key, { type: 'remove', ids: [id], applied: false } satisfies Meta).setMeta('addToHistory', false))
}

/** Applies every suggestion left as one undoable step. */
export function acceptAll(view: EditorView) {
  const items = [...currentSuggestions(view.state).items].sort((a, b) => b.from - a.from)
  if (!items.length) return false
  const tr = view.state.tr
  for (const item of items) apply(tr, item)
  view.dispatch(tr.setMeta(key, { type: 'remove', ids: items.map((item) => item.id), applied: true } satisfies Meta))
  return true
}

/** Adds the reply as new paragraphs after the textblock that holds `pos`. */
export function insertParagraphsAfter(view: EditorView, pos: number, paragraphs: readonly string[]) {
  const { state } = view
  const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size))
  let depth = $pos.depth
  while (depth > 0 && !$pos.node(depth).isTextblock) depth--
  const at = depth > 0 ? $pos.after(depth) : state.doc.content.size
  const schema = state.schema
  const nodes = paragraphs.map((text) => schema.nodes.paragraph!.create(null, text ? schema.text(text) : null))
  view.dispatch(state.tr.insert(at, Fragment.fromArray(nodes)).scrollIntoView())
}
