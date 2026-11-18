import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'

/**
 * Chromium (and so the desktop app) draws its own underline under unconfirmed input-method text.
 * There the reading only gets a light background; elsewhere it also gets a dashed underline.
 */
export const nativeImeUnderline = 'userAgentData' in navigator
document.documentElement.classList.toggle('ime-native-underline', nativeImeUnderline)

const highlightName = 'typing-composition'
const highlights = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function' ? CSS.highlights : undefined

/** Text an input method is composing, found from where it started; undefined if the DOM disagrees. */
function textRange(root: Node, from: Node, offset: number, text: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null = from
  if (!(from instanceof Text)) {
    const child = from.childNodes[offset] ?? null
    if (child instanceof Text) node = child
    else if (child) { walker.currentNode = child; node = walker.nextNode() }
    else node = nextOutside(walker, from)
    offset = 0
  }
  if (!(node instanceof Text)) return
  walker.currentNode = node
  const range = document.createRange()
  range.setStart(node, Math.min(offset, node.length))
  let remaining = text.length
  let current: Text = node
  let at = Math.min(offset, node.length)
  while (current.length - at < remaining) {
    remaining -= current.length - at
    const next = walker.nextNode()
    if (!(next instanceof Text)) return
    current = next
    at = 0
  }
  range.setEnd(current, at + remaining)
  return range.toString() === text ? range : undefined
}

function nextOutside(walker: TreeWalker, node: Node) {
  let next: Node | null = node
  while (next && !next.nextSibling) next = next.parentNode
  if (!next?.nextSibling) return null
  walker.currentNode = next.nextSibling
  return next.nextSibling instanceof Text ? next.nextSibling : walker.nextNode()
}

/** Search the text around the native caret, for engines that rebuild nodes during composition. */
function nearCaret(root: Node, text: string) {
  const selection = root.ownerDocument?.getSelection()
  const node = selection?.focusNode
  if (!(node instanceof Text) || !root.contains(node)) return
  const value = node.data
  let best = -1
  for (let index = value.indexOf(text); index >= 0; index = value.indexOf(text, index + 1)) {
    if (best < 0 || Math.abs(index + text.length - selection!.focusOffset) < Math.abs(best + text.length - selection!.focusOffset)) best = index
  }
  if (best < 0) return
  const range = document.createRange()
  range.setStart(node, best)
  range.setEnd(node, best + text.length)
  return range
}

/**
 * Marks the reading a ProseMirror editor is composing with a CSS highlight, so neither the
 * document nor the DOM the input method owns is touched.
 */
export function editorComposition(editor: Editor, changed: () => void) {
  const events = new AbortController()
  const { signal } = events
  const body = editor.view.dom
  let start: number | undefined
  let text = ''
  let range: Range | undefined

  function clear() {
    start = undefined
    text = ''
    if (range && highlights?.get(highlightName)?.has(range)) highlights.delete(highlightName)
    range = undefined
  }
  function update() {
    if (start === undefined) return
    let next: Range | undefined
    if (text) {
      const point = editor.view.domAtPos(start)
      next = textRange(body, point.node, point.offset, text) ?? nearCaret(body, text)
    }
    range = next
    if (!highlights) return
    if (next) highlights.set(highlightName, new Highlight(next))
    else highlights.delete(highlightName)
  }
  function transaction({ transaction }: { transaction: Transaction }) {
    if (start !== undefined && transaction.docChanged) start = transaction.mapping.map(start, -1)
  }

  body.addEventListener('compositionstart', () => {
    start = editor.state.selection.from
    text = ''
    update()
  }, { signal })
  body.addEventListener('compositionupdate', (event) => {
    if (start === undefined) start = editor.state.selection.from
    text = (event as CompositionEvent).data ?? ''
  }, { signal })
  // The DOM holds the new reading once input fires, still before the next paint.
  body.addEventListener('input', () => { if (start !== undefined) { update(); changed() } }, { signal })
  body.addEventListener('compositionend', () => { clear(); changed() }, { signal })
  body.addEventListener('blur', clear, { signal })
  editor.on('transaction', transaction)

  return {
    get active() { return start !== undefined },
    get range() {
      if (start !== undefined && text && !range?.toString()) update()
      return range
    },
    destroy() {
      events.abort()
      editor.off('transaction', transaction)
      clear()
    },
  }
}
