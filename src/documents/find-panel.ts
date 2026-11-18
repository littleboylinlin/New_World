import type { Editor } from '@tiptap/core'
import { locale, t } from '../i18n'
import { reducedMotion } from '../motion'
import { setExpanded } from '../shell/collapse'
import { button, element } from '../ui'
import type { IconName } from '../ui'
import { readEditorPreferences, updateEditorPreferences } from './editor-prefs'
import type { Edition } from './model'
import { countMatches, leaveAtMatch, replaceMatches, searchState, selectMatch, setSearch } from './search'
import type { SearchQuery } from './search'
import { readChapter } from './store'

interface FindPanelOptions {
  /** The block inside the toolbar that the find controls expand into. */
  host: HTMLElement
  /** The pane that scrolls the chapter text. */
  scroller: HTMLElement
  trigger: HTMLButtonElement
  onOpenChange?: (open: boolean) => void
  getEditor: () => Editor
  getEdition: () => Edition
  getChapterId: () => string
  switchChapter: (id: string, wanted: () => boolean) => Promise<boolean>
  signal: AbortSignal
}

type Scope = 'chapter' | 'book'
type Destination = { id: string; index: number }

const debounce = 120
const contentDelay = 220
const batchSize = 8

function selectedText(editor: Editor) {
  const selection = document.getSelection()
  if (!selection?.rangeCount || selection.isCollapsed) return ''
  const range = selection.getRangeAt(0)
  const { view, state } = editor
  if (!view.dom.contains(range.startContainer) || !view.dom.contains(range.endContainer)) return ''
  const from = view.posAtDOM(range.startContainer, range.startOffset)
  const to = view.posAtDOM(range.endContainer, range.endOffset)
  const start = state.doc.resolve(from)
  if (!start.parent.isTextblock || !start.sameParent(state.doc.resolve(to))) return ''
  const text = state.doc.textBetween(from, to, '\n', '\n')
  return /[\r\n]/.test(text) ? '' : text
}

