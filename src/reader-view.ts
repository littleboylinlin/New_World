import { t } from './i18n'
import { canConvert, formats, textEncodings } from './formats'
import type { TextEncoding } from './formats'
import { readBook, storageError } from './library'
import type { ImportedBook, LibraryId } from './library'
import { emptyChapter, chapterText } from './documents/model'
import { createEdition, listEditions } from './documents/store'
import type { RegisterLeave } from './documents/editor-view'
import { openText } from './text-preview'
import { bookPath, breadcrumbs, button, downloadFile, element, fileDetails, link, notice, originalPath } from './ui'

function readingText(text: string, source = false) {
  return element('article', source ? 'reading-text markdown-source' : 'reading-text', text)
}

function previewProblem(error: unknown) {
  const reason = error instanceof Error ? error.message : t('reader.theFileContentCouldNotBeRead')
  return notice(t('reader.theOriginalFileCanStillBeDownloaded', [reason]), true)
}

function showText(host: HTMLElement, book: ImportedBook, blob: Blob, signal: AbortSignal, setEncoding: (encoding?: TextEncoding) => void) {
  const toolbar = element('div', 'preview-toolbar')
  const label = book.format === 'md' ? t('reader.markdownSource') : book.format === 'html' ? t('reader.htmlText') : t('reader.plainText')
  const heading = element('h2', '', label)
  const field = element('label', 'encoding-field', t('reader.encoding'))
  const select = element('select')
  const auto = element('option', '', t('reader.autoDetect'))
  auto.value = ''
  select.append(auto)
  for (const [encoding, title] of Object.entries(textEncodings)) {
    const option = element('option', '', title)
    option.value = encoding
    select.append(option)
  }
  field.append(select)
  toolbar.append(heading, field)
  const content = element('div', 'preview-body')
  host.replaceChildren(toolbar, content)

  let requestNumber = 0
  async function refresh() {
    const current = ++requestNumber
    const encoding = (select.value || undefined) as TextEncoding | undefined
    setEncoding(encoding)
    content.replaceChildren(notice(t('reader.decodingText')))
    try {
      const result = await openText(blob, book.format === 'html', encoding)
      if (signal.aborted || current !== requestNumber) return
      auto.textContent = select.value ? t('reader.autoDetect') : t('reader.auto', [textEncodings[result.encoding]])
      content.replaceChildren(readingText(result.text, book.format === 'md'))
    } catch (error) {
      if (!signal.aborted && current === requestNumber) content.replaceChildren(previewProblem(error))
    }
  }
  select.addEventListener('change', () => void refresh())
  void refresh()
}

function showPaged(
  host: HTMLElement, title: string, unit: string, count: number,
  read: (index: number) => Promise<HTMLElement>, signal: AbortSignal,
) {
  const toolbar = element('div', 'preview-toolbar')
  const paging = element('div', 'pagination')
  const previous = button(t('reader.previous', [unit]), 'button button-quiet button-small')
  const next = button(t('reader.next', [unit]), 'button button-quiet button-small')
  const number = element('span', 'page-number')
  number.setAttribute('role', 'status')
  paging.append(previous, number, next)
  toolbar.append(element('h2', '', title), paging)
  const content = element('div', 'preview-body')
  host.replaceChildren(toolbar, content)

  let index = 0
  async function goTo(target: number) {
    index = target
    previous.disabled = true
    next.disabled = true
    number.textContent = `${index + 1} / ${count}`
    content.replaceChildren(notice(t('reader.loadingPreview')))
    try {
      const page = await read(index)
      if (!signal.aborted) content.replaceChildren(page)
    } catch (error) {
      if (!signal.aborted) content.replaceChildren(previewProblem(error))
    } finally {
      previous.disabled = index === 0
      next.disabled = index === count - 1
    }
  }
  previous.addEventListener('click', () => void goTo(index - 1))
  next.addEventListener('click', () => void goTo(index + 1))
  void goTo(0)
}

async function showPreview(host: HTMLElement, book: ImportedBook, blob: Blob, signal: AbortSignal, setEncoding: (encoding?: TextEncoding) => void) {
  const format = formats[book.format]
  if (format.preview === null) {
    host.replaceChildren(notice(t('reader.onlyTheOriginalFileIsStoredDownloadIt', [format.label])))
    return
  }
  if (format.preview === 'text') {
    showText(host, book, blob, signal, setEncoding)
    return
  }

  try {
    if (format.preview === 'rtf') {
      const { readRtf } = await import('./documents/rtf')
      const text = chapterText(await readRtf(blob))
      if (!signal.aborted) {
        const heading = element('div', 'preview-toolbar')
        heading.append(element('h2', '', t('reader.rtfText')))
        host.replaceChildren(heading, readingText(text))
      }
      return
    }
    if (format.preview === 'pdf') {
      const { openPdf } = await import('./pdf-preview')
      const pdf = await openPdf(blob, signal)
      if (!signal.aborted) showPaged(host, t('reader.pdfReader'), t('reader.page'), pdf.length, pdf.renderPage, signal)
      return
    }
    const { openEpub, openDocx, openOdt } = await import('./archive-preview')
    if (book.format === 'epub') {
      const epub = await openEpub(blob, signal)
      if (!signal.aborted) {
        showPaged(host, t('reader.epubText'), t('reader.section'), epub.length, async (index) => readingText(await epub.readSection(index)), signal)
      }
    } else {
      const text = await (book.format === 'docx' ? openDocx : openOdt)(blob, signal)
      if (!signal.aborted) {
        const heading = element('div', 'preview-toolbar')
        heading.append(element('h2', '', t('reader.text', [format.label])))
        host.replaceChildren(heading, readingText(text))
      }
    }
  } catch (error) {
    if (!signal.aborted) host.replaceChildren(previewProblem(error))
  }
}

