import { rememberWork } from './ideas'
import { createLinkedTask, workTaskControls, workTaskPath } from './tasks/links'
import { t } from './i18n'
import { showWorkInformation, workInformationPanel } from './work-information-view'
import type { ShellMenuItem } from './shell/popover'
import { showNotice } from './undo'
import { annotateTextPreviews } from './annotations/preview'
import { canConvert, formats, textEncodings } from './formats'
import type { TextEncoding } from './formats'
import { maxCoverSize, readBook, storageError } from './library'
import type { ImportedBook, LibraryId } from './library'
import { imageInfo } from './documents/markup'
import { emptyChapter, chapterText } from './documents/model'
import { createEdition, listEditions } from './documents/store'
import type { RegisterLeave } from './documents/editor-view'
import { htmlText, openText, requireText } from './text-preview'
import { appearanceMenu } from './appearance-view'
import { bookPath, breadcrumbs, button, downloadFile, element, fileDetails, libraries, link, nextPaint, notice, originalPath, progressNotice } from './ui'

function readingText(text: string, source = false) {
  return element('article', source ? 'reading-text markdown-source' : 'reading-text', text)
}

function rasterMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.subarray(0, 6))
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.subarray(0, 4))
    const webp = String.fromCharCode(...bytes.subarray(8, 12))
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp'
    const box = String.fromCharCode(...bytes.subarray(4, 12))
    if (box === 'ftypavif' || box === 'ftypavis') return 'image/avif'
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  return undefined
}

