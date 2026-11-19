import { Editor } from '@tiptap/core'
import { t } from '../i18n'
import { readBook, storageError } from '../library'
import type { Book, ImportedBook } from '../library'
import { formats } from '../formats'
import { menuButton } from '../shell/popover'
import type { ShellMenuItem } from '../shell/popover'
import { button, element, notice } from '../ui'
import { chapterText } from './model'
import type { ChapterInfo, ChapterRecord, Edition } from './model'
import { documentExtensions } from './schema'
import { SearchHighlight } from './search'
import { chapterSaves, listEditions, readChapter } from './store'
import { readChapterPlace, saveChapterPlace } from './editor-prefs'
import { applyPlace, measurePlace } from './place'
import { readFilePlace, saveFilePlace } from './compare'
import type { ReferenceSource } from './compare'

export interface ReferencePaneOptions {
  source: ReferenceSource
  signal: AbortSignal
  /** Entries of the small menu in the pane's corner. */
  menu: () => ShellMenuItem[]
  /** Without it the pane has no close button (a reading window closes with the window). */
  onClose?: () => void
  /** The title, the chapter or the loaded text changed. */
  onChange?: () => void
}

/** Reads every section of an original file as plain text, one string per section or page. */
async function fileSections(book: ImportedBook, blob: Blob, signal: AbortSignal): Promise<{ count: number; read: (index: number) => Promise<string> }> {
  const format = formats[book.format]
  if (format.preview === null) throw new Error(t('compare.noPreview', [format.label]))
  if (format.preview === 'text') {
    const { openText } = await import('../text-preview')
    const { text } = await openText(blob, book.format === 'html')
    return { count: 1, read: async () => text }
  }
  if (format.preview === 'rtf') {
    const { readRtf } = await import('./rtf')
    const text = chapterText(await readRtf(blob))
    return { count: 1, read: async () => text }
  }
  if (format.preview === 'pdf') {
    const { openPdf } = await import('../pdf-preview')
    const pdf = await openPdf(blob, signal)
    return { count: pdf.length, read: (index) => pdf.readText(index) }
  }
  const { openEpub, openDocx, openOdt } = await import('../archive-preview')
  if (book.format === 'epub') {
    const epub = await openEpub(blob, signal)
    return { count: epub.length, read: (index) => epub.readSection(index) }
  }
  const text = await (book.format === 'docx' ? openDocx : openOdt)(blob, signal)
  return { count: 1, read: async () => text }
}

/**
 * A read-only pane beside the text: a chapter of any version, or an imported work's original file.
 * The text can be selected and copied, and each source opens where it was last left.
 */
