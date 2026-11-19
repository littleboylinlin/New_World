import { t } from '../i18n'
import { Editor } from '@tiptap/core'
import { formDialog, nameField } from '../dialogs'
import { libraryChanges, readBook, storageError } from '../library'
import type { Book } from '../library'
import { bookPath, button, element, icon, nextPaint, progressNotice } from '../ui'
import type { IconName } from '../ui'
import { offerUndo, showNotice } from '../undo'
import { appearanceMenu } from '../appearance-view'
import { appearance, onAppearanceChange } from '../appearance'
import { listIdeas, setIdeaUsed } from '../ideas'
import type { Idea } from '../ideas'
import { openCaptureDialog } from '../idea-capture'
import { fixedPage } from '../shell/fixed-page'
import { closeAllPopovers, menuButton } from '../shell/popover'
import type { ShellMenuItem } from '../shell/popover'
import { priorityToolbar } from '../shell/toolbar'
import { createTabs, createWorkbench } from '../shell/workbench'
import { showExportDialog } from './export-view'
import { cleanMarkup, inertMarkup, rasterData } from './markup'
import { countText, wordCount } from './model'
import type { ChapterInput, ChapterRecord, DocumentContent, Edition } from './model'
import { checkDocument, documentExtensions } from './schema'
import { countChapterRevisions } from './revisions'
import { showRevisionsDialog } from './revisions-view'
import { SearchHighlight } from './search'
import { mountFindPanel } from './find-panel'
import { chapterDirectory } from './chapter-directory'
import { selectionToolbar } from './selection-toolbar'
import { defaultSideWidth, lastChapter, readChapterPlace, readEditorPreferences, saveChapterPlace, updateEditorPreferences } from './editor-prefs'
import { changeChapters, chapterWordCounts, createEdition, deleteEdition, listEditions, readBundle, readChapter, saveChapter } from './store'
import { AnnotationDecorations, documentSurface } from '../annotations/surface'
import { readingAnnotations } from '../annotations/view'
import type { ReadingAnnotations } from '../annotations/view'
import './editor.css'
import { createLinkedTask, takeTaskJump } from '../tasks/links'
import { hashDocumentContent } from '../confirm-state'
import { writingMotion } from './writing-motion'
import { applyPlace, measurePlace } from './place'
import { isWebPane, mountSplitEditor } from './split-editor'
import { canBrowse } from './web-pane'
import { keepFromWeb, linkedText } from './web-keep'
import { webTab } from './web-tab'
import { renderTasks } from '../tasks/view'
import type { SplitEditor } from './split-editor'
import type { SelectionTarget } from './selection-toolbar'
import { rememberEdition, takeOpenRequest } from './compare'
import type { ReferenceSource } from './compare'
import { startOpenDrag } from '../shell/drag-open'

export type RegisterLeave = (callback: () => Promise<boolean>) => void

/** The work around the version being edited: its name, and what its menu offers. */
export interface WorkContext {
  title: string
  menu: () => ShellMenuItem[]
}

interface ActiveEditionSession {
  library: string
  bookId: string
  editionId: string
  getChapterId: () => string
  isDirty: () => boolean
  reload: () => Promise<void>
}

const activeSessions = new Set<ActiveEditionSession>()

export function hasDirtyOpenChapter(library: string, bookId: string, editionId?: string, chapterId?: string): boolean {
  for (const session of activeSessions) {
    if (session.library !== library || session.bookId !== bookId) continue
    if (editionId && session.editionId !== editionId) continue
    if (chapterId && session.getChapterId() !== chapterId) continue
    if (session.isDirty()) return true
  }
  return false
}

export async function syncOpenEditionFromExternal(library: string, bookId: string, editionId?: string): Promise<void> {
  for (const session of Array.from(activeSessions)) {
    if (session.library !== library || session.bookId !== bookId) continue
    if (editionId && session.editionId !== editionId) continue
    if (!session.isDirty()) {
      await session.reload()
    }
  }
}

const textTools = ['heading', 'bold', 'italic', 'underline', 'lists', 'quote', 'more-format'] as const
const insertTools = ['image', 'rule'] as const
const noteTools = ['note-add', 'note-list', 'note-display'] as const

/** Chapters this long take the browser noticeable time to lay out (about 60 000 characters). */
const isLongChapter = (record: ChapterRecord) => JSON.stringify(record.content).length > 120_000