async function epubImageSection(
  epub: { readAsset: (base: string, href: string, limit: number) => Promise<Blob | null> },
  path: string,
  source: string,
  signal: AbortSignal,
) {
  const figure = element('figure', 'reading-image')
  const urls: string[] = []
  const template = document.createElement('template')
  template.innerHTML = source
  try {
    for (const node of template.content.querySelectorAll('img[src], image[href], image')) {
      if (node.closest('[hidden], script, noscript, template')) continue
      const isImg = node.localName.toLowerCase() === 'img'
      const href = (isImg ? node.getAttribute('src') : node.getAttribute('href') ?? node.getAttribute('xlink:href'))?.trim() ?? ''
      if (!href) continue
      const alt = (isImg ? node.getAttribute('alt') : node.getAttribute('aria-label'))?.trim() ?? ''
      let src: string | undefined
      if (href.startsWith('data:')) {
        if (imageInfo(href)) src = href
      } else {
        const asset = await epub.readAsset(path, href, maxCoverSize).catch(() => null)
        signal.throwIfAborted()
        if (asset) {
          const mime = rasterMime(new Uint8Array(await asset.slice(0, 12).arrayBuffer()))
          signal.throwIfAborted()
          if (mime) {
            src = URL.createObjectURL(new Blob([asset], { type: mime }))
            urls.push(src)
          }
        }
      }
      if (!src) continue
      const img = element('img')
      img.src = src
      img.alt = alt
      figure.append(img)
    }
    return { element: figure, urls }
  } catch (error) {
    for (const url of urls) URL.revokeObjectURL(url)
    throw error
  }
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
  const tools = element('div', 'preview-tools')
  tools.append(field, appearanceMenu())
  toolbar.append(heading, tools)
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
  read: (index: number) => Promise<HTMLElement>, signal: AbortSignal, textTools = false,
) {
  const toolbar = element('div', 'preview-toolbar')
  const paging = element('div', 'pagination')
  const previous = button(t('reader.previous', [unit]), 'button button-quiet button-small')
  const next = button(t('reader.next', [unit]), 'button button-quiet button-small')
  const number = element('span', 'page-number')
  number.setAttribute('role', 'status')
  paging.append(previous, number, next)
  if (textTools) {
    const tools = element('div', 'preview-tools')
    tools.append(paging, appearanceMenu())
    toolbar.append(element('h2', '', title), tools)
  } else {
    toolbar.append(element('h2', '', title), paging)
  }
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
      page.dataset.readingSection = `section:${index}`
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
        heading.append(element('h2', '', t('reader.rtfText')), appearanceMenu())
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
        let activeUrls: string[] = []
        const revokeActiveUrls = () => {
          for (const url of activeUrls) URL.revokeObjectURL(url)
          activeUrls = []
        }
        signal.addEventListener('abort', revokeActiveUrls, { once: true })
        showPaged(host, t('reader.epubText'), t('reader.section'), epub.length, async (index) => {
          revokeActiveUrls()
          const { path, source } = await epub.readSource(index)
          const text = htmlText(source)
          if (text.trim()) return readingText(text)
          const { element: figure, urls } = await epubImageSection(epub, path, source, signal)
          if (signal.aborted) {
            for (const url of urls) URL.revokeObjectURL(url)
            return figure
          }
          activeUrls = urls
          if (figure.childElementCount) return figure
          requireText(text)
          return readingText(text)
        }, signal, true)
      }
    } else {
      const text = await (book.format === 'docx' ? openDocx : openOdt)(blob, signal)
      if (!signal.aborted) {
        const heading = element('div', 'preview-toolbar')
        heading.append(element('h2', '', t('reader.text', [format.label])), appearanceMenu())
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
    rememberWork({ library, bookId: workId })
    if (reference && !editionId && !blob) {
      content.replaceChildren(link(bookPath(library, workId), t('reader.backToContinuationProject')), notice(t('reader.thisSourceFileHasBeenRemoved'), true))
      return
    }
    const selected = editionId ? editions.find((edition) => edition.id === editionId) : blob ? undefined : editions[0]
    const linkedOriginal = selected?.originalId && selected.originalId !== id
      ? await readBook(library, selected.originalId).catch(() => null) : stored
    if (signal.aborted) return
    if (selected) {
      // An editable version takes the whole page: the work's title, versions, information and
      // tasks move into the menu under the work's name in the editor's toolbar.
      const body = element('div', 'work-body editor-host')
      body.append(notice(t('reader.openingEditableVersion')))
      panel.classList.add('editor-page')
      panel.replaceChildren(body)
      const workMenu = (): ShellMenuItem[] => {
        const items: ShellMenuItem[] = []
        const versions: ShellMenuItem[] = []
        if (!reference && blob) versions.push({ label: t('reader.originalFile'), icon: 'file', action: () => { location.hash = bookPath(library, id) } })
        for (const edition of reference ? [] : editions) {
          versions.push({ label: edition.name, checked: edition.id === selected.id, radio: true, action: () => { location.hash = bookPath(library, id, edition.id) } })
        }
        if (versions.length > 1) items.push({ label: t('editor.switchVersion'), icon: 'copy', children: () => versions })
        if (reference) {
          items.push({ label: t('reader.backToContinuationProject'), icon: 'back', action: () => { location.hash = bookPath(library, workId) } })
          if (linkedOriginal?.blob) items.push({ label: t('reader.viewSource'), icon: 'file', action: () => { location.hash = originalPath(linkedOriginal.book.id) } })
        }
        if (!book.workId) {
          items.push({ label: t('work.edit'), icon: 'edit', action: () => {
            void readBook(book.library, book.id).then((stored) => { if (stored && !signal.aborted) showWorkInformation(stored.book) }, (error) => showNotice(storageError(error)))
          } })
          items.push({ label: t('tasks.addLinked'), icon: 'plus', action: () => {
            void createLinkedTask({ library: book.library, bookId: book.workId ?? book.id, title: book.title }).catch((error) => showNotice(storageError(error)))
          } })
          items.push({ label: t('tasks.workTasks'), icon: 'check', action: () => { location.hash = workTaskPath(book.library, book.workId ?? book.id) } })
        }
        if (linkedOriginal?.blob) {
          const original = linkedOriginal
          items.push({ label: t('reader.downloadOriginalFile'), icon: 'download', action: () => downloadFile(original.blob, original.book.originalName) })
        }
        items.push({ separator: true, label: '' }, { label: libraries[library].name, icon: 'back', action: () => { location.hash = bookPath(library) } })
        return items
      }
      const { renderEdition } = await import('./documents/editor-view')
      await renderEdition(body, root, book, selected, signal, registerLeave, { title: book.title, menu: workMenu })
      return
    }
    const heading = element('header', 'page-heading reader-heading')
    const title = element('div', 'reader-title')
    title.append(element('p', 'eyebrow', reference ? (editionId ? t('reader.continuationDraft') : t('reader.readSource')) : t('navigation.workDetails')), element('h1', '', book.title))
    if (!reference || !editionId) title.append(fileDetails(book))
    heading.append(title)
    if(!book.workId)heading.append(workTaskControls(book))
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
      tabs.append(link(bookPath(library, id, edition.id), edition.name, 'version-tab'))
    }
    const body = element('div', 'work-body')
    content.replaceChildren(heading, ...(!book.workId ? [workInformationPanel(book, signal, (next) => { title.querySelector('h1')!.textContent = next.title })] : []), tabs, body)
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
      const progress = progressNotice(fromFile ? t('reader.convertingAndPreservingTheOriginalFile') : t('reader.creatingManuscript'))
      message.replaceChildren(progress.element)
      try {
        await nextPaint()
        const converted = fromFile && blob
          ? await (await import('./documents/import')).convertFile(book.format, blob, signal, encoding)
          : { chapters: [emptyChapter()], notes: [] }
        signal.throwIfAborted()
        if (fromFile) progress.set(t('reader.savingManuscript', [converted.chapters.length]))
        const project = book.workId ? (await readBook(library, workId))?.book : book
        if (!project) throw new Error(t('library.theContinuationProjectHasBeenRemoved'))
        const edition = await createEdition(project, converted.chapters, {
          source: fromFile ? 'original' : 'blank', notes: converted.notes, originalId: reference && fromFile ? id : undefined,
        })
        if (signal.aborted) return
        progress.set(t('reader.openingManuscript'))
        await nextPaint()
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
    annotateTextPreviews(preview, book, signal)
    await showPreview(preview, book, blob, signal, (value) => { encoding = value })
  } catch (error) {
    if (!signal.aborted) content.replaceChildren(notice(storageError(error), true))
  }
}
