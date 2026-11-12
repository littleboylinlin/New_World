import { t } from '../i18n'
import { Editor } from '@tiptap/core'
import { formDialog, nameField } from '../dialogs'
import { storageError } from '../library'
import type { Book } from '../library'
import { bookPath, button, element, icon } from '../ui'
import type { IconName } from '../ui'
import { offerUndo } from '../undo'
import { showExportDialog } from './export-view'
import { cleanMarkup, inertMarkup, rasterData } from './markup'
import { wordCount } from './model'
import type { ChapterInput, ChapterRecord, DocumentContent, Edition } from './model'
import { checkDocument, documentExtensions } from './schema'
import { replaceMatches, revealMatch, SearchHighlight, searchState, setSearch } from './search'
import { changeChapters, chapterWordCounts, createEdition, deleteEdition, readBundle, readChapter, saveChapter } from './store'
import './editor.css'

export type RegisterLeave = (callback: () => Promise<boolean>) => void

export async function renderEdition(
  host: HTMLElement, root: HTMLElement, book: Book, initial: Edition, signal: AbortSignal, registerLeave: RegisterLeave,
) {
  let edition = initial
  let chapter = await readChapter(edition, edition.chapters[0].id)
  signal.throwIfAborted()
  let editor: Editor
  let editing = true
  let change = 0
  let saved = 0
  let timer: number | undefined
  let pending: Promise<boolean> | undefined
  let selectionRequest = 0
  let activeMatch = 0
  let refreshFrame = 0
  // Word counts of the other chapters are read once. The open chapter is counted as it changes.
  let words: Map<string, number> | undefined
  const wordLabels = new Map<string, HTMLElement>()
  const number = (value: number) => value.toLocaleString('zh-CN')

  const workspace = element('section', 'edition-workspace')
  const top = element('header', 'edition-header')
  const about = element('div', 'edition-about')
  about.append(element('h2', '', edition.name))
  const commands = element('div', 'edition-commands')
  const status = element('span', 'save-status', t('editor.saved'))
  status.setAttribute('role', 'status')
  const save = button(t('editor.saveNow'), 'button button-primary button-small', 'check')
  save.title = 'Ctrl / ⌘ + S'
  const mode = button('', 'button button-quiet button-small', 'book')
  const modeLabel = element('span', '', t('editor.readingMode'))
  mode.append(modeLabel)
  const saveCopy = button(t('editor.saveAsASeparateVersion'), 'button button-quiet button-small', 'copy')
  const exportButton = button(t('editor.export'), 'button button-quiet button-small', 'download')
  const removeVersion = button(t('editor.deleteVersion'), 'button button-quiet button-small remove-button', 'trash')
  commands.append(status, save, mode, saveCopy, exportButton, removeVersion)
  top.append(about, commands)

  const error = element('p', 'notice notice-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  const recover = button(t('editor.discardUnsavedChangesInThisChapter'), 'button button-quiet button-small')
  recover.hidden = true
  const information = element('details', 'conversion-info')
  information.append(element('summary', '', t('editor.viewConversionNotes')))
  const details = element('ul')
  for (const note of edition.notes) details.append(element('li', '', note))
  information.append(details)
  information.hidden = !edition.notes.length

  const layout = element('div', 'edition-layout')
  const navigation = element('details', 'chapter-navigation')
  navigation.open = matchMedia('(min-width: 780px)').matches
  const navLabel = element('summary', '', t('editor.chapterList'))
  const chapterList = element('ol', 'chapter-list')
  chapterList.setAttribute('aria-label', t('content.chapters'))
  const chapterActions = element('div', 'chapter-actions')
  const add = button(t('editor.newChapter'), 'button button-quiet button-small', 'plus')
  const rename = button(t('editor.renameChapter'), 'button button-quiet button-small', 'edit')
  const up = button(t('editor.moveUp'), 'button button-quiet button-small', 'up')
  const down = button(t('editor.moveDown'), 'button button-quiet button-small', 'down')
  const remove = button(t('editor.deleteChapter'), 'button button-quiet button-small remove-button', 'trash')
  chapterActions.append(add, rename, up, down, remove)
  const outline = element('nav', 'chapter-outline')
  outline.setAttribute('aria-label', t('editor.sectionsInThisChapter'))
  navigation.append(navLabel, chapterList, chapterActions, outline)

  const writing = element('section', 'writing-panel')
  const chapterHeader = element('header', 'writing-header')
  const chapterTitle = element('h3')
  const count = element('span', 'word-count')
  const total = element('span', 'word-total')
  total.hidden = true
  const counts = element('div', 'word-counts')
  counts.append(count, total)
  chapterHeader.append(chapterTitle, counts)
  const toolbar = element('div', 'format-toolbar')
  toolbar.setAttribute('role', 'group')
  toolbar.setAttribute('aria-label', t('editor.textFormatting'))
  const heading = element('select', 'editor-select')
  heading.setAttribute('aria-label', t('editor.paragraphStyle'))
  for (const [value, label] of [t('editor.paragraph'), t('editor.heading1'), t('editor.heading2'), t('editor.heading3'), t('editor.heading4'), t('editor.heading5'), t('editor.heading6')].entries()) {
    const option = element('option', '', label)
    option.value = String(value)
    heading.append(option)
  }
  heading.addEventListener('change', () => {
    const command = editor.chain().focus()
    if (heading.value === '0') command.setParagraph().run()
    else command.setHeading({ level: Number(heading.value) as 1 | 2 | 3 | 4 | 5 | 6 }).run()
  })
  toolbar.append(heading)

  const markControls: { node: HTMLButtonElement; active: string }[] = []
  // Toolbar buttons show a glyph or an icon. The label stays as the accessible name and tooltip.
  function tool(label: string, symbol: IconName | { glyph: string }, invoke: () => void, active?: string, shortcut?: string) {
    const node = button('', 'format-button')
    if (typeof symbol === 'string') node.append(icon(symbol))
    else node.append(element('span', `format-glyph format-${active}`, symbol.glyph))
    node.setAttribute('aria-label', label)
    node.title = shortcut ? `${label}（${shortcut}）` : label
    node.addEventListener('mousedown', (event) => event.preventDefault())
    node.addEventListener('click', invoke)
    if (active) markControls.push({ node, active })
    toolbar.append(node)
    return node
  }
  const divider = () => toolbar.append(element('span', 'format-divider'))
  divider()
  tool(t('editor.bold'), { glyph: 'B' }, () => editor.chain().focus().toggleBold().run(), 'bold', 'Ctrl / ⌘ + B')
  tool(t('editor.italic'), { glyph: 'I' }, () => editor.chain().focus().toggleItalic().run(), 'italic', 'Ctrl / ⌘ + I')
  tool(t('editor.underline'), { glyph: 'U' }, () => editor.chain().focus().toggleUnderline().run(), 'underline', 'Ctrl / ⌘ + U')
  divider()
  tool(t('editor.bulletedList'), 'list', () => editor.chain().focus().toggleBulletList().run(), 'bulletList')
  tool(t('editor.numberedList'), 'ordered', () => editor.chain().focus().toggleOrderedList().run(), 'orderedList')
  tool(t('editor.blockQuote'), 'quote', () => editor.chain().focus().toggleBlockquote().run(), 'blockquote')
  tool(t('editor.horizontalRule'), 'rule', () => editor.chain().focus().setHorizontalRule().run())
  divider()
  const undo = tool(t('editor.undo'), 'undo', () => editor.chain().focus().undo().run(), undefined, 'Ctrl / ⌘ + Z')
  const redo = tool(t('editor.redo'), 'redo', () => editor.chain().focus().redo().run(), undefined, 'Ctrl / ⌘ + Shift + Z')
  divider()
  const imageInput = element('input')
  imageInput.type = 'file'
  imageInput.accept = 'image/png,image/jpeg,image/gif,image/webp'
  imageInput.hidden = true
  imageInput.setAttribute('aria-label', t('editor.chooseAnImage'))
  let imageTarget: Editor | undefined
  tool(t('docxExport.illustration'), 'image', () => { imageTarget = editor; imageInput.click() })
  imageInput.addEventListener('change', async () => {
    const target = imageTarget
    imageTarget = undefined
    const file = imageInput.files?.[0]
    imageInput.value = ''
    if (!file) return
    try {
      const src = await rasterData(file)
      if (!src) throw new Error(t('editor.chooseAPngJpegGifOrWebpImage'))
      if (target === editor && editing && !signal.aborted) editor.chain().focus().setImage({ src, alt: file.name.slice(0, 255) }).run()
    } catch (cause) { report(cause) }
  })

  const findButton = button(t('editor.findReplace'), 'format-button find-toggle', 'search')
  findButton.title = 'Ctrl / ⌘ + F'
  const toolsRow = element('div', 'editor-tools-row')
  toolsRow.append(toolbar, findButton, imageInput)

  const searchBar = element('div', 'search-panel')
  searchBar.hidden = true
  const query = element('input', 'title-input')
  query.type = 'search'
  query.setAttribute('aria-label', t('editor.findText'))
  query.placeholder = t('editor.findInChapter')
  query.maxLength = 512
  const replacement = element('input', 'title-input')
  replacement.setAttribute('aria-label', t('editor.replaceWith'))
  replacement.placeholder = t('editor.replaceWith')
  const nextMatch = button(t('editor.nextMatch'), 'format-button')
  const previousMatch = button(t('editor.previousMatch'), 'format-button')
  const replace = button(t('editor.replace'), 'format-button')
  const replaceAll = button(t('editor.replaceAll'), 'format-button')
  const matchCount = element('span', 'match-count')
  matchCount.setAttribute('role', 'status')
  const closeSearch = button(t('editor.closeFind'), 'format-button')
  searchBar.append(query, previousMatch, nextMatch, matchCount, replacement, replace, replaceAll, closeSearch)
  const paper = element('div', 'editor-paper')
  writing.append(chapterHeader, toolsRow, searchBar, paper)
  layout.append(navigation, writing)
  workspace.append(top, error, recover, information, layout)
  host.replaceChildren(workspace)

  function report(cause: unknown, saving = false) {
    error.textContent = t('common.concatenate', [saving ? t('editor.saveFailed') : '', storageError(cause)])
    error.hidden = false
    recover.hidden = !saving || change === saved
    if (saving) status.textContent = t('editor.unsavedFailed')
  }

  function scheduleSave() {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => { void flush() }, 700)
  }

  function unsaved(event: BeforeUnloadEvent) {
    event.preventDefault()
    event.returnValue = ''
  }

  async function flush() {
    window.clearTimeout(timer)
    while (change !== saved || pending) {
      if (!pending) {
        if (editor.view.composing) {
          status.textContent = t('editor.saveAfterTypingFinishes')
          return false
        }
        const snapshot = editor.getJSON() as DocumentContent
        const checkpoint = change
        status.textContent = t('editor.saving')
        pending = saveChapter(edition, chapter, snapshot).then((stored) => {
          chapter = stored
          saved = checkpoint
          status.textContent = change === saved ? t('editor.saved') : t('editor.unsaved')
          error.hidden = recover.hidden = true
          if (change === saved) window.removeEventListener('beforeunload', unsaved)
          return true
        }, (cause) => { report(cause, true); return false }).finally(() => { pending = undefined })
      }
      if (!await pending) return false
    }
    return true
  }

  function chapterInfo() {
    return edition.chapters.find((entry) => entry.id === chapter.id) ?? { id: chapter.id, title: chapterTitle.textContent || t('editor.chapterRemoved') }
  }

  const liveCount = () => Array.from(editor.state.doc.textContent.replace(/\s/gu, '')).length

  function refreshWords(everyChapter = true) {
    if (!words) return
    let sum = 0
    for (const { id } of edition.chapters) sum += words.get(id) ?? 0
    total.textContent = t('editor.bookCharacters', [number(sum)])
    total.hidden = false
    for (const [id, label] of everyChapter ? wordLabels : [[chapter.id, wordLabels.get(chapter.id)] as const]) {
      if (label) label.textContent = number(words.get(id) ?? 0)
    }
  }

  function refreshContents() {
    const current = liveCount()
    count.textContent = t('editor.chapterCharacters', [number(current)])
    words?.set(chapter.id, current)
    refreshWords(false)
    outline.replaceChildren()
    const links = element('ul')
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'heading' && node.textContent.trim()) {
        const item = element('li')
        const jump = button(node.textContent.slice(0, 100), 'outline-jump')
        jump.addEventListener('click', () => (editor.view.nodeDOM(position) as Element | null)?.scrollIntoView({ block: 'start' }))
        item.append(jump)
        links.append(item)
      }
    })
    if (links.childNodes.length) outline.append(element('strong', '', t('editor.sectionsInThisChapter')), links)
    refreshSearch()
  }

  function refreshFormat() {
    for (const { node, active } of markControls) node.setAttribute('aria-pressed', String(editor.isActive(active)))
    heading.value = editor.isActive('heading') ? String(editor.getAttributes('heading').level) : '0'
    undo.disabled = !editor.can().undo()
    redo.disabled = !editor.can().redo()
  }

  function refreshSearch(reveal = false) {
    const { matches, overflow } = searchState(editor)
    activeMatch = Math.min(activeMatch, Math.max(0, matches.length - 1))
    matchCount.textContent = matches.length ? `${activeMatch + 1} / ${overflow ? '≥' : ''}${matches.length}` : query.value ? t('editor.noMatches') : ''
    previousMatch.disabled = nextMatch.disabled = !matches.length
    replacement.hidden = replace.hidden = replaceAll.hidden = !editing
    replace.disabled = !matches.length
    replaceAll.disabled = !matches.length || overflow
    if (reveal && matches.length) revealMatch(editor, matches[activeMatch])
  }

  function refreshChapters() {
    chapterTitle.textContent = chapterInfo().title
    navLabel.textContent = t('editor.chapterList105', [edition.chapters.length])
    wordLabels.clear()
    chapterList.replaceChildren(...edition.chapters.map(({ id, title }) => {
      const item = element('li')
      const jump = button(title, 'chapter-jump')
      if (id === chapter.id) jump.setAttribute('aria-current', 'true')
      jump.addEventListener('click', () => { void switchChapter(id) })
      const label = element('span', 'chapter-words')
      label.title = t('editor.chapterCharacterCount')
      wordLabels.set(id, label)
      item.append(jump, label)
      return item
    }))
    refreshWords()
    const index = edition.chapters.findIndex((entry) => entry.id === chapter.id)
    up.disabled = index === 0
    down.disabled = index === edition.chapters.length - 1
  }

  function applyMode() {
    editor.setEditable(editing, false)
    editor.view.dom.setAttribute('role', editing ? 'textbox' : 'document')
    modeLabel.textContent = editing ? t('editor.readingMode') : t('editor.editText')
    mode.setAttribute('aria-pressed', String(!editing))
    toolbar.hidden = chapterActions.hidden = save.hidden = !editing
    workspace.classList.toggle('edition-reading', !editing)
    refreshSearch()
  }

  function mountChapter(next: ChapterRecord, turn?: 'next' | 'previous') {
    checkDocument(next.content)
    editor?.destroy()
    paper.replaceChildren()
    chapter = next
    change = saved = 0
    activeMatch = 0
    status.textContent = t('editor.saved')
    error.hidden = recover.hidden = true
    editor = new Editor({
      element: paper, extensions: [...documentExtensions, SearchHighlight], content: next.content, editable: editing,
      editorProps: {
        attributes: { class: 'novel-body', 'aria-label': t('editor.chapterText'), 'aria-multiline': 'true', spellcheck: 'false', ...(turn ? { 'data-turn': turn } : {}) },
        transformPastedHTML: (markup) => {
          if (markup.length <= 36 * 1024 * 1024) return cleanMarkup(inertMarkup(markup))
          report(new Error(t('editor.theRichTextOnTheClipboardIsToo')))
          return ''
        },
        handleDrop: (_, event, _slice, moved) => {
          if (!moved && event.dataTransfer?.files.length) { event.preventDefault(); return true }
          return false
        },
      },
      onUpdate: () => {
        change++
        status.textContent = t('editor.unsaved')
        window.addEventListener('beforeunload', unsaved)
        scheduleSave()
        window.cancelAnimationFrame(refreshFrame)
        refreshFrame = window.requestAnimationFrame(refreshContents)
      },
    })
    editor.on('transaction', refreshFormat)
    editor.view.dom.addEventListener('compositionend', () => { if (change !== saved) scheduleSave() })
    setSearch(editor, query.value)
    applyMode()
    refreshChapters()
    refreshContents()
  }

  async function switchChapter(id: string) {
    const request = ++selectionRequest
    if (id === chapter.id) return
    try {
      if (!await flush()) return
      const next = await readChapter(edition, id)
      if (!await flush() || signal.aborted || request !== selectionRequest) return
      const order = (target: string) => edition.chapters.findIndex((entry) => entry.id === target)
      mountChapter(next, order(id) < order(chapter.id) ? 'previous' : 'next')
      if (matchMedia('(max-width: 779px)').matches) navigation.open = false
    } catch (cause) { report(cause) }
  }

  async function alter(changeRequest: Parameters<typeof changeChapters>[1]) {
    if (!await flush()) throw new Error(t('editor.resolveUnsavedChangesFirst'))
    const result = await changeChapters(edition, changeRequest)
    edition = result.edition
    if (result.selected !== chapter.id) await switchChapter(result.selected)
    else refreshChapters()
    if (result.trashed) offerUndo(result.trashed, (restored) => {
      if (signal.aborted || !restored.edition) return
      const [record] = restored.entry.chapters
      edition = restored.edition
      words?.set(record.id, wordCount(record.content))
      refreshChapters()
    })
  }

  async function currentChapters(selectedIds?: Set<string>): Promise<ChapterInput[]> {
    if (editor.view.composing) throw new Error(t('editor.finishTheCurrentInputFirst'))
    const visible = { title: chapterInfo().title, content: editor.getJSON() as DocumentContent }
    const visibleId = chapter.id
    const hasChanges = change !== saved
    const bundle = await readBundle(edition)
    const infos = bundle.edition.chapters
    const index = infos.findIndex((entry) => entry.id === visibleId)
    if (index >= 0 && hasChanges) bundle.chapters[index] = { ...bundle.chapters[index], content: visible.content }
    const selection = selectedIds ? bundle.chapters.filter((_, i) => selectedIds.has(infos[i].id)) : bundle.chapters
    if (index < 0 && (!selectedIds || selectedIds.has(visibleId))) selection.push(visible)
    return selection
  }

  function changeMatch(offset: number) {
    const length = searchState(editor).matches.length
    if (!length) return
    activeMatch = (activeMatch + offset + length) % length
    refreshSearch(true)
  }

  findButton.addEventListener('click', () => { searchBar.hidden = false; query.focus(); query.select() })
  query.addEventListener('input', () => { activeMatch = 0; setSearch(editor, query.value); refreshSearch(true) })
  query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); changeMatch(event.shiftKey ? -1 : 1) }
    if (event.key === 'Escape') closeSearch.click()
  })
  nextMatch.addEventListener('click', () => changeMatch(1))
  previousMatch.addEventListener('click', () => changeMatch(-1))
  closeSearch.addEventListener('click', () => { searchBar.hidden = true; query.value = ''; setSearch(editor, ''); findButton.focus() })
  replace.addEventListener('click', () => {
    const match = searchState(editor).matches[activeMatch]
    if (editing && match) { replaceMatches(editor, [match], replacement.value); refreshSearch() }
  })
  replaceAll.addEventListener('click', () => {
    const { matches, overflow } = searchState(editor)
    if (editing && !overflow) { replaceMatches(editor, matches, replacement.value); refreshSearch() }
  })

  save.addEventListener('click', () => { void flush() })
  mode.addEventListener('click', async () => { if (await flush()) { editing = !editing; applyMode() } })
  add.addEventListener('click', () => formDialog(root, { title: t('editor.newChapter'), action: t('editor.createChapter'), fields: [nameField(t('editor.chapterTitle'))] },
    async (data) => alter({ type: 'add', title: String(data.get('name')) })))
  rename.addEventListener('click', () => formDialog(root, { title: t('editor.renameChapter'), action: t('editor.saveChapterTitle'), fields: [nameField(t('editor.chapterTitle'), chapterInfo().title)] },
    async (data) => alter({ type: 'rename', id: chapter.id, title: String(data.get('name')) })))
  up.addEventListener('click', () => { void alter({ type: 'move', id: chapter.id, offset: -1 }).catch(report) })
  down.addEventListener('click', () => { void alter({ type: 'move', id: chapter.id, offset: 1 }).catch(report) })
  remove.addEventListener('click', () => formDialog(root, { title: t('editor.deleteThisChapter'), action: t('editor.confirmChapterDeletion'), danger: true, description: t('editor.andItsTextWillBeMovedToThe', [chapterInfo().title]) },
    async () => alter({ type: 'delete', id: chapter.id })))
  removeVersion.addEventListener('click', () => formDialog(root, { title: t('editor.deleteThisEditableVersion'), action: t('editor.confirmVersionDeletion'), danger: true, description: t('editor.andAllItsChaptersWillBeMovedTo', [edition.name]) }, async () => {
    if (!await flush()) throw new Error(t('editor.saveTheCurrentChangesOrSaveASeparate'))
    const entry = await deleteEdition(edition)
    location.hash = bookPath(book.library, book.id)
    offerUndo(entry, (restored) => {
      if (restored.edition) location.hash = bookPath(book.library, book.id, restored.edition.id)
    })
  }))
  recover.addEventListener('click', () => formDialog(root, { title: t('editor.discardUnsavedChanges'), action: t('editor.discardAndReturnToLibrary'), danger: true, description: t('editor.theCurrentUnsavedTextWillBeDiscardedPreviously') }, async () => {
    window.clearTimeout(timer)
    if (pending) await pending
    saved = change
    window.removeEventListener('beforeunload', unsaved)
    location.hash = bookPath(book.library)
  }))
  saveCopy.addEventListener('click', () => formDialog(root, { title: t('editor.saveAsASeparateVersion'), action: t('editor.saveSeparateVersion'), fields: [nameField(t('editor.versionName'), t('editor.copy', [edition.name]))] }, async (data) => {
    await flush()
    const copy = await createEdition(book, await currentChapters(), { source: 'copy', copiedFrom: edition.id, notes: edition.notes, originalId: edition.originalId }, String(data.get('name')))
    window.clearTimeout(timer)
    saved = change
    window.removeEventListener('beforeunload', unsaved)
    location.hash = bookPath(book.library, book.id, copy.id)
  }))
  exportButton.addEventListener('click', () => {
    showExportDialog(root, book.title + ' - ' + edition.name, edition.chapters, async (info) => {
      const content = info.id === chapter.id
        ? editor.getJSON() as DocumentContent
        : (await readChapter(edition, info.id)).content
      return { title: info.title, content }
    }, currentChapters)
  })

  window.addEventListener('keydown', (event) => {
    if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.isComposing || document.querySelector('dialog[open]')) return
    if (event.key.toLowerCase() === 's') { event.preventDefault(); void flush() }
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); findButton.click() }
  }, { signal })
  document.addEventListener('visibilitychange', () => { if (document.hidden) void flush() }, { signal })
  window.addEventListener('pagehide', () => { void flush() }, { signal })
  signal.addEventListener('abort', () => {
    window.clearTimeout(timer)
    window.cancelAnimationFrame(refreshFrame)
    window.removeEventListener('beforeunload', unsaved)
    editor?.destroy()
  }, { once: true })
  mountChapter(chapter)
  registerLeave(flush)
  void chapterWordCounts(edition).then((stored) => {
    if (signal.aborted) return
    stored.set(chapter.id, liveCount())
    words = stored
    refreshWords()
  }, () => {})
}