export function referencePane(options: ReferencePaneOptions) {
  const lifetime = new AbortController()
  const { signal } = lifetime
  options.signal.addEventListener('abort', () => lifetime.abort(), { once: true, signal })
  const root = element('section', 'reference-pane')
  root.setAttribute('aria-roledescription', t('compare.pane'))
  const scroller = element('div', 'editor-scroll reference-scroll')
  scroller.tabIndex = -1
  const paper = element('div', 'editor-paper reference-paper')
  scroller.append(paper)
  const corner = element('div', 'pane-corner')
  const menu = button('', 'pane-corner-button pane-menu', 'more')
  menu.setAttribute('aria-label', t('compare.paneMenu'))
  menu.title = t('compare.paneMenu')
  menuButton(menu, t('compare.paneMenu'), options.menu)
  corner.append(menu)
  if (options.onClose) {
    const close = button('', 'pane-corner-button pane-close', 'close')
    close.setAttribute('aria-label', t('compare.close'))
    close.title = t('compare.close')
    close.addEventListener('click', () => options.onClose!())
    corner.append(close)
  }
  root.append(scroller, corner)

  let source = options.source
  let editor: Editor | undefined
  let edition: Edition | undefined
  let book: Book | undefined
  let record: ChapterRecord | undefined
  let fileBook: ImportedBook | undefined
  let text: HTMLElement | undefined
  let loadedSections = 0
  let request = 0
  let placeTimer = 0
  let problem = ''
  // Restoring a place scrolls the pane; that scroll is not the reader moving.
  let restoring = false
  // A closed pane already recorded its place; taking it off the page must not overwrite that.
  let closed = false

  function label() {
    root.setAttribute('aria-label', t('compare.paneLabel', [title(), part()]))
  }
  function title() {
    return book?.title ?? ''
  }
  function part() {
    if (source.kind === 'file') return fileBook && book && fileBook.id !== book.id ? fileBook.title : t('compare.originalFile')
    const key = source
    return edition?.chapters.find(({ id }) => id === key.chapterId)?.title ?? ''
  }

  function capture() {
    if (restoring || closed) return
    if (source.kind === 'chapter') {
      if (!editor || editor.isDestroyed || !edition) return
      saveChapterPlace(edition, source.chapterId, measurePlace(editor, scroller), false)
      return
    }
    if (!text) return
    const top = scroller.getBoundingClientRect().top
    const sections = [...text.querySelectorAll<HTMLElement>('.reference-section')]
    const current = sections.find((node) => node.getBoundingClientRect().bottom > top + 1) ?? sections.at(-1)
    if (!current) return
    const box = current.getBoundingClientRect()
    saveFilePlace(source, { section: Number(current.dataset.section), fraction: box.height ? Math.max(0, (top - box.top) / box.height) : 0 })
  }
  /** Puts the pane back at its recorded place, after it moved (moving resets a pane's scroll). */
  function restore() {
    restoring = true
    if (source.kind === 'chapter') {
      if (editor && edition) applyPlace(editor, scroller, readChapterPlace(edition, source.chapterId), false)
    } else if (text) {
      const place = readFilePlace(source)
      const section = place && text.querySelector<HTMLElement>(`[data-section="${place.section}"]`)
      if (place && section) scroller.scrollTop = section.offsetTop + place.fraction * section.offsetHeight
    }
    requestAnimationFrame(() => { restoring = false })
  }
  scroller.addEventListener('scroll', () => {
    window.clearTimeout(placeTimer)
    placeTimer = window.setTimeout(capture, 250)
  }, { passive: true, signal })

  function clear() {
    window.clearTimeout(placeTimer)
    editor?.destroy()
    editor = undefined
    text = undefined
    problem = ''
    paper.replaceChildren()
  }

  function mountChapter(next: ChapterRecord) {
    editor?.destroy()
    paper.replaceChildren()
    record = next
    editor = new Editor({
      element: paper, extensions: [...documentExtensions, SearchHighlight], content: next.content, editable: false,
      editorProps: { attributes: { class: 'novel-body reference-body', role: 'document', 'aria-readonly': 'true', 'aria-label': t('compare.text') } },
    })
    restoring = true
    applyPlace(editor, scroller, edition ? readChapterPlace(edition, next.id) : undefined, false)
    requestAnimationFrame(() => { restoring = false })
  }

  async function loadChapter(turn: number) {
    if (source.kind !== 'chapter') return
    const key = source
    const [stored, editions] = await Promise.all([readBook(key.library, key.bookId), listEditions(key.library, key.bookId)])
    if (turn !== request || signal.aborted) return
    if (!stored) throw new Error(t('continuation.thisWorkWasNotFoundInThisLibrary'))
    book = stored.book
    edition = editions.find(({ id }) => id === key.editionId)
    if (!edition) throw new Error(t('reader.thisEditableVersionHasBeenRemovedFromThe'))
    if (!edition.chapters.some(({ id }) => id === key.chapterId)) throw new Error(t('store.thisChapterHasBeenRemoved'))
    const next = await readChapter(edition, key.chapterId)
    if (turn !== request || signal.aborted) return
    mountChapter(next)
  }

  async function loadFile(turn: number) {
    if (source.kind !== 'file') return
    const key = source
    const stored = await readBook(key.library, key.bookId)
    if (turn !== request || signal.aborted) return
    if (!stored || !stored.blob) throw new Error(t('reader.thisSourceFileHasBeenRemoved'))
    fileBook = stored.book as ImportedBook
    book = fileBook
    if (fileBook.workId) book = (await readBook(fileBook.library, fileBook.workId).catch(() => null))?.book ?? fileBook
    options.onChange?.()
    const sections = await fileSections(fileBook, stored.blob, signal)
    if (turn !== request || signal.aborted) return
    const body = element('div', 'reference-file')
    body.setAttribute('role', 'document')
    body.setAttribute('aria-label', t('compare.text'))
    text = body
    paper.replaceChildren(body)
    const place = readFilePlace(key)
    loadedSections = 0
    // Sections arrive one after another; the remembered place is restored once its section is in.
    for (let index = 0; index < sections.count; index++) {
      const value = await sections.read(index)
      if (turn !== request || signal.aborted) return
      const article = element('article', 'reading-text reference-section', value)
      article.dataset.section = String(index)
      body.append(article)
      loadedSections = index + 1
      if (place && index === Math.min(place.section, sections.count - 1)) {
        restoring = true
        scroller.scrollTop = article.offsetTop + place.fraction * article.offsetHeight
        requestAnimationFrame(() => { restoring = false })
      }
      if (index % 4 === 3) await new Promise(requestAnimationFrame)
    }
  }

  async function load() {
    const turn = ++request
    clear()
    record = undefined
    if (source.kind === 'chapter') fileBook = undefined
    paper.append(notice(t('compare.loading')))
    try {
      await (source.kind === 'chapter' ? loadChapter(turn) : loadFile(turn))
    } catch (cause) {
      if (turn !== request || signal.aborted) return
      problem = cause instanceof Error && cause.message ? cause.message : storageError(cause)
      paper.replaceChildren(notice(problem, true))
    }
    if (turn !== request || signal.aborted) return
    label()
    options.onChange?.()
  }

  // A chapter saved elsewhere (the editable pane beside it) shows its new text here, at the same place.
  chapterSaves.addEventListener('save', (event) => {
    const detail = (event as CustomEvent<{ library: string; bookId: string }>).detail
    if (source.kind !== 'chapter' || !edition || detail.library !== source.library || detail.bookId !== source.bookId) return
    const key = source
    const current = edition
    void readChapter(current, key.chapterId).then((next) => {
      if (signal.aborted || source !== key || !editor || next.revision === record?.revision) return
      const place = measurePlace(editor, scroller)
      record = next
      editor.commands.setContent(next.content, { emitUpdate: false })
      restoring = true
      applyPlace(editor, scroller, { ...place, height: undefined, at: 0 }, false)
      requestAnimationFrame(() => { restoring = false })
    }, () => {})
  }, { signal })

  signal.addEventListener('abort', () => { capture(); clear() }, { once: true })
  const ready = load()

  return {
    element: root,
    scroller,
    ready,
    source: () => source,
    editor: () => editor,
    edition: () => edition,
    book: () => book,
    /** The block that holds the readable text, for selection tools. */
    textRoot: () => editor?.view.dom ?? text,
    title,
    part,
    problem: () => problem,
    loadedSections: () => loadedSections,
    chapters: (): ChapterInfo[] => source.kind === 'chapter' ? edition?.chapters ?? [] : [],
    /** Shows another source in the same pane, from where that one was left. */
    async show(next: ReferenceSource) {
      capture()
      source = next
      await load()
      return !problem
    },
    async switchChapter(id: string, wanted: () => boolean = () => true) {
      if (source.kind !== 'chapter') return false
      if (id === source.chapterId) return wanted()
      capture()
      source = { ...source, chapterId: id }
      await load()
      return !problem && wanted()
    },
    capture,
    restore,
    /** Stops recording the place, for a pane that is closing (its place was just taken). */
    release() { capture(); closed = true },
    destroy() { capture(); closed = true; lifetime.abort(); root.remove() },
  }
}

export type ReferencePane = ReturnType<typeof referencePane>