export async function renderReader(
  root: HTMLElement, library: LibraryId, id: string, editionId: string | undefined, signal: AbortSignal, registerLeave: RegisterLeave,
) {
  const panel = element('section', `reader-page mode-${library}`)
  const content = element('div')
  content.append(notice(t('reader.loadingWork')))
  panel.append(breadcrumbs(library, true), content)
  root.append(panel)

  try {
    const [stored, editions] = await Promise.all([readBook(library, id), listEditions(library, id)])
    if (signal.aborted) return
    if (!stored) {
      content.replaceChildren(notice(t('continuation.thisWorkWasNotFoundInThisLibrary'), true))
      return
    }

    const { book, blob } = stored
    const reference = library === 'reference'
    const workId = book.workId ?? id
    if (reference && !editionId && !blob) {
      content.replaceChildren(link(bookPath(library, workId), t('reader.backToContinuationProject')), notice(t('reader.thisSourceFileHasBeenRemoved'), true))
      return
    }
    const selected = editionId ? editions.find((edition) => edition.id === editionId) : blob ? undefined : editions[0]
    const linkedOriginal = selected?.originalId && selected.originalId !== id
      ? await readBook(library, selected.originalId).catch(() => null) : stored
    if (signal.aborted) return
    const heading = element('header', 'page-heading reader-heading')
    const title = element('div', 'reader-title')
    title.append(element('p', 'eyebrow', reference ? (editionId ? t('reader.continuationDraft') : t('reader.readSource')) : t('navigation.workDetails')), element('h1', '', book.title))
    if (!reference || !editionId) title.append(fileDetails(book))
    heading.append(title)
    if (linkedOriginal?.blob) {
      const original = linkedOriginal
      const download = button(t('reader.downloadOriginalFile'), 'button button-primary', 'download')
      download.addEventListener('click', () => downloadFile(original.blob, original.book.originalName))
      heading.append(download)
    }

    const tabs = element('nav', 'version-navigation')
    tabs.setAttribute('aria-label', reference ? t('reader.continuationProjectNavigation') : t('reader.originalFileAndEditableVersions'))
    if (reference) {
      tabs.append(link(bookPath(library, workId), t('reader.backToContinuationProject'), 'version-tab'))
      if (editionId && linkedOriginal?.blob) tabs.append(link(originalPath(linkedOriginal.book.id), t('reader.viewSource'), 'version-tab'))
    } else if (blob) {
      const original = link(bookPath(library, id), t('reader.originalFile'), 'version-tab')
      if (!editionId) original.setAttribute('aria-current', 'page')
      tabs.append(original)
    }
    for (const edition of reference ? [] : editions) {
      const anchor = link(bookPath(library, id, edition.id), edition.name, 'version-tab')
      if (selected?.id === edition.id) anchor.setAttribute('aria-current', 'page')
      tabs.append(anchor)
    }
    const body = element('div', 'work-body')
    content.replaceChildren(heading, tabs, body)
    if (selected) {
      body.append(notice(t('reader.openingEditableVersion')))
      const { renderEdition } = await import('./documents/editor-view')
      await renderEdition(body, root, book, selected, signal, registerLeave)
      return
    }
    if (editionId) {
      body.append(notice(t('reader.thisEditableVersionHasBeenRemovedFromThe'), true))
      return
    }

    const actions = element('div', 'version-actions')
    const empty = button(t('reader.createEmptyManuscript'), 'button button-quiet button-small', 'plus')
    const message = element('div', 'version-message')
    if (!reference) actions.append(empty)
    let converting = false
    let encoding: TextEncoding | undefined
    async function create(fromFile: boolean) {
      if (converting) return
      converting = true
      for (const control of actions.querySelectorAll('button')) control.disabled = true
      message.replaceChildren(notice(fromFile ? t('reader.convertingAndPreservingTheOriginalFile') : t('reader.creatingManuscript')))
      try {
        const converted = fromFile && blob
          ? await (await import('./documents/import')).convertFile(book.format, blob, signal, encoding)
          : { chapters: [emptyChapter()], notes: [] }
        signal.throwIfAborted()
        const project = book.workId ? (await readBook(library, workId))?.book : book
        if (!project) throw new Error(t('library.theContinuationProjectHasBeenRemoved'))
        const edition = await createEdition(project, converted.chapters, {
          source: fromFile ? 'original' : 'blank', notes: converted.notes, originalId: reference && fromFile ? id : undefined,
        })
        if (!signal.aborted) location.hash = bookPath(library, workId, edition.id)
      } catch (error) {
        if (!signal.aborted) message.replaceChildren(previewProblem(error))
      } finally {
        converting = false
        for (const control of actions.querySelectorAll('button')) control.disabled = false
      }
    }
    empty.addEventListener('click', () => { void create(false) })
    if (blob && canConvert(book.format)) {
      const convert = button(reference ? t('reader.continueFromSourceText') : book.format === 'pdf' ? t('reader.extractTextAsManuscript') : t('reader.convertToManuscript'), 'button button-primary button-small')
      convert.addEventListener('click', () => { void create(true) })
      actions.prepend(convert)
    }
    body.append(actions, message)
    if (!blob) return
    const preview = element('section', 'reader-panel')
    preview.setAttribute('aria-label', t('reader.filePreview'))
    preview.append(notice(t('reader.preparingFilePreview')))
    body.append(preview)
    await showPreview(preview, book, blob, signal, (value) => { encoding = value })
  } catch (error) {
    if (!signal.aborted) content.replaceChildren(notice(storageError(error), true))
  }
}
