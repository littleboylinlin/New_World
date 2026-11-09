import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/core'

interface Match { from: number; to: number }
interface SearchState {
  query: string
  matches: Match[]
  overflow: boolean
  decorations: DecorationSet
}

const searchKey = new PluginKey<SearchState>('novel-search')
const maxMatches = 10_000

function find(doc: Node, query: string): SearchState {
  const matches: Match[] = []
  let overflow = false
  if (query) {
    doc.descendants((node, position) => {
      if (overflow) return false
      if (!node.isTextblock) return true
      const text = node.textBetween(0, node.content.size, '', '\0')
      for (let i = text.indexOf(query); i >= 0; i = text.indexOf(query, i + query.length)) {
        if (matches.length >= maxMatches) {
          overflow = true
          break
        }
        matches.push({ from: position + 1 + i, to: position + 1 + i + query.length })
      }
      return false
    })
  }
  return { query, matches, overflow, decorations: DecorationSet.create(doc, matches.map(({ from, to }) => Decoration.inline(from, to, { class: 'found-text' }))) }
}

export const SearchHighlight = Extension.create({
  name: 'novelSearch',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: searchKey,
      state: {
        init: (_, state) => find(state.doc, ''),
        apply: (transaction, previous) => {
          const query = transaction.getMeta(searchKey) as string | undefined
          return query !== undefined || transaction.docChanged ? find(transaction.doc, query ?? previous.query) : previous
        },
      },
      props: { decorations: (state) => searchKey.getState(state)?.decorations },
    })]
  },
})

export function setSearch(editor: Editor, query: string) {
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, query).setMeta('addToHistory', false))
}

export function searchState(editor: Editor) {
  return searchKey.getState(editor.state)!
}

export function revealMatch(editor: Editor, match: Match) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, match.from, match.to)).scrollIntoView())
  const node = editor.view.domAtPos(match.from).node
  const target = node instanceof Element ? node : node.parentElement
  target?.scrollIntoView({ block: 'nearest' })
}

export function replaceMatches(editor: Editor, matches: Match[], replacement: string) {
  const transaction = editor.state.tr
  for (const { from, to } of [...matches].reverse()) transaction.insertText(replacement, from, to)
  editor.view.dispatch(transaction)
}
