import type { Editor } from '@tiptap/core'
import type { ChapterPlace } from './editor-prefs'

/** Where a chapter is being read in a pane: the text at the pane's top, the scroll and the selection. */
export function measurePlace(editor: Editor, scroller: HTMLElement): Omit<ChapterPlace, 'at'> {
  const view = scroller.getBoundingClientRect()
  const text = editor.view.dom.getBoundingClientRect()
  const hit = editor.view.posAtCoords({ left: text.left + Math.min(40, text.width / 2), top: Math.max(view.top + 2, text.top + 2) })
  const position = hit?.pos ?? 0
  let offset = 0
  try { offset = editor.view.coordsAtPos(position).top - view.top } catch { /* Positions outside the text fall back to the raw scroll. */ }
  const { from, to } = editor.state.selection
  return { top: position, offset, scroll: scroller.scrollTop, height: scroller.scrollHeight, from, to }
}

/** Puts a pane back where a chapter was left. A pane of another size follows the text instead. */
export function applyPlace(editor: Editor, scroller: HTMLElement, place: ChapterPlace | undefined, select = true) {
  const size = editor.state.doc.content.size
  if (!place) { scroller.scrollTop = 0; return }
  if (select && place.to <= size && place.from <= size) {
    try { editor.commands.setTextSelection({ from: place.from, to: place.to }) } catch { /* A stale place is skipped. */ }
  }
  scroller.scrollTop = place.scroll
  if (place.height !== undefined && Math.abs(place.height - scroller.scrollHeight) < 2) return
  if (place.top <= size) {
    try {
      const view = scroller.getBoundingClientRect()
      scroller.scrollTop += editor.view.coordsAtPos(place.top).top - view.top - place.offset
    } catch { /* Keeps the raw scroll. */ }
  }
}