export async function renderEdition(
  host: HTMLElement, root: HTMLElement, book: Book, initial: Edition, signal: AbortSignal, registerLeave: RegisterLeave,
  work: WorkContext = { title: book.title, menu: () => [] },
) {
  let edition = initial
  const remembered = lastChapter(edition)
  let chapter = await readChapter(edition, edition.chapters.some(({ id }) => id === remembered) ? remembered : edition.chapters[0].id)
  signal.throwIfAborted()
  let editor!: Editor
  let caret: ReturnType<typeof writingMotion> | undefined
  let annotations: ReadingAnnotations | undefined
  let editing = true
  let change = 0
  let saved = 0
  let timer: number | undefined
  let pending: Promise<boolean> | undefined
  let selectionRequest = 0
  let contentsTimer: number | undefined
  let formatFrame = 0
  let placeTimer = 0
  let currentWords = 0
  let countedChange = 0
  let historyTotal = 0
  // Word counts of the other chapters are read once. The open chapter is counted as it changes.
  let words: Map<string, number> | undefined
  let wordLabels = new Map<string, HTMLElement>()
  const number = (value: number) => value.toLocaleString('zh-CN')
  const preferences = readEditorPreferences()
  const coarse = matchMedia('(hover: none) and (pointer: coarse)')

  fixedPage(root, signal)

  // ——— Toolbar ———
  const workspace = element('section', 'edition-workspace editor-shell')
  const top = element('header', 'editor-toolbar')
  const row = element('div', 'toolbar-row')
  row.setAttribute('role', 'toolbar')
  row.setAttribute('aria-label', t('editor.toolbar'))
  const findHost = element('section', 'toolbar-find')
  const strip = element('div')
  top.append(row, findHost, strip)
  const bar = priorityToolbar(row)

  function tool(label: string, symbol: IconName | { glyph: string; className: string }, invoke: () => void, shortcut?: string, className = '') {
    const node = button('', `format-button ${className}`.trim())
    if (typeof symbol === 'string') node.append(icon(symbol))
    else node.append(element('span', `format-glyph ${symbol.className}`, symbol.glyph))
    node.setAttribute('aria-label', label)
    node.title = shortcut ? `${label}（${shortcut}）` : label
    node.addEventListener('mousedown', (event) => event.preventDefault())
    node.addEventListener('click', invoke)
    return node
  }
  function dropdown(label: string, symbol: IconName, className: string) {
    const node = button('', `format-button format-dropdown ${className}`)
    node.append(icon(symbol), element('span', 'dropdown-caret', '▾'))
    node.setAttribute('aria-label', label)
    node.title = label
    return node
  }
  const divider = (group: string) => bar.divider(group, element('span', 'format-divider'))

  const navToggle = tool(t('editor.chapterList'), 'sidebar', () => wb.start!.toggle(), undefined, 'nav-toggle')
  navToggle.setAttribute('aria-controls', `chapter-panel-${edition.id}`)

  const title = element('div', 'toolbar-title')
  const names = element('div', 'toolbar-names')
  const workName = button('', 'toolbar-name work-name')
  workName.append(element('span', 'toolbar-name-text', work.title))
  workName.title = t('editor.workMenu', [work.title])
  workName.setAttribute('aria-label', t('editor.workMenu', [work.title]))
  const nameSeparator = element('span', 'toolbar-name-separator', '/')
  nameSeparator.setAttribute('aria-hidden', 'true')
  const chapterName = button('', 'toolbar-name chapter-name')
  const chapterTitle = element('span', 'toolbar-name-text')
  chapterName.append(chapterTitle, element('span', 'dropdown-caret', '▾'))
  names.append(workName, nameSeparator, chapterName)
  const statusLine = element('div', 'toolbar-status')
  const status = element('span', 'save-status', t('editor.saved'))
  status.setAttribute('role', 'status')
  status.title = 'Ctrl / ⌘ + S'
  const count = element('span', 'word-count')
  count.title = t('editor.countRule')
  statusLine.append(status, count)
  title.append(names, statusLine)
  const readOnlyNote = element('span', 'reference-status', t('compare.readOnly'))
  readOnlyNote.hidden = true
  statusLine.append(readOnlyNote)
  // With a reference pane focused, the names and their menus follow that pane.
  menuButton(workName, work.title, () => {
    const reference = splitEditor.focusedReference()
    if (reference) return [...splitEditor.paneMenu(reference), { separator: true, label: '' }, ...splitEditor.compareMenu()]
    return [...splitEditor.compareMenu(), { separator: true, label: '' }, ...work.menu()]
  })
  menuButton(chapterName, t('editor.chapterList'), () => {
    const reference = splitEditor.focusedReference()
    if (reference) {
      const source = reference.source()
      return reference.chapters().map(({ id, title: name }, index) => ({
        label: `${String(index + 1).padStart(2, '0')}  ${name}`, checked: source.kind === 'chapter' && id === source.chapterId, radio: true,
        action: () => { void reference.switchChapter(id) },
      }))
    }
    return edition.chapters.map(({ id, title: name }, index) => ({
      label: `${String(index + 1).padStart(2, '0')}  ${name}`, checked: id === chapter.id, radio: true,
      action: () => { void switchChapter(id) },
    }))
  }, 'chapter-menu')

  const history = element('div', 'toolbar-group')
  const undo = tool(t('editor.undo'), 'undo', () => editor.chain().focus().undo().run(), 'Ctrl / ⌘ + Z')
  const redo = tool(t('editor.redo'), 'redo', () => editor.chain().focus().redo().run(), 'Ctrl / ⌘ + Shift + Z')
  history.append(bar.add({ id: 'undo', node: undo, priority: 95, group: 'history', menu: () => [{ label: t('editor.undo'), icon: 'undo', disabled: undo.disabled, action: () => undo.click() }] }),
    bar.add({ id: 'redo', node: redo, priority: 94, group: 'history', menu: () => [{ label: t('editor.redo'), icon: 'redo', disabled: redo.disabled, action: () => redo.click() }] }))

  const heading = element('select', 'editor-select')
  heading.setAttribute('aria-label', t('editor.paragraphStyle'))
  const headingLabels = [t('editor.paragraph'), t('editor.heading1'), t('editor.heading2'), t('editor.heading3'), t('editor.heading4'), t('editor.heading5'), t('editor.heading6')]
  for (const [value, label] of headingLabels.entries()) {
    const option = element('option', '', label)
    option.value = String(value)
    heading.append(option)
  }
  const setHeading = (level: number) => {
    if (splitEditor.focusedReference()) return
    const command = editor.chain().focus()
    if (!level) command.setParagraph().run()
    else command.setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run()
  }
  heading.addEventListener('change', () => setHeading(Number(heading.value)))

  const markControls: { node: HTMLButtonElement; active: string | (() => boolean) }[] = []
  const pressed = (node: HTMLButtonElement, active: string | (() => boolean)) => { markControls.push({ node, active }); return node }
  const bold = pressed(tool(t('editor.bold'), { glyph: 'B', className: 'format-bold' }, () => editor.chain().focus().toggleBold().run(), 'Ctrl / ⌘ + B'), 'bold')
  const italic = pressed(tool(t('editor.italic'), { glyph: 'I', className: 'format-italic' }, () => editor.chain().focus().toggleItalic().run(), 'Ctrl / ⌘ + I'), 'italic')
  const underline = pressed(tool(t('editor.underline'), { glyph: 'U', className: 'format-underline' }, () => editor.chain().focus().toggleUnderline().run(), 'Ctrl / ⌘ + U'), 'underline')
  const listItems = (): ShellMenuItem[] => [
    { label: t('editor.bulletedList'), icon: 'list', hint: 'Ctrl/⌘ ⇧ 8', checked: editor.isActive('bulletList'), action: () => editor.chain().focus().toggleBulletList().run() },
    { label: t('editor.numberedList'), icon: 'ordered', hint: 'Ctrl/⌘ ⇧ 7', checked: editor.isActive('orderedList'), action: () => editor.chain().focus().toggleOrderedList().run() },
  ]
  const lists = pressed(dropdown(t('editor.lists'), 'list', 'list-menu'), () => editor.isActive('bulletList') || editor.isActive('orderedList'))
  menuButton(lists, t('editor.lists'), listItems)
  const quote = pressed(tool(t('editor.blockQuote'), 'quote', () => editor.chain().focus().toggleBlockquote().run(), 'Ctrl / ⌘ + Shift + B'), 'blockquote')
  const moreFormatItems = (): ShellMenuItem[] => [
    { label: t('editor.strikethrough'), icon: 'strike', hint: 'Ctrl/⌘ ⇧ S', checked: editor.isActive('strike'), action: () => editor.chain().focus().toggleStrike().run() },
    { label: t('editor.inlineCode'), icon: 'code', hint: 'Ctrl/⌘ E', checked: editor.isActive('code'), action: () => editor.chain().focus().toggleCode().run() },
    { label: t('editor.codeBlock'), icon: 'codeBlock', hint: 'Ctrl/⌘ ⌥ C', checked: editor.isActive('codeBlock'), action: () => editor.chain().focus().toggleCodeBlock().run() },
  ]
  const moreFormat = pressed(dropdown(t('editor.moreFormatting'), 'format', 'more-format'), () => editor.isActive('strike') || editor.isActive('code') || editor.isActive('codeBlock'))
  menuButton(moreFormat, t('editor.moreFormatting'), moreFormatItems)

  const textGroup = element('div', 'toolbar-group toolbar-text')
  textGroup.setAttribute('role', 'group')
  textGroup.setAttribute('aria-label', t('editor.textFormatting'))
  const check = (label: string, iconName: IconName | undefined, active: () => boolean, invoke: () => void): ShellMenuItem => ({ label, icon: iconName, checked: active(), action: invoke })
  textGroup.append(
    divider('text'),
    bar.add({ id: 'heading', node: heading, priority: 70, group: 'text', menu: () => [{ label: t('editor.paragraphStyle'), icon: 'format', children: () => headingLabels.map((label, level) => ({ label, radio: true, checked: heading.value === String(level), action: () => setHeading(level) })) }] }),
    bar.add({ id: 'bold', node: bold, priority: 80, group: 'text', menu: () => [check(t('editor.bold'), undefined, () => editor.isActive('bold'), () => bold.click())] }),
    bar.add({ id: 'italic', node: italic, priority: 79, group: 'text', menu: () => [check(t('editor.italic'), undefined, () => editor.isActive('italic'), () => italic.click())] }),
    bar.add({ id: 'underline', node: underline, priority: 60, group: 'text', menu: () => [check(t('editor.underline'), undefined, () => editor.isActive('underline'), () => underline.click())] }),
    bar.add({ id: 'lists', node: lists, priority: 62, group: 'text', menu: () => [{ label: t('editor.lists'), icon: 'list', children: listItems }] }),
    bar.add({ id: 'quote', node: quote, priority: 55, group: 'text', menu: () => [check(t('editor.blockQuote'), 'quote', () => editor.isActive('blockquote'), () => quote.click())] }),
    bar.add({ id: 'more-format', node: moreFormat, priority: 52, group: 'text', menu: () => [{ label: t('editor.moreFormatting'), icon: 'format', children: moreFormatItems }] }),
  )

  const imageInput = element('input')
  imageInput.type = 'file'
  imageInput.accept = 'image/png,image/jpeg,image/gif,image/webp'
  imageInput.hidden = true
  imageInput.setAttribute('aria-label', t('editor.chooseAnImage'))
  let imageTarget: Editor | undefined
  const image = tool(t('docxExport.illustration'), 'image', () => { imageTarget = editor; imageInput.click() })
  const rule = tool(t('editor.horizontalRule'), 'rule', () => editor.chain().focus().setHorizontalRule().run())
  const insertGroup = element('div', 'toolbar-group toolbar-insert')
  insertGroup.setAttribute('role', 'group')
  insertGroup.setAttribute('aria-label', t('editor.insert'))
  insertGroup.append(
    divider('insert'),
    bar.add({ id: 'image', node: image, priority: 50, group: 'insert', menu: () => [{ label: t('docxExport.illustration'), icon: 'image', action: () => image.click() }] }),
    bar.add({ id: 'rule', node: rule, priority: 45, group: 'insert', menu: () => [{ label: t('editor.horizontalRule'), icon: 'rule', action: () => rule.click() }] }),
    imageInput,
  )
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

  // In reading mode the text and insert tools give way to the reading notes.
  const addNote = () => { if (!annotations?.addFromSelection()) showNotice(t('editor.selectTextToNote')) }
  const noteAdd = tool(t('editor.newNote'), 'note', addNote)
  noteAdd.classList.add('format-labelled')
  noteAdd.append(element('span', 'format-label', t('editor.newNote')))
  const noteList = tool(t('editor.noteList'), 'panel', () => openSide('notes'))
  const noteDisplayItems = (): ShellMenuItem[] => [
    { label: t('annotations.allinline'), action: () => annotations?.setAllDisplay('inline') },
    { label: t('annotations.allmark'), action: () => annotations?.setAllDisplay('mark') },
  ]
  const noteDisplay = dropdown(t('editor.noteDisplay'), 'note', 'note-display')
  menuButton(noteDisplay, t('editor.noteDisplay'), noteDisplayItems)
  const noteGroup = element('div', 'toolbar-group toolbar-notes')
  noteGroup.setAttribute('role', 'group')
  noteGroup.setAttribute('aria-label', t('annotations.title'))
  noteGroup.append(
    divider('notes'),
    bar.add({ id: 'note-add', node: noteAdd, priority: 78, group: 'notes', menu: () => [{ label: t('editor.newNote'), icon: 'note', action: addNote }] }),
    bar.add({ id: 'note-list', node: noteList, priority: 60, group: 'notes', menu: () => [{ label: t('editor.noteList'), icon: 'panel', action: () => openSide('notes') }] }),
    bar.add({ id: 'note-display', node: noteDisplay, priority: 50, group: 'notes', menu: () => [{ label: t('editor.noteDisplay'), icon: 'note', children: noteDisplayItems }] }),
  )

  const findButton = tool(t('editor.findReplace'), 'search', () => {}, 'Ctrl / ⌘ + F', 'find-toggle')
  const aa = appearanceMenu()
  const aaToggle = aa.querySelector<HTMLButtonElement>('.appearance-toggle')!
  const focusButton = tool(t('editor.focusMode'), 'focus', () => setFocus(!focused), 'Esc', 'focus-toggle')
  focusButton.setAttribute('aria-pressed', 'false')
  const sideButton = tool(t('editor.sidePanel'), 'panel', () => wb.end!.toggle(), undefined, 'side-toggle')
  sideButton.setAttribute('aria-controls', `side-panel-${edition.id}`)
  const ideasCount = element('span', 'trash-count side-count ideas-count')
  sideButton.append(ideasCount)
  const moreButton = tool(t('editor.moreActions'), 'more', () => {}, undefined, 'more-toggle')
  const right = element('div', 'toolbar-group toolbar-end')
  right.append(
    bar.add({ id: 'find', node: findButton, priority: 88, menu: () => [{ label: t('editor.findReplace'), icon: 'search', hint: 'Ctrl/⌘ F', action: () => find.open() }] }),
    bar.add({ id: 'appearance', node: aa, priority: 66, menu: () => [{ label: t('appearance.title'), icon: 'appearance', action: () => aa.openPanel(moreButton) }] }),
    bar.add({ id: 'focus', node: focusButton, priority: 40, menu: () => [{ label: t('editor.focusMode'), icon: 'focus', checked: focused, action: () => setFocus(!focused) }] }),
    bar.add({ id: 'side', node: sideButton, priority: 72, menu: () => [{ label: t('editor.sidePanel'), icon: 'panel', checked: wb.end!.isOpen(), action: () => wb.end!.toggle() }] }),
    moreButton,
  )
  row.append(navToggle, title, history, textGroup, insertGroup, noteGroup, right)

  // ——— Messages under the toolbar ———
  const notices = element('div', 'editor-notices')
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
  information.hidden = true
  notices.append(error, recover, information)

  // ——— Body: chapter list, text, side panel ———
  // On very wide windows both panels start a little wider; a width the writer dragged to is kept.
  const roomy = innerWidth >= 2200
  const wb = createWorkbench({
    signal,
    start: {
      label: t('editor.chapterList'), width: roomy ? 300 : 264, minWidth: 220, maxWidth: 320, inlineFrom: 720,
      openWhenInline: () => readEditorPreferences().navOpen !== false,
      onToggle: (open, byUser) => {
        if (open && wb?.start?.mode() === 'overlay') splitEditor?.closeDrawer()
        navToggle.setAttribute('aria-expanded', String(open))
        navToggle.setAttribute('aria-pressed', String(open))
        if (byUser) updateEditorPreferences({ navOpen: open })
      },
    },
    end: {
      label: t('editor.sidePanel'), width: roomy && preferences.sideWidth === defaultSideWidth ? 380 : preferences.sideWidth, minWidth: 260, maxWidth: 560, inlineFrom: 1000, resizable: true,
      openWhenInline: () => readEditorPreferences().sideOpen !== false,
      onToggle: (open, byUser) => {
        if (open && wb?.end?.mode() === 'overlay') splitEditor?.closeDrawer()
        sideButton.setAttribute('aria-expanded', String(open))
        sideButton.setAttribute('aria-pressed', String(open))
        if (byUser) updateEditorPreferences({ sideOpen: open })
        if (open) tabs.refresh()
      },
      onResize: (width) => updateEditorPreferences({ sideWidth: width }),
    },
  })
  wb.start!.element.id = `chapter-panel-${edition.id}`
  wb.end!.element.id = `side-panel-${edition.id}`

  const navigation = element('div', 'chapter-navigation')
  const navHead = element('div', 'chapter-nav-head')
  const navLabel = element('h2', 'chapter-nav-title', t('editor.chapterList'))
  const total = element('span', 'word-total')
  total.hidden = true
  navHead.append(navLabel, total)
  const chapterList = element('ol', 'chapter-list')
  chapterList.setAttribute('aria-label', t('content.chapters'))
  const live = element('p', 'visually-hidden')
  live.setAttribute('aria-live', 'polite')
  const add = button(t('editor.newChapter'), 'chapter-add', 'plus')
  const outline = element('nav', 'chapter-outline')
  outline.setAttribute('aria-label', t('editor.sectionsInThisChapter'))
  navigation.append(navHead, chapterList, add, outline, live)
  wb.start!.body.append(navigation)

  const scroller = element('div', 'editor-scroll')
  const paper = element('div', 'editor-paper')
  // The text inherits spell checking from here; the rest of the page never checks spelling.
  paper.spellcheck = appearance().spellcheck
  scroller.append(paper)
  const mainPaneNode = element('section', 'main-pane')
  mainPaneNode.setAttribute('aria-label', t('editor.chapterText'))
  mainPaneNode.append(scroller)
  let toolbarReady = false
  const splitEditor: SplitEditor = mountSplitEditor({
    host: wb.main, main: mainPaneNode, signal,
    edition: () => edition, chapterId: () => chapter.id,
    switchMain: (id) => switchChapter(id),
    onFocusChange: () => paintTarget(),
    beforeOpen: () => {
      for (const panel of [wb.start!, wb.end!]) if (panel.mode() === 'overlay' && panel.isOpen()) panel.setOpen(false)
    },
    onReferenceChange: (pane) => {
      if (!toolbarReady || pane !== splitEditor.focusedReference()) return
      find.chapterMounted()
      paintTarget()
    },
    onKeep: (kind, entry) => keepFromWeb(kind, entry, { library: edition.library, bookId: edition.bookId, title: book.title }),
  })
  right.insertBefore(bar.add({ id: 'compare', node: splitEditor.toggle, priority: 73, menu: () => [{ label: t('compare.drawer'), icon: 'compare', action: () => splitEditor.toggle.click() }] }), sideButton)

  const tabs = createTabs(t('editor.sidePanel'), (id) => updateEditorPreferences({ sideTab: id }))
  const ideasPanel = element('section', 'ideas-panel')
  ideasPanel.setAttribute('aria-label', t('ideas.forWork'))
  const notesPanel = element('section', 'notes-panel')
  const notesHint = element('p', 'dialog-help notes-hint', t('editor.notesInReadingMode'))
  const annotationTools = element('div', 'notes-host')
  notesPanel.append(notesHint, annotationTools)
  // ——— 灵感与待办: the work's ideas and its tasks, one at a time ———
  const ideasTasks = element('section', 'ideas-tasks-panel')
  ideasTasks.setAttribute('aria-label', t('editor.ideasAndTasks'))
  const parts = createTabs(t('editor.ideasAndTasks'), (id) => updateEditorPreferences({ ideasPart: id === 'tasks' ? 'tasks' : 'ideas' }))
  parts.element.classList.add('shell-tabs-segmented')
  const tasksPanel = element('section', 'side-tasks-panel')
  tasksPanel.setAttribute('aria-label', t('editor.tasksForWork'))
  parts.add({ id: 'ideas', label: t('ideas.title'), panel: ideasPanel })
  parts.add({ id: 'tasks', label: t('editor.tasksPart'), panel: tasksPanel })
  parts.select(preferences.ideasPart)
  ideasTasks.append(parts.element)

  // This work's tasks (the chapter's first), or every task: the tasks page's own list, rows and dialogs.
  const scope = element('div', 'task-scope')
  scope.setAttribute('role', 'group')
  scope.setAttribute('aria-label', t('editor.taskScope'))
  const scopeButtons = (['work', 'all'] as const).map((value) => {
    const choice = button(value === 'work' ? t('editor.taskScopeWork') : t('editor.taskScopeAll'), 'task-scope-button')
    choice.dataset.scope = value
    choice.addEventListener('click', () => setTaskScope(value))
    return choice
  })
  scope.append(...scopeButtons)
  const tasksHost = element('div', 'side-tasks-host')
  tasksPanel.append(scope, tasksHost)
  let taskScope = preferences.taskScope
  let openTasks = 0
  let ideas: Idea[] = []
  const workTasks = `work/${edition.library}/${edition.bookId}`
  const sideTasks = renderTasks(tasksHost, signal, taskScope === 'all' ? 'all' : workTasks, {
    link: () => ({ library: edition.library, bookId: edition.bookId, title: book.title }),
    chapter: () => ({ editionId: edition.id, chapterId: chapter.id }),
    onCount: (open) => { openTasks = open; paintCounts() },
  })
  function setTaskScope(value: 'work' | 'all') {
    taskScope = value
    updateEditorPreferences({ taskScope: value })
    for (const choice of scopeButtons) choice.setAttribute('aria-pressed', String(choice.dataset.scope === value))
    sideTasks.setRoute(value === 'all' ? 'all' : workTasks)
  }
  setTaskScope(taskScope)
  /** Shows the tasks half of the tab, for a task just made from the chapter or a selection. */
  function showTasks() {
    parts.select('tasks')
    openSide('ideas')
  }

  const ideasTab = tabs.add({ id: 'ideas', label: t('editor.ideasAndTasks'), panel: ideasTasks })
  tabs.add({ id: 'notes', label: t('editor.notesTab'), panel: notesPanel })
  tabs.add({ id: 'compare', label: t('compare.tab'), panel: splitEditor.panel })
  // Private web pages are a desktop feature; the web version shows no 网页 tab at all.
  if (canBrowse()) tabs.add({ id: 'web', label: t('web.tab'), panel: webTab((url, where) => splitEditor.openWeb(url, where), splitEditor.openItems, signal) })
  wb.end!.body.append(tabs.element)

  // The page keeps one top-level heading for assistive technology; the toolbar shows the name.
  const pageHeading = element('h1', 'visually-hidden', work.title)
  workspace.append(pageHeading, top, notices, wb.element)
  host.replaceChildren(workspace)
  wb.relayout()
  splitEditor.relayout()
  wb.start!.setOpen((preferences.navOpen ?? true) && wb.start!.mode() === 'inline', false, true)
  wb.end!.setOpen((preferences.sideOpen ?? true) && wb.end!.mode() === 'inline', false, true)
  navToggle.setAttribute('aria-expanded', String(wb.start!.isOpen()))
  sideButton.setAttribute('aria-expanded', String(wb.end!.isOpen()))
  tabs.select(preferences.sideTab)

  function openSide(tab: string) {
    tabs.select(tab)
    wb.end!.setOpen(true, true)
  }

  const find = mountFindPanel({
    host: findHost, trigger: findButton, signal,
    getEditor: () => splitEditor.focusedReference()?.editor() ?? editor,
    getScroller: () => splitEditor.focusedReference()?.scroller ?? scroller,
    getEdition: () => splitEditor.focusedReference()?.edition() ?? edition,
    getChapterId: () => {
      const source = splitEditor.focusedReference()?.source()
      return source?.kind === 'chapter' ? source.chapterId : chapter.id
    },
    switchChapter: (id, wanted) => {
      const reference = splitEditor.focusedReference()
      return reference ? reference.switchChapter(id, wanted) : switchChapter(id, wanted)
    },
  })

  const directory = chapterDirectory({
    list: chapterList, live, signal,
    chapters: () => edition.chapters, current: () => chapter.id, canEdit: () => editing,
    open: (id) => { void switchChapter(id) },
    reorder: async (order) => { await alter({ type: 'reorder', order }).catch((cause) => { report(cause); throw cause }) },
    rename: (id) => renameChapter(id),
    remove: (id) => removeChapter(id),
    openItems: (id) => splitEditor.openItems(() => chapterSource(id)),
    panel: () => wb.start!.element,
    dragOut: (id, event) => {
      const source = chapterSource(id)
      startOpenDrag({ label: chapterInfo(id).title, payload: { source }, x: event.clientX, y: event.clientY, pointerId: event.pointerId })
    },
  })
  function chapterSource(id: string): ReferenceSource {
    return { kind: 'chapter', library: edition.library, bookId: edition.bookId, editionId: edition.id, chapterId: id }
  }

  const selection = selectionToolbar({
    strip, signal,
    targets: () => [
      { root: editor.view.dom, scroller, editor, editing, kinds: editing ? ['bold', 'italic', 'idea', 'task'] : ['idea', 'task', 'annotate'] },
      ...splitEditor.references().flatMap((pane): SelectionTarget[] => {
        const root = pane.textRoot()
        return root ? [{ root, scroller: pane.scroller, editor: pane.editor(), editing: false, kinds: ['idea'] }] : []
      }),
    ],
    actions: {
      bold: () => editor.chain().focus().toggleBold().run(),
      italic: () => editor.chain().focus().toggleItalic().run(),
      idea: (text) => openCaptureDialog({ library: edition.library, bookId: edition.bookId }, text),
      task: () => chapterTask(),
      annotate: () => addNote(),
    },
  })

  function chapterTask() {
    const { from, to } = editor.state.selection
    const content = editor.getJSON() as DocumentContent
    void createLinkedTask({
      library: edition.library, bookId: edition.bookId, title: book.title, editionId: edition.id, chapterId: chapter.id,
      position: { from, to, quote: editor.state.doc.textBetween(from, to, '\n').slice(0, 2000), contentHash: hashDocumentContent(content) },
    }, {}, showTasks).catch((cause) => showNotice(storageError(cause)))
  }

  function report(cause: unknown, saving = false) {
    error.textContent = t('common.concatenate', [saving ? t('editor.saveFailed') : '', storageError(cause)])
    error.hidden = false
    recover.hidden = !saving || change === saved
    if (saving) status.textContent = t('editor.unsavedFailed')
  }

  function scheduleSave() {
    window.clearTimeout(timer)
    if (!editor.view.composing) timer = window.setTimeout(() => { void flush(false) }, 500)
  }

  function scheduleContents() {
    window.clearTimeout(contentsTimer)
    if (!editor.view.composing) contentsTimer = window.setTimeout(refreshContents, 400)
  }

  function scheduleFormat() {
    if (signal.aborted || editor.isDestroyed) return
    if (!formatFrame) formatFrame = requestAnimationFrame(() => {
      formatFrame = 0
      if (signal.aborted || editor.isDestroyed) return
      refreshFormat()
    })
  }

  function unsaved(event: BeforeUnloadEvent) {
    event.preventDefault()
    event.returnValue = ''
  }

  async function flush(immediate = true) {
    window.clearTimeout(timer)
    while (change !== saved || pending) {
      if (!pending) {
        if (editor.view.composing) {
          status.textContent = t('editor.saveAfterTypingFinishes')
          return false
        }
        // A chapter can be saved and switched before the deferred count has run.
        if (immediate && countedChange !== change) {
          window.clearTimeout(contentsTimer)
          refreshContents()
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
      // Background saves never pull another full snapshot into a new typing burst.
      if (!immediate && change !== saved) { scheduleSave(); return false }
    }
    return true
  }

  function chapterInfo(id = chapter.id) {
    return edition.chapters.find((entry) => entry.id === id) ?? { id, title: chapterTitle.textContent || t('editor.chapterRemoved') }
  }

  const liveCount = () => countText(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n'))

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
    if (editor.view.composing) return
    const current = liveCount()
    currentWords = current
    countedChange = change
    count.textContent = t('editor.chapterCharacters', [number(current)])
    words?.set(chapter.id, current)
    refreshWords(false)
    outline.replaceChildren()
    const links = element('ul')
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'heading' && node.textContent.trim()) {
        const item = element('li')
        const jump = button(node.textContent.slice(0, 100), 'outline-jump')
        jump.addEventListener('click', () => {
          (editor.view.nodeDOM(position) as Element | null)?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
          if (wb.start!.mode() === 'overlay') wb.start!.setOpen(false)
        })
        item.append(jump)
        links.append(item)
      }
      return !node.isTextblock
    })
    if (links.childNodes.length) outline.append(element('strong', '', t('editor.sectionsInThisChapter')), links)
  }

  // The editing tools only work on the editable pane; with a reference focused they rest.
  const editNodes: (HTMLButtonElement | HTMLSelectElement)[] = [heading, bold, italic, underline, lists, quote, moreFormat, image, rule, noteAdd, noteDisplay]
  function refreshFormat() {
    const locked = Boolean(splitEditor.focusedReference())
    for (const { node, active } of markControls) node.setAttribute('aria-pressed', String(!locked && (typeof active === 'string' ? editor.isActive(active) : active())))
    heading.value = editor.isActive('heading') ? String(editor.getAttributes('heading').level) : '0'
    for (const node of editNodes) node.disabled = locked
    undo.disabled = locked || !editing || !editor.can().undo()
    redo.disabled = locked || !editing || !editor.can().redo()
    selection.refresh()
  }

  let targeted: unknown
  function paintTarget() {
    if (!toolbarReady) return
    const reference = splitEditor.focusedReference()
    if (targeted !== reference) {
      // The find bar belongs to the pane it searched; another pane starts afresh.
      if (find.isOpen()) find.close(false)
      selection.hide(true)
      targeted = reference
    }
    workspace.classList.toggle('reference-focused', Boolean(reference))
    const name = reference ? reference.title() || t('compare.loading') : work.title
    workName.querySelector('.toolbar-name-text')!.textContent = name
    workName.title = t('editor.workMenu', [name])
    workName.setAttribute('aria-label', t('editor.workMenu', [name]))
    readOnlyNote.hidden = !reference
    readOnlyNote.textContent = isWebPane(reference) ? t('web.privateNote') : t('compare.readOnly')
    findButton.disabled = Boolean(reference && !reference.editor())
    chapterName.disabled = Boolean(reference && reference.chapters().length < 2)
    bar.setAvailable('compare', splitEditor.isNarrow() && splitEditor.references().length > 0)
    paintChapterName()
    refreshFormat()
  }

  /** The chapter name in the toolbar: the focused pane's. Changing focus touches nothing else. */
  function paintChapterName() {
    const reference = splitEditor.focusedReference()
    const shown = reference ? reference.part() : chapterInfo().title
    chapterTitle.textContent = shown
    chapterName.title = t('editor.switchChapter')
    chapterName.setAttribute('aria-label', t('editor.switchChapterNamed', [shown]))
  }

  // The chapter list is rebuilt only when the chapters or the mode change, never for a change of
  // focus or a pane beside the text loading: a rebuild would pull the entry out from under a press,
  // a drag or an open menu.
  function refreshChapters() {
    paintChapterName()
    navLabel.textContent = t('editor.chapterList105', [edition.chapters.length])
    wordLabels = directory.render()
    refreshWords()
  }

  function applyMode() {
    annotations?.()
    annotations = undefined
    editor.setEditable(editing, false)
    editor.view.dom.setAttribute('role', editing ? 'textbox' : 'document')
    workspace.classList.toggle('edition-reading', !editing)
    for (const id of [...textTools, ...insertTools]) bar.setAvailable(id, editing)
    for (const id of noteTools) bar.setAvailable(id, !editing)
    add.hidden = !editing
    notesHint.hidden = !editing
    tabs.setDisabled('notes', false)
    caret?.refresh()
    if (!editing) {
      annotations = readingAnnotations(documentSurface(editor), annotationTools, {
        kind: 'chapter', library: edition.library, bookId: edition.bookId, editionId: edition.id,
        chapterId: chapter.id, sourceRevision: chapter.revision,
      }, signal, { embedded: true, onChange: (amount) => tabs.setCount('notes', amount ? String(amount) : '') })
    } else tabs.setCount('notes', '')
    find.modeChanged()
    refreshFormat()
    selection.hide(true)
  }

  // ——— Where each chapter was left ———
  function capturePlace() {
    if (!editor || editor.isDestroyed) return
    saveChapterPlace(edition, chapter.id, measurePlace(editor, scroller))
  }
  function restorePlace() {
    applyPlace(editor, scroller, readChapterPlace(edition, chapter.id))
  }
  scroller.addEventListener('scroll', () => {
    window.clearTimeout(placeTimer)
    placeTimer = window.setTimeout(capturePlace, 250)
  }, { passive: true, signal })

  function mountChapter(next: ChapterRecord, turn?: 'next' | 'previous', restore = true) {
    checkDocument(next.content)
    if (editor) { find.beforeChapterChange(); window.clearTimeout(placeTimer); capturePlace() }
    annotations?.()
    annotations = undefined
    caret?.destroy()
    caret = undefined
    window.clearTimeout(contentsTimer)
    window.cancelAnimationFrame(formatFrame)
    formatFrame = 0
    editor?.destroy()
    paper.replaceChildren()
    chapter = next
    // The comparison list marks the chapter being edited; the tasks put this chapter's first.
    splitEditor.refreshPanel()
    sideTasks.repaint()
    change = saved = 0
    status.textContent = t('editor.saved')
    error.hidden = recover.hidden = true
    editor = new Editor({
      element: paper, extensions: [...documentExtensions, SearchHighlight, AnnotationDecorations], content: next.content, editable: editing,
      editorProps: {
        handleScrollToSelection: () => caret?.handlesScroll() ?? false,
        attributes: { class: 'novel-body', 'aria-label': t('editor.chapterText'), 'aria-multiline': 'true', ...(turn ? { 'data-turn': turn } : {}) },
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
        const unsavedLabel = t('editor.unsaved')
        if (status.textContent !== unsavedLabel) status.textContent = unsavedLabel
        window.addEventListener('beforeunload', unsaved)
        scheduleSave()
        scheduleContents()
        find.documentChanged()
      },
    })
    editor.on('transaction', scheduleFormat)
    editor.on('selectionUpdate', () => {
      window.clearTimeout(placeTimer)
      placeTimer = window.setTimeout(capturePlace, 400)
    })
    editor.view.dom.addEventListener('compositionstart', () => {
      window.clearTimeout(timer)
      window.clearTimeout(contentsTimer)
    })
    editor.view.dom.addEventListener('compositionend', () => {
      if (change !== saved) { scheduleSave(); scheduleContents() }
    })
    caret = writingMotion(editor, paper)
    selection.hide(true)
    applyMode()
    refreshChapters()
    refreshContents()
    refreshFormat()
    if (restore) restorePlace()
    find.chapterMounted()
    void refreshHistoryCount()
  }

  async function refreshHistoryCount() {
    const targetChapterId = chapter.id
    try {
      const totalRevisions = await countChapterRevisions(edition, targetChapterId)
      if (signal.aborted || chapter.id !== targetChapterId) return
      historyTotal = totalRevisions
    } catch {
      // Ignore transient count failure when leaving editor
    }
  }

  async function switchChapter(id: string, wanted: () => boolean = () => true) {
    const request = ++selectionRequest
    const current = () => !signal.aborted && request === selectionRequest && wanted()
    if (id === chapter.id) return current()
    try {
      if (!await flush() || !current()) return false
      const next = await readChapter(edition, id)
      if (!await flush() || !current()) return false
      const order = (target: string) => edition.chapters.findIndex((entry) => entry.id === target)
      if (isLongChapter(next)) {
        status.textContent = t('editor.openingLongChapter')
        await nextPaint()
        if (!current()) return false
      }
      mountChapter(next, order(id) < order(chapter.id) ? 'previous' : 'next')
      if (wb.start!.mode() === 'overlay') wb.start!.setOpen(false)
      return true
    } catch (cause) {
      report(cause)
      return false
    }
  }

  async function alter(changeRequest: Parameters<typeof changeChapters>[1]) {
    if (!await flush()) throw new Error(t('editor.resolveUnsavedChangesFirst'))
    const result = await changeChapters(edition, changeRequest)
    edition = result.edition
    const stillThere = edition.chapters.some((entry) => entry.id === chapter.id)
    // Only a new chapter, or losing the open one, moves the text; other changes stay where they are.
    if (changeRequest.type === 'add' || !stillThere) await switchChapter(result.selected)
    else refreshChapters()
    find.chaptersChanged()
    if (result.trashed) offerUndo(result.trashed, (restored) => {
      if (signal.aborted || !restored.edition) return
      const [record] = restored.entry.chapters
      edition = restored.edition
      words?.set(record.id, wordCount(record.content))
      refreshChapters()
      find.chaptersChanged()
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

  // Focus mode hides everything around the text until it is turned off or the page changes.
  let focused = false
  function setFocus(on: boolean) {
    focused = on
    document.documentElement.classList.toggle('focus-writing', on)
    focusButton.setAttribute('aria-pressed', String(on))
    const label = on ? t('editor.exitFocus') : t('editor.focusMode')
    focusButton.setAttribute('aria-label', label)
    focusButton.title = `${label}（Esc）`
  }
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !focused || event.isComposing || document.querySelector('dialog[open]')) return
    // Escape first closes the find bar, an open menu or panel, or the selection tools.
    if (event.target instanceof Element && event.target.closest('.search-panel, .shell-layer, .workbench-panel[data-mode="overlay"]')) return
    event.preventDefault()
    setFocus(false)
  }, { signal })

  // ——— Ideas for this work ———
  let ideasRequest = 0
  let ideasBody: HTMLElement | undefined
  const capture = button(t('ideas.capture'), 'button button-quiet button-small ideas-capture-button', 'plus')
  capture.addEventListener('click', () => openCaptureDialog({ library: edition.library, bookId: edition.bookId }))
  ideasPanel.append(capture)

  function insertIdea(idea: Idea) {
    if (!editing) return
    const paragraphs = idea.text.split(/\n+/).map((line) => line.trim()).filter(Boolean)
      .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
    editor.chain().focus().insertContent(paragraphs).run()
    void setIdeaUsed(idea, true).catch(report)
  }
  /** The tab and the toolbar button count both halves; each half counts its own. */
  function paintCounts() {
    const waiting = ideas.filter((idea) => !idea.usedAt).length
    const total = waiting + openTasks
    ideasCount.textContent = total ? String(total) : ''
    tabs.setCount('ideas', total ? String(total) : '')
    parts.setCount('ideas', waiting ? String(waiting) : '')
    parts.setCount('tasks', openTasks ? String(openTasks) : '')
    ideasTab.title = total ? t('editor.ideasAndTasksCount', [waiting, openTasks]) : ''
  }
  function paintIdeas() {
    const waiting = ideas.filter((idea) => !idea.usedAt)
    paintCounts()
    let nextBody: HTMLElement
    if (ideas.length) {
      const list = element('ul', 'ideas-panel-list')
      for (const idea of [...waiting, ...ideas.filter((item) => item.usedAt)]) {
        const item = element('li', idea.usedAt ? 'idea-used' : '')
        const text = element('p', 'idea-text')
        text.append(linkedText(idea.text, canBrowse() ? (url) => splitEditor.openWeb(url) : undefined))
        const insert = button(t('ideas.insert'), 'button button-quiet button-small')
        insert.addEventListener('mousedown', (event) => event.preventDefault())
        insert.addEventListener('click', () => insertIdea(idea))
        const used = button(idea.usedAt ? t('ideas.markUnused') : t('ideas.markUsed'), 'button button-quiet button-small')
        used.addEventListener('click', () => { void setIdeaUsed(idea, !idea.usedAt).catch(report) })
        const actions = element('div', 'ideas-panel-actions')
        actions.append(insert, used)
        item.append(text, actions)
        list.append(item)
      }
      nextBody = list
    } else {
      nextBody = element('p', 'dialog-help', t('ideas.noneForWork'))
    }
    if (ideasBody?.parentElement === ideasPanel) ideasBody.replaceWith(nextBody)
    else ideasPanel.insertBefore(nextBody, capture)
    ideasBody = nextBody
  }
  async function refreshIdeas() {
    const turn = ++ideasRequest
    try {
      const next = (await listIdeas()).filter((idea) => idea.library === edition.library && idea.bookId === edition.bookId)
      if (signal.aborted || turn !== ideasRequest) return
      ideas = next
      paintIdeas()
    } catch { /* The panel keeps what it showed. */ }
  }
  libraryChanges.addEventListener('update', () => { void refreshIdeas() }, { signal })
  void refreshIdeas()

  // ——— Chapter actions ———
  function renameChapter(id: string) {
    formDialog(root, { title: t('editor.renameChapter'), action: t('editor.saveChapterTitle'), fields: [nameField(t('editor.chapterTitle'), chapterInfo(id).title)] },
      async (data) => alter({ type: 'rename', id, title: String(data.get('name')) }))
  }
  function removeChapter(id: string) {
    formDialog(root, { title: t('editor.deleteThisChapter'), action: t('editor.confirmChapterDeletion'), danger: true, description: t('editor.andItsTextWillBeMovedToThe', [chapterInfo(id).title]) },
      async () => alter({ type: 'delete', id }))
  }
  add.addEventListener('click', () => formDialog(root, { title: t('editor.newChapter'), action: t('editor.createChapter'), fields: [nameField(t('editor.chapterTitle'))] },
    async (data) => alter({ type: 'add', title: String(data.get('name')) })))

  // ——— "⋯": everything that does not need to be one click away ———
  async function toggleMode() {
    if (!await flush()) return
    closeAllPopovers()
    editing = !editing
    applyMode()
    refreshChapters()
  }
  function saveCopy() {
    formDialog(root, { title: t('editor.saveAsASeparateVersion'), action: t('editor.saveSeparateVersion'), fields: [nameField(t('editor.versionName'), t('editor.copy', [edition.name]))] }, async (data) => {
      await flush()
      const copy = await createEdition(book, await currentChapters(), { source: 'copy', copiedFrom: edition.id, notes: edition.notes, originalId: edition.originalId }, String(data.get('name')))
      window.clearTimeout(timer)
      saved = change
      window.removeEventListener('beforeunload', unsaved)
      location.hash = bookPath(book.library, book.id, copy.id)
    })
  }
  function exportVersion() {
    const readWork = async () => {
      const stored = await readBook(book.library, book.id)
      if (!stored) throw new Error(t('store.thisWorkHasBeenRemovedFromTheLibrary'))
      return stored.book
    }
    void readWork().then((current) => {
      if (signal.aborted) return
      showExportDialog(root, current.title + ' - ' + edition.name, edition.chapters, async (info) => {
        const content = info.id === chapter.id
          ? editor.getJSON() as DocumentContent
          : (await readChapter(edition, info.id)).content
        return { title: info.title, content }
      }, currentChapters, readWork)
    }, (cause) => report(cause))
  }
  function showHistory() {
    void showRevisionsDialog({
      root,
      edition,
      chapterId: chapter.id,
      chapterTitle: chapterInfo().title,
      onBeforeRestore: flush,
      onRestored: async () => {
        const currentEditions = await listEditions(edition.library, edition.bookId)
        const latest = currentEditions.find((item) => item.id === edition.id)
        if (latest) edition = latest
        const restoredChapter = await readChapter(edition, chapter.id)
        words = await chapterWordCounts(edition)
        mountChapter(restoredChapter)
      },
    })
  }
  function removeVersion() {
    formDialog(root, { title: t('editor.deleteThisEditableVersion'), action: t('editor.confirmVersionDeletion'), danger: true, description: t('editor.andAllItsChaptersWillBeMovedTo', [edition.name]) }, async () => {
      if (!await flush()) throw new Error(t('editor.saveTheCurrentChangesOrSaveASeparate'))
      const entry = await deleteEdition(edition)
      location.hash = bookPath(book.library, book.id)
      offerUndo(entry, (restored) => {
        if (restored.edition) location.hash = bookPath(book.library, book.id, restored.edition.id)
      })
    })
  }
  const formatIds = [...textTools, ...insertTools, ...noteTools]
  let formatCollapsed = preferences.formatCollapsed
  bar.setCollapsed(formatIds, formatCollapsed)
  const viewTools = new Set(['find', 'appearance', 'focus', 'side', 'compare'])
  menuButton(moreButton, t('editor.moreActions'), () => {
    const reference = splitEditor.focusedReference()
    if (reference) {
      const overflow = bar.overflowMenu((id) => viewTools.has(id))
      return [...overflow, ...(overflow.length ? [{ separator: true, label: '' }] : []), ...splitEditor.paneMenu(reference)]
    }
    const overflow = bar.overflowMenu()
    // On a phone the work's name gives way to the chapter's; its menu then lives here.
    const workHidden = !workName.offsetParent
    return [
      ...(workHidden ? [{ label: t('editor.workMenu', [work.title]), icon: 'book' as const, children: work.menu }] : []),
      ...overflow,
      ...(overflow.length ? [{ separator: true, label: '' }] : []),
      ...(canBrowse() ? [{ label: t('web.open'), icon: 'compare' as const, action: () => splitEditor.openWeb() }] : []),
      { label: editing ? t('editor.readingMode') : t('editor.editText'), icon: editing ? 'book' : 'edit', action: () => { void toggleMode() } },
      { label: t('editor.saveAsASeparateVersion'), icon: 'copy', action: saveCopy },
      { label: t('editor.export'), icon: 'download', action: exportVersion },
      { label: t('revisions.button'), icon: 'history', hint: historyTotal ? String(historyTotal) : undefined, action: showHistory },
      { label: t('tasks.addChapterTask'), icon: 'check', action: chapterTask },
      ...(edition.notes.length ? [{ label: t('editor.viewConversionNotes'), icon: 'file' as const, action: () => { information.hidden = false; information.open = true } }] : []),
      { label: formatCollapsed ? t('editor.showFormatting') : t('editor.hideFormatting'), icon: 'format', action: () => {
        formatCollapsed = !formatCollapsed
        updateEditorPreferences({ formatCollapsed })
        bar.setCollapsed(formatIds, formatCollapsed)
      } },
      { separator: true, label: '' },
      { label: t('editor.deleteVersion'), icon: 'trash', danger: true, action: removeVersion },
    ]
  }, 'more-menu')

  recover.addEventListener('click', () => formDialog(root, { title: t('editor.discardUnsavedChanges'), action: t('editor.discardAndReturnToLibrary'), danger: true, description: t('editor.theCurrentUnsavedTextWillBeDiscardedPreviously') }, async () => {
    window.clearTimeout(timer)
    if (pending) await pending
    saved = change
    window.removeEventListener('beforeunload', unsaved)
    location.hash = bookPath(book.library)
  }))
  libraryChanges.addEventListener('update', () => { void refreshHistoryCount() }, { signal })

  window.addEventListener('keydown', (event) => {
    if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.isComposing || document.querySelector('dialog[open]')) return
    if (event.key.toLowerCase() === 's') { event.preventDefault(); void flush() }
  }, { signal })
  document.addEventListener('visibilitychange', () => { if (document.hidden) { capturePlace(); void flush() } }, { signal })
  window.addEventListener('pagehide', () => { capturePlace(); void flush() }, { signal })
  coarse.addEventListener('change', () => bar.layout(), { signal })
  const stopFollowing = onAppearanceChange((value) => { paper.spellcheck = value.spellcheck; bar.layout() })
  const session: ActiveEditionSession = {
    library: edition.library,
    bookId: edition.bookId,
    editionId: edition.id,
    getChapterId: () => chapter.id,
    isDirty: () => change !== saved || Boolean(editor?.view.composing),
    reload: async () => {
      if (signal.aborted || change !== saved || editor?.view.composing) return
      const currentEditions = await listEditions(edition.library, edition.bookId)
      const latest = currentEditions.find((item) => item.id === edition.id)
      if (!latest || signal.aborted) return
      edition = latest
      const targetId = latest.chapters.some((item) => item.id === chapter.id) ? chapter.id : latest.chapters[0]?.id
      if (!targetId) return
      const next = await readChapter(latest, targetId)
      if (signal.aborted || change !== saved || editor?.view.composing) return
      words = await chapterWordCounts(latest)
      mountChapter(next)
    },
  }
  activeSessions.add(session)
  signal.addEventListener('abort', () => {
    activeSessions.delete(session)
    capturePlace()
    stopFollowing()
    setFocus(false)
    closeAllPopovers()
    bar.destroy()
    window.clearTimeout(timer)
    window.clearTimeout(contentsTimer)
    window.clearTimeout(placeTimer)
    window.cancelAnimationFrame(formatFrame)
    window.removeEventListener('beforeunload', unsaved)
    annotations?.()
    caret?.destroy()
    editor?.destroy()
  }, { once: true })
  // A very long chapter takes the browser a few seconds to lay out: say so before it starts.
  if (isLongChapter(chapter)) {
    const loading = progressNotice(t('editor.openingLongChapter'))
    loading.element.classList.add('editor-loading')
    paper.replaceChildren(loading.element)
    await nextPaint()
    if (signal.aborted) return
  }
  mountChapter(chapter)
  toolbarReady = true
  paintTarget()
  rememberEdition(edition)
  const waiting = takeOpenRequest()
  if (waiting) splitEditor.open(waiting.source, waiting.placement)
  registerLeave(flush)
  const jump = takeTaskJump(edition)
  if (jump?.chapterId) {
    await switchChapter(jump.chapterId)
    if (!signal.aborted && chapter.id === jump.chapterId && jump.position) {
      if (hashDocumentContent(chapter.content) === jump.position.contentHash && jump.position.to <= editor.state.doc.content.size) editor.commands.setTextSelection({ from: jump.position.from, to: jump.position.to })
      else showNotice(t('tasks.stalePosition'))
    }
  }
  void chapterWordCounts(edition).then((stored) => {
    if (signal.aborted) return
    stored.set(chapter.id, currentWords)
    words = stored
    refreshWords()
  }, () => {})
}