export function mountFindPanel({ host, scroller, trigger, onOpenChange, getEditor, getEdition, getChapterId, switchChapter, signal }: FindPanelOptions) {
  const panel = host
  panel.classList.add('search-panel')
  panel.id = `find-${getEdition().id}`
  panel.hidden = true
  panel.inert = true
  panel.setAttribute('role', 'search')
  panel.setAttribute('aria-label', t('editor.findReplace'))
  trigger.setAttribute('aria-controls', panel.id)
  trigger.setAttribute('aria-expanded', 'false')

  const query = element('input', 'title-input')
  query.type = 'search'
  query.maxLength = 512
  query.setAttribute('aria-label', t('editor.findText'))
  query.autocomplete = 'off'
  query.spellcheck = false

  function iconButton(label: string, symbol: IconName, shortcut: string) {
    const control = button('', 'find-button find-icon', symbol)
    control.setAttribute('aria-label', label)
    control.title = `${label} (${shortcut})`
    return control
  }

  const previous = iconButton(t('editor.previousMatch'), 'up', 'Shift+F3')
  const next = iconButton(t('editor.nextMatch'), 'down', 'F3')
  const close = iconButton(t('editor.closeFind'), 'close', 'Esc')
  const counter = element('span', 'match-count')
  counter.setAttribute('role', 'status')
  const inputRow = element('div', 'find-input-row')
  inputRow.append(query, counter, previous, next, close)

  const scopeRow = element('div', 'find-options')
  const scopes = element('div', 'find-scopes')
  scopes.setAttribute('role', 'group')
  scopes.setAttribute('aria-label', t('editor.findScope'))
  const chapterOnly = button(t('editor.findScopeChapter'), 'find-button')
  const entireBook = button(t('editor.findScopeBook'), 'find-button')
  scopes.append(chapterOnly, entireBook)
  const matchCase = button('Aa', 'find-button find-option')
  const wholeWord = button('Ab', 'find-button find-option find-word')
  matchCase.title = t('editor.findMatchCase')
  wholeWord.title = t('editor.findWholeWord')
  matchCase.setAttribute('aria-label', matchCase.title)
  wholeWord.setAttribute('aria-label', wholeWord.title)
  scopeRow.append(scopes, matchCase, wholeWord)

  const replaceRow = element('div', 'find-replace-row')
  const replacement = element('input', 'title-input')
  replacement.setAttribute('aria-label', t('editor.replaceWith'))
  replacement.placeholder = t('editor.replaceWith')
  replacement.autocomplete = 'off'
  const replace = button(t('editor.replace'), 'find-button')
  const replaceAll = button(t('editor.replaceAll'), 'find-button')
  replace.title = replaceAll.title = t('editor.replaceInChapter')
  replaceRow.append(replacement, replace, replaceAll)
  const replaceToggle = button('', 'find-button find-option find-replace-toggle', 'chevron')
  replaceToggle.setAttribute('aria-label', t('editor.showReplace'))
  replaceToggle.title = t('editor.showReplace')
  replaceToggle.setAttribute('aria-controls', `${panel.id}-replace`)
  replaceRow.id = `${panel.id}-replace`
  scopeRow.append(replaceToggle)

  const results = element('section', 'find-book')
  results.setAttribute('aria-label', t('editor.findScopeBook'))
  const summary = element('div', 'find-summary')
  const total = element('strong', 'find-total')
  const scanStatus = element('span', 'find-scan-status')
  summary.append(total, scanStatus)
  const list = element('ul', 'find-chapters')
  results.append(summary, list)
  replaceRow.hidden = results.hidden = true
  /** Expands or collapses a part of the find block only when its wanted state changes. */
  function want(node: HTMLElement, open: boolean) {
    const current = node.dataset.expand ?? (node.hidden ? 'closed' : 'open')
    if (current !== (open ? 'open' : 'closed')) setExpanded(node, open)
  }
  const bar = element('div', 'find-bar')
  bar.append(inputRow, scopeRow)
  panel.append(bar, replaceRow, results)

  const saved = readEditorPreferences().find
  let opened = false
  let scope: Scope = saved.scope
  let caseSensitive = saved.matchCase
  let wordsOnly = saved.wholeWord
  let replaceOpen = saved.replaceOpen
  const remember = () => updateEditorPreferences({ find: { scope, matchCase: caseSensitive, wholeWord: wordsOnly, replaceOpen } })
  let criteria: SearchQuery | undefined
  let composing: HTMLInputElement | undefined
  let queryTimer = 0
  let contentTimer = 0
  let pending = false
  let navigation = 0
  let navigating = false
  let counts = new Map<string, number>()
  let scannedEdition: Edition | undefined
  let scan: { controller: AbortController; done: Promise<void> } | undefined
  let readFailed = false
  const rows = new Map<string, { item: HTMLLIElement; jump: HTMLButtonElement; title: HTMLSpanElement; count: HTMLSpanElement }>()
  const format = new Intl.NumberFormat(locale)
  let revealFrame = 0
  // The find controls sit in the toolbar above the text, so the match only needs to be scrolled
  // into the middle of the text pane.
  const position = {
    schedule() {},
    reveal() {
      cancelAnimationFrame(revealFrame)
      revealFrame = requestAnimationFrame(() => {
        const mark = getEditor().view.dom.querySelector('.found-text-current')?.getClientRects()[0]
        if (!mark) return
        const view = scroller.getBoundingClientRect()
        const target = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight,
          scroller.scrollTop + (mark.top + mark.bottom) / 2 - (view.top + view.bottom) / 2))
        if (Math.abs(target - scroller.scrollTop) > 1) scroller.scrollTo({ top: target, behavior: reducedMotion.matches ? 'instant' : 'smooth' })
      })
    },
  }

  function paintBook() {
    want(results, scope === 'book')
    if (scope !== 'book') return
    results.setAttribute('aria-busy', String(Boolean(scan) || pending))
    scanStatus.textContent = readFailed ? t('editor.findReadFailed') : scan || pending ? t('editor.findSearching') : ''
    const chapterId = getChapterId()
    let cursor = list.firstElementChild
    for (const { id, title } of getEdition().chapters) {
      const hits = pending ? 0 : counts.get(id) ?? 0
      if (!hits) continue
      let row = rows.get(id)
      if (!row) {
        const item = element('li')
        const jump = button('', 'find-chapter-jump')
        const name = element('span', 'find-chapter-title')
        const count = element('span', 'find-chapter-count')
        jump.append(name, count)
        jump.dataset.chapter = id
        item.append(jump)
        row = { item, jump, title: name, count }
        rows.set(id, row)
      }
      if (row.title.textContent !== title) row.title.textContent = title
      const formatted = format.format(hits)
      if (row.count.textContent !== formatted) row.count.textContent = formatted
      if (id === chapterId) row.jump.setAttribute('aria-current', 'true')
      else row.jump.removeAttribute('aria-current')
      row.jump.disabled = navigating || Boolean(composing)
      if (cursor === row.item) cursor = cursor.nextElementSibling
      else list.insertBefore(row.item, cursor)
    }
    while (cursor) {
      const next = cursor.nextElementSibling
      cursor.remove()
      cursor = next
    }
  }

  function paint() {
    if (!opened) return
    const editor = getEditor()
    const state = searchState(editor)
    const chapterId = getChapterId()
    const dirty = Boolean(contentTimer)
    const ready = !pending && !dirty && !composing && !navigating
    let amount = state.matches.length
    let ordinal = state.active + 1
    if (scope === 'book') {
      amount = 0
      let before = 0
      let current = false
      for (const { id } of getEdition().chapters) {
        const hits = counts.get(id) ?? 0
        if (id === chapterId) current = true
        if (!current) before += hits
        amount += hits
      }
      if (ordinal) ordinal += before
      total.textContent = t('editor.findBookTotal', [format.format(pending ? 0 : amount)])
    }
    counter.textContent = pending || dirty || !amount && scan ? '…'
      : amount ? `${format.format(ordinal)}/${format.format(amount)}` : criteria?.text ? t('editor.noMatches') : ''
    previous.disabled = next.disabled = !ready || !amount && !scan
    replaceToggle.hidden = !editor.isEditable
    replaceToggle.setAttribute('aria-expanded', String(replaceOpen && editor.isEditable))
    want(replaceRow, replaceOpen && editor.isEditable)
    replace.disabled = replaceAll.disabled = !ready || !state.matches.length
    chapterOnly.setAttribute('aria-pressed', String(scope === 'chapter'))
    entireBook.setAttribute('aria-pressed', String(scope === 'book'))
    matchCase.setAttribute('aria-pressed', String(caseSensitive))
    wholeWord.setAttribute('aria-pressed', String(wordsOnly))
    query.placeholder = t(scope === 'book' ? 'editor.findInBook' : 'editor.findInChapter')
    paintBook()
    position.schedule()
  }

  function cancelScan() {
    scan?.controller.abort()
    scan = undefined
  }

  function resetBook() {
    cancelScan()
    counts = new Map()
    rows.clear()
    list.replaceChildren()
    scannedEdition = undefined
    readFailed = false
  }

  function searchBook() {
    const query = criteria
    if (scope !== 'book' || !query?.text) return
    const edition = getEdition()
    scannedEdition = edition
    const schema = getEditor().schema
    const savedCounts = counts
    const job = { controller: new AbortController(), done: Promise.resolve() }
    scan = job
    const { signal: reading } = job.controller
    job.done = (async () => {
      let completed = 0
      for (const { id } of edition.chapters) {
        if (reading.aborted) return
        if (savedCounts.has(id)) continue
        try {
          const record = await readChapter(edition, id)
          if (reading.aborted) return
          if (!savedCounts.has(id)) savedCounts.set(id, countMatches(schema.nodeFromJSON(record.content), query))
        } catch {
          if (reading.aborted) return
          readFailed = true
        }
        if (++completed % batchSize === 0) {
          paint()
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
        }
      }
    })().finally(() => {
      if (scan !== job) return
      scan = undefined
      paint()
    })
  }

  function refreshLocal(preferred: Parameters<typeof setSearch>[2] = 0, reveal = false) {
    window.clearTimeout(contentTimer)
    contentTimer = 0
    const state = setSearch(getEditor(), criteria, preferred)
    if (scope === 'book') counts.set(getChapterId(), state.matches.length)
    if (reveal && state.active !== -1) position.reveal()
  }

  function search() {
    queryTimer = 0
    if (!opened || composing === query) return
    pending = false
    criteria = { text: query.value, matchCase: caseSensitive, wholeWord: wordsOnly }
    resetBook()
    refreshLocal(0, true)
    searchBook()
    paint()
  }

  function scheduleSearch() {
    pending = true
    navigation++
    navigating = false
    window.clearTimeout(queryTimer)
    window.clearTimeout(contentTimer)
    contentTimer = 0
    resetBook()
    if (composing !== query) queryTimer = window.setTimeout(search, debounce)
    paint()
  }

  function showMatch(index: number) {
    const state = selectMatch(getEditor(), index)
    if (state.active !== -1) position.reveal()
    paint()
  }

  async function goTo(target: () => Destination | undefined | Promise<Destination | undefined>) {
    if (!opened || composing || pending || navigating) return
    const request = ++navigation
    const wanted = () => opened && request === navigation && !signal.aborted
    navigating = true
    paint()
    try {
      const destination = await target()
      if (!destination || !wanted()) return
      if (destination.id !== getChapterId()) {
        if (!await switchChapter(destination.id, wanted)) return
      } else if (contentTimer) {
        if (getEditor().view.composing) return
        refreshLocal()
      }
      if (wanted()) showMatch(destination.index)
    } finally {
      if (request === navigation) { navigating = false; paint() }
    }
  }

  function step(direction: 1 | -1) {
    if (next.disabled) return
    const state = searchState(getEditor())
    const index = state.active + direction
    if (index >= 0 && index < state.matches.length) { showMatch(index); return }
    if (scope === 'chapter') {
      if (state.matches.length) showMatch(direction > 0 ? 0 : state.matches.length - 1)
      return
    }
    void goTo(async () => {
      await scan?.done
      const chapters = getEdition().chapters
      const origin = chapters.findIndex(({ id }) => id === getChapterId())
      for (let i = 1; i <= chapters.length; i++) {
        const { id } = chapters[(origin + i * direction + chapters.length) % chapters.length]
        if (counts.get(id)) return { id, index: direction > 0 ? 0 : Infinity }
      }
    })
  }

  function animate(show: boolean) {
    want(panel, show)
  }

  function openFind() {
    const wasOpen = opened
    const selection = selectedText(getEditor()).slice(0, query.maxLength)
    if (selection) query.value = selection
    if (!wasOpen) {
      opened = true
      panel.inert = false
      trigger.setAttribute('aria-expanded', 'true')
      paint()
      animate(true)
      onOpenChange?.(true)
    }
    query.focus({ preventScroll: true })
    query.select()
    if (!wasOpen || selection) scheduleSearch()
  }

  function closeFind() {
    if (!opened) return
    const editor = getEditor()
    const { matches, active } = searchState(editor)
    opened = pending = navigating = false
    criteria = composing = undefined
    navigation++
    window.clearTimeout(queryTimer)
    window.clearTimeout(contentTimer)
    queryTimer = contentTimer = 0
    resetBook()
    trigger.setAttribute('aria-expanded', 'false')
    panel.inert = true
    leaveAtMatch(editor, matches[active])
    if (!editor.isEditable || panel.contains(document.activeElement)) {
      if (editor.isEditable) editor.commands.focus(undefined, { scrollIntoView: false })
      else trigger.focus({ preventScroll: true })
    }
    animate(false)
    onOpenChange?.(false)
  }

  for (const control of [trigger, previous, next, chapterOnly, entireBook, matchCase, wholeWord, replace, replaceAll, replaceToggle]) {
    control.addEventListener('mousedown', (event) => event.preventDefault(), { signal })
  }
  trigger.addEventListener('click', () => { if (opened && !panel.contains(document.activeElement)) closeFind(); else openFind() }, { signal })
  replaceToggle.addEventListener('click', () => {
    replaceOpen = !replaceOpen
    remember()
    paint()
    if (replaceOpen) replacement.focus({ preventScroll: true })
  }, { signal })
  close.addEventListener('click', closeFind, { signal })
  previous.addEventListener('click', () => step(-1), { signal })
  next.addEventListener('click', () => step(1), { signal })
  list.addEventListener('click', (event) => {
    const id = (event.target as Element).closest<HTMLButtonElement>('.find-chapter-jump')?.dataset.chapter
    if (id) void goTo(() => ({ id, index: 0 }))
  }, { signal })
  for (const [control, value] of [[chapterOnly, 'chapter'], [entireBook, 'book']] as const) {
    control.addEventListener('click', () => {
      if (scope === value) return
      scope = value
      remember()
      scheduleSearch()
    }, { signal })
  }
  matchCase.addEventListener('click', () => { caseSensitive = !caseSensitive; remember(); scheduleSearch() }, { signal })
  wholeWord.addEventListener('click', () => { wordsOnly = !wordsOnly; remember(); scheduleSearch() }, { signal })
  query.addEventListener('input', (event) => {
    if (composing !== query && !(event as InputEvent).isComposing) scheduleSearch()
  }, { signal })
  for (const field of [query, replacement]) {
    field.addEventListener('compositionstart', () => {
      composing = field
      if (field === query) scheduleSearch()
      else paint()
    }, { signal })
    field.addEventListener('compositionend', () => {
      composing = undefined
      if (field === query) scheduleSearch()
      else paint()
    }, { signal })
  }
  replace.addEventListener('click', () => {
    if (replace.disabled) return
    const editor = getEditor()
    const state = searchState(editor)
    const hit = state.matches[state.active]
    if (!hit) return
    const after = hit.from + replacement.value.length
    replaceMatches(editor, [hit], replacement.value)
    refreshLocal((matches) => Math.max(0, matches.findIndex(({ from }) => from >= after)), true)
    paint()
  }, { signal })
  replaceAll.addEventListener('click', () => {
    if (replaceAll.disabled) return
    const editor = getEditor()
    replaceMatches(editor, searchState(editor).matches, replacement.value)
    refreshLocal(0, true)
    paint()
  }, { signal })

  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || composing || document.querySelector('dialog[open]')) return
    const command = event.ctrlKey || event.metaKey
    if (command && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      openFind()
    } else if (event.key === 'F3' && !command && !event.altKey && opened
      || event.key === 'Enter' && event.target === query && opened) {
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape' && opened
      && !(event.target instanceof Element && event.target.closest('.shell-layer, .selection-toolbar'))) {
      event.preventDefault()
      event.stopPropagation()
      closeFind()
    }
  }, { signal, capture: true })

  signal.addEventListener('abort', () => {
    navigation++
    window.clearTimeout(queryTimer)
    window.clearTimeout(contentTimer)
    cancelAnimationFrame(revealFrame)
    cancelScan()
  }, { once: true })

  function chaptersChanged() {
    if (!opened || pending || scope !== 'book' || scannedEdition === getEdition()) return
    resetBook()
    counts.set(getChapterId(), searchState(getEditor()).matches.length)
    searchBook()
    paint()
  }

  return {
    isOpen: () => opened,
    open: openFind,
    close: closeFind,
    beforeChapterChange() {
      if (opened && !pending && scope === 'book' && criteria?.text && contentTimer) {
        counts.set(getChapterId(), countMatches(getEditor().state.doc, criteria))
      }
    },
    chapterMounted() {
      if (!opened || pending) return
      refreshLocal(0, !navigating)
      chaptersChanged()
      paint()
    },
    chaptersChanged,
    modeChanged: paint,
    documentChanged() {
      if (!opened || pending || !criteria?.text) return
      window.clearTimeout(contentTimer)
      function update() {
        if (getEditor().view.composing) { contentTimer = window.setTimeout(update, contentDelay); return }
        refreshLocal(searchState(getEditor()).active)
        paint()
      }
      contentTimer = window.setTimeout(update, contentDelay)
      paint()
    },
  }
}
