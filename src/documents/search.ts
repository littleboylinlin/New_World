import { Extension } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/core'

export interface Match { from: number; to: number }
export interface SearchQuery { text: string; matchCase: boolean; wholeWord: boolean }

interface SearchState {
  matches: Match[]
  active: number
  normal: DecorationSet
  decorations: DecorationSet
}

const searchKey = new PluginKey<SearchState>('novel-search')
const empty: SearchState = { matches: [], active: -1, normal: DecorationSet.empty, decorations: DecorationSet.empty }
const wordUnit = /[A-Za-z0-9]/

function scan(doc: Node, { text, matchCase, wholeWord }: SearchQuery, found: (from: number, to: number) => void) {
  if (!text) return
  const literal = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(literal, matchCase ? 'gu' : 'giu')
  const checkStart = wholeWord && wordUnit.test(text.charAt(0))
  const checkEnd = wholeWord && wordUnit.test(text.charAt(text.length - 1))

  function searchRun(run: string, start: number) {
    pattern.lastIndex = 0
    for (let match = pattern.exec(run); match; match = pattern.exec(run)) {
      const end = pattern.lastIndex
      if (checkStart && wordUnit.test(run.charAt(match.index - 1)) || checkEnd && wordUnit.test(run.charAt(end))) {
        pattern.lastIndex = match.index + (run.codePointAt(match.index)! > 0xffff ? 2 : 1)
        continue
      }
      found(start + match.index, start + end)
    }
  }

  doc.descendants((node, position) => {
    if (!node.isTextblock) return true
    let start = 0
    let run = ''
    // Join text split by formatting, keeping the document positions of each text run.
    node.forEach((child, offset) => {
      if (child.isText) {
        if (!run) start = position + 1 + offset
        run += child.text
      } else if (run) {
        searchRun(run, start)
        run = ''
      }
    })
    if (run) searchRun(run, start)
    return false
  })
}

export function countMatches(doc: Node, query: SearchQuery) {
  let count = 0
  scan(doc, query, () => { count++ })
  return count
}

const matchDecoration = ({ from, to }: Match, active = false) =>
  Decoration.inline(from, to, { class: active ? 'found-text found-text-current' : 'found-text' })

function activeResult(doc: Node, state: SearchState, index: number): SearchState {
  const active = state.matches.length ? Math.max(0, Math.min(index, state.matches.length - 1)) : -1
  const match = state.matches[active]
  const decorations = match
    ? state.normal.remove([matchDecoration(match)]).add(doc, [matchDecoration(match, true)])
    : state.normal
  return { ...state, active, decorations }
}

export const SearchHighlight = Extension.create({
  name: 'novelSearch',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: searchKey,
      state: {
        init: () => empty,
        apply: (transaction, previous) => {
          const result = transaction.getMeta(searchKey) as SearchState | undefined
          if (result) return result
          // An edit invalidates every range until the panel searches the new document.
          return transaction.docChanged && previous.matches.length ? { ...empty, active: previous.active } : previous
        },
      },
      props: { decorations: (state) => searchKey.getState(state)?.decorations },
    })]
  },
})

export function searchState(editor: Editor) {
  return searchKey.getState(editor.state)!
}

function applySearch(editor: Editor, result: SearchState) {
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, result).setMeta('addToHistory', false))
  return result
}

export function setSearch(editor: Editor, query?: SearchQuery, preferred: number | ((matches: Match[]) => number) = 0) {
  if (!query?.text) return applySearch(editor, empty)
  const doc = editor.state.doc
  const matches: Match[] = []
  scan(doc, query, (from, to) => { matches.push({ from, to }) })
  const normal = DecorationSet.create(doc, matches.map((match) => matchDecoration(match)))
  const index = typeof preferred === 'number' ? preferred : preferred(matches)
  return applySearch(editor, activeResult(doc, { matches, normal, active: -1, decorations: normal }, index))
}

export function selectMatch(editor: Editor, index: number) {
  const state = searchState(editor)
  return state.active === index ? state : applySearch(editor, activeResult(editor.state.doc, state, index))
}

export function leaveAtMatch(editor: Editor, match?: Match) {
  const transaction = editor.state.tr.setMeta(searchKey, empty).setMeta('addToHistory', false)
  if (match && editor.isEditable) transaction.setSelection(TextSelection.create(editor.state.doc, match.from))
  editor.view.dispatch(transaction)
  if (editor.isEditable) editor.view.focus()
}

export function replaceMatches(editor: Editor, matches: Match[], replacement: string) {
  if (!matches.length) return
  const transaction = closeHistory(editor.state.tr)
  for (const { from, to } of [...matches].reverse()) transaction.insertText(replacement, from, to)
  editor.view.dispatch(transaction)
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta('addToHistory', false))
}
