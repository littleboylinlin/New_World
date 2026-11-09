import { canConvert, formats, textEncodings } from './formats'
import type { TextEncoding } from './formats'
import { readBook, storageError } from './library'
import type { ImportedBook, LibraryId } from './library'
import { emptyChapter, chapterText } from './documents/model'
import { createEdition, listEditions } from './documents/store'
import type { RegisterLeave } from './documents/editor-view'
import { openText } from './text-preview'
import { bookPath, breadcrumbs, button, downloadFile, element, fileDetails, link, notice } from './ui'

function readingText(text: string, source = false) {
  return element('article', source ? 'reading-text markdown-source' : 'reading-text', text)
}

function previewProblem(error: unknown) {
  const reason = error instanceof Error ? error.message : '无法读取文件内容。'
  return notice(`${reason} 原文件仍可下载。`, true)
}

function showText(host: HTMLElement, book: ImportedBook, blob: Blob, signal: AbortSignal, setEncoding: (encoding?: TextEncoding) => void) {
  const toolbar = element('div', 'preview-toolbar')
  const label = book.format === 'md' ? 'Markdown 源文' : book.format === 'html' ? 'HTML 正文' : '文本正文'
  const heading = element('h2', '', label)
  const field = element('label', 'encoding-field', '编码')
  const select = element('select')
  const auto = element('option', '', '自动识别')
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
    content.replaceChildren(notice('正在解码文本…'))
    try {
      const result = await openText(blob, book.format === 'html', encoding)
      if (signal.aborted || current !== requestNumber) return
      auto.textContent = select.value ? '自动识别' : `自动 · ${textEncodings[result.encoding]}`
      content.replaceChildren(readingText(result.text, book.format === 'md'))
    } catch (error) {
      if (!signal.aborted && current === requestNumber) content.replaceChildren(previewProblem(error))
    }
  }
  select.addEventListener('change', () => void refresh())
  void refresh()
}

function showPaged(
  host: HTMLElement, title: string, unit: '页' | '节', count: number,
  read: (index: number) => Promise<HTMLElement>, signal: AbortSignal,
) {
  const toolbar = element('div', 'preview-toolbar')
  const paging = element('div', 'pagination')
  const previous = button(`上一${unit}`, 'button button-quiet button-small')
  const next = button(`下一${unit}`, 'button button-quiet button-small')
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
    content.replaceChildren(notice('正在加载预览…'))
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
    host.replaceChildren(notice(`${format.label} 当前仅保存原文件。可下载后用兼容的软件阅读。`))
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
        heading.append(element('h2', '', 'RTF 正文'))
        host.replaceChildren(heading, readingText(text))
      }
      return
    }
    if (format.preview === 'pdf') {
      const { openPdf } = await import('./pdf-preview')
      const pdf = await openPdf(blob, signal)
      if (!signal.aborted) showPaged(host, 'PDF 阅读', '页', pdf.length, pdf.renderPage, signal)
      return
    }
    const { openEpub, openDocx, openOdt } = await import('./archive-preview')
    if (book.format === 'epub') {
      const epub = await openEpub(blob, signal)
      if (!signal.aborted) {
        showPaged(host, 'EPUB 正文', '节', epub.length, async (index) => readingText(await epub.readSection(index)), signal)
      }
    } else {
      const text = await (book.format === 'docx' ? openDocx : openOdt)(blob, signal)
      if (!signal.aborted) {
        const heading = element('div', 'preview-toolbar')
        heading.append(element('h2', '', `${format.label} 正文`))
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
  content.append(notice('正在读取作品…'))
  panel.append(breadcrumbs(library, true), content)
  root.append(panel)

  try {
    const [stored, editions] = await Promise.all([readBook(library, id), listEditions(library, id)])
    if (signal.aborted) return
    if (!stored) {
      content.replaceChildren(notice('这个书库中没有找到该作品。', true))
      return
    }

    const { book, blob } = stored
    const heading = element('header', 'page-heading reader-heading')
    const title = element('div', 'reader-title')
    title.append(element('p', 'eyebrow', '作品详情'), element('h1', '', book.title), fileDetails(book))
    heading.append(title)
    if (blob) {
      const download = button('下载原文件', 'button button-primary', 'download')
      download.addEventListener('click', () => downloadFile(blob, book.originalName))
      heading.append(download)
    }

    const selected = editionId ? editions.find((edition) => edition.id === editionId) : blob ? undefined : editions[0]
    const tabs = element('nav', 'version-navigation')
    tabs.setAttribute('aria-label', '原文件与编辑版本')
    if (blob) {
      const original = link(bookPath(library, id), '原文件', 'version-tab')
      if (!editionId) original.setAttribute('aria-current', 'page')
      tabs.append(original)
    }
    for (const edition of editions) {
      const anchor = link(bookPath(library, id, edition.id), edition.name, 'version-tab')
      if (selected?.id === edition.id) anchor.setAttribute('aria-current', 'page')
      tabs.append(anchor)
    }
    const body = element('div', 'work-body')
    content.replaceChildren(heading, tabs, body)
    if (selected) {
      body.append(notice('正在打开编辑版本…'))
      const { renderEdition } = await import('./documents/editor-view')
      await renderEdition(body, root, book, selected, signal, registerLeave)
      return
    }
    if (editionId) {
      body.append(notice('此编辑版本已从书库移除。', true))
      return
    }

    const actions = element('div', 'version-actions')
    const empty = button('新建空白编辑稿', 'button button-quiet button-small', 'plus')
    const message = element('div', 'version-message')
    actions.append(empty)
    let converting = false
    let encoding: TextEncoding | undefined
    async function create(fromFile: boolean) {
      if (converting) return
      converting = true
      for (const control of actions.querySelectorAll('button')) control.disabled = true
      message.replaceChildren(notice(fromFile ? '正在转换并保留原文件…' : '正在创建编辑稿…'))
      try {
        const converted = fromFile && blob
          ? await (await import('./documents/import')).convertFile(book.format, blob, signal, encoding)
          : { chapters: [emptyChapter()], notes: [] }
        signal.throwIfAborted()
        const edition = await createEdition(book, converted.chapters, { source: fromFile ? 'original' : 'blank', notes: converted.notes })
        if (!signal.aborted) location.hash = bookPath(library, id, edition.id)
      } catch (error) {
        if (!signal.aborted) message.replaceChildren(previewProblem(error))
      } finally {
        converting = false
        for (const control of actions.querySelectorAll('button')) control.disabled = false
      }
    }
    empty.addEventListener('click', () => { void create(false) })
    if (blob && canConvert(book.format)) {
      const convert = button(book.format === 'pdf' ? '提取文字为编辑稿' : '转换为编辑稿', 'button button-primary button-small')
      convert.addEventListener('click', () => { void create(true) })
      actions.prepend(convert)
      actions.append(element('span', 'version-hint', book.format === 'pdf' ? '按页提取文字，原版式保存在 PDF 中。' : '编辑内容保存在独立版本中。'))
    }
    body.append(actions, message)
    if (!blob) return
    const preview = element('section', 'reader-panel')
    preview.setAttribute('aria-label', '文件预览')
    preview.append(notice('正在准备文件预览…'))
    body.append(preview)
    await showPreview(preview, book, blob, signal, (value) => { encoding = value })
  } catch (error) {
    if (!signal.aborted) content.replaceChildren(notice(storageError(error), true))
  }
}
