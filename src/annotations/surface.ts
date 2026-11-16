import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { annotationSegments, markAttributes } from './model'
import type { ReadingAnchor, ReadingAnnotation } from './model'

export interface ReadingSelection { from: number; to: number; quote: string; rect: DOMRect }
export interface AnnotationSurface {
  element: HTMLElement
  source: string
  kind: ReadingAnchor['kind']
  size: number
  quote: (from: number, to: number) => string
  selection: () => ReadingSelection | undefined
  render: (items: ReadingAnnotation[], card: (item: ReadingAnnotation) => HTMLElement) => void
  destroy: () => void
}

const annotationKey = new PluginKey<DecorationSet>('reading-annotations')
export const AnnotationDecorations = Extension.create({
  name: 'readingAnnotations',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: annotationKey,
      filterTransaction: (tr) => !tr.docChanged || this.editor.isEditable,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, previous) => tr.getMeta(annotationKey) ?? (tr.docChanged ? DecorationSet.empty : previous),
      },
      props: { decorations: (state) => annotationKey.getState(state) },
    })]
  },
})

function selectionRect(range: Range) {
  const view = window.visualViewport
  const top = view?.offsetTop ?? 0, bottom = top + (view?.height ?? innerHeight)
  return [...range.getClientRects()].filter((rect) => rect.height > 0 && rect.bottom >= top && rect.top <= bottom).at(-1) ?? range.getBoundingClientRect()
}

function selectedRange(root: HTMLElement) {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
  const range = selection.getRangeAt(0)
  for (const node of [range.startContainer, range.endContainer]) {
    if (!root.contains(node) || (node instanceof Element ? node : node.parentElement)?.closest('[data-annotation-ui]')) return
  }
  return range
}

export function documentSurface(editor: Editor): AnnotationSurface {
  const root = editor.view.dom
  const doc = editor.state.doc
  const quote = (from: number, to: number) => doc.textBetween(from, to, '\n', '\n')
  const set = (decorations: Decoration[]) => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(annotationKey, DecorationSet.create(editor.state.doc, decorations)).setMeta('addToHistory', false))
  }
  return {
    element: root, source: JSON.stringify(doc.toJSON()), kind: 'document', size: doc.content.size, quote,
    selection: () => {
      const range = selectedRange(root)
      if (!range) return
      try {
        const from = editor.view.posAtDOM(range.startContainer, range.startOffset, 1)
        const to = editor.view.posAtDOM(range.endContainer, range.endOffset, -1)
        const text = quote(from, to)
        if (to > from && text.trim()) return { from, to, quote: text, rect: selectionRect(range) }
      } catch { /* A selection in a removed node is no longer usable. */ }
    },
    render: (items, card) => {
      const decorations = annotationSegments(items.filter((item) => item.display === 'mark'))
        .map(({ from, to, items }) => Decoration.inline(from, to, markAttributes(items)))
      for (const item of items.filter((item) => item.display === 'inline')) {
        let end = doc.content.size
        doc.forEach((node, offset) => {
          if (item.anchor.to > offset && item.anchor.to <= offset + node.nodeSize) end = offset + node.nodeSize
        })
        decorations.push(Decoration.widget(end, () => card(item), {
          side: -1, key: JSON.stringify(item), ignoreSelection: true, stopEvent: () => true,
        }))
      }
      set(decorations)
    },
    destroy: () => set([]),
  }
}

/** Text preview offsets count source characters only, excluding interleaved annotation cards. */
export function textSurface(root: HTMLElement): AnnotationSurface {
  const source = root.textContent ?? ''
  const quote = (from: number, to: number) => source.slice(from, to)
  const offsetAt = (node: Node, offset: number) => {
    const range = document.createRange()
    range.selectNodeContents(root)
    range.setEnd(node, offset)
    const fragment = range.cloneContents()
    for (const ui of fragment.querySelectorAll('[data-annotation-ui]')) ui.remove()
    return fragment.textContent?.length ?? 0
  }
  return {
    element: root, source, kind: 'text', size: source.length, quote,
    selection: () => {
      const range = selectedRange(root)
      if (!range) return
      const from = offsetAt(range.startContainer, range.startOffset)
      const to = offsetAt(range.endContainer, range.endOffset)
      const text = quote(from, to)
      if (to > from && text.trim()) return { from, to, quote: text, rect: selectionRect(range) }
    },
    render: (items, card) => {
      const segments = annotationSegments(items.filter((item) => item.display === 'mark'))
      const cards = new Map<number, ReadingAnnotation[]>()
      for (const item of items.filter((item) => item.display === 'inline')) {
        const newline = source.indexOf('\n', item.anchor.to)
        const end = newline < 0 ? source.length : newline + 1
        cards.set(end, [...cards.get(end) ?? [], item])
      }
      const boundaries = [...new Set([0, source.length, ...segments.flatMap(({ from, to }) => [from, to]), ...cards.keys()])].sort((a, b) => a - b)
      const nodes: Node[] = []
      let index = 0
      for (let i = 0; i < boundaries.length - 1; i++) {
        const from = boundaries[i], to = boundaries[i + 1]
        while (segments[index] && segments[index].to <= from) index++
        const segment = segments[index]
        const text = document.createTextNode(source.slice(from, to))
        if (segment && segment.from <= from && segment.to >= to) {
          const mark = document.createElement('span')
          for (const [key, value] of Object.entries(markAttributes(segment.items))) mark.setAttribute(key, value)
          mark.append(text)
          nodes.push(mark)
        } else nodes.push(text)
        for (const item of cards.get(to) ?? []) nodes.push(card(item))
      }
      root.replaceChildren(...nodes)
    },
    destroy: () => { root.textContent = source },
  }
}
