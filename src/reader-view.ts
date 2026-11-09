import { formats, textEncodings } from './formats'
import type { TextEncoding } from './formats'
import { readBook, storageError } from './library'
import type { Book, LibraryId } from './library'
import { openText } from './text-preview'
import { breadcrumbs, button, element, fileDetails, notice } from './ui'

function readingText(text: string, source = false) {
  return element('article', source ? 'reading-text markdown-source' : 'reading-text', text)
}

function previewProblem(error: unknown) {
  const reason = error instanceof Error ? error.message : '无法读取文件内容。'
  return notice(`${reason} 原文件仍可下载。`, true)
}

function downloadOriginal(blob: Blob, filename: string) {
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }))
  const anchor = element('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function showText(host: HTMLElement, book: Book, blob: Blob, signal: AbortSignal) {
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
    content.replaceChildren(notice('正在解码文本…'))
    try {
      const result = await openText(blob, book.format === 'html', (select.value || undefined) as TextEncoding | undefined)
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

async function showPreview(host: HTMLElement, book: Book, blob: Blob, signal: AbortSignal) {
  const format = formats[book.format]
  if (format.preview === null) {
    host.replaceChildren(notice(`${format.label} 当前仅保存原文件。可下载后用兼容的软件阅读。`))
    return
  }
  if (format.preview === 'text') {
    showText(host, book, blob, signal)
    return
  }

  try {
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

export async function renderReader(root: HTMLElement, library: LibraryId, id: string, signal: AbortSignal) {
  const panel = element('section', `reader-page mode-${library}`)
  const content = element('div')
  content.append(notice('正在读取作品…'))
  panel.append(breadcrumbs(library, true), content)
  root.append(panel)

  try {
    const stored = await readBook(library, id)
    if (signal.aborted) return
    if (!stored) {
      content.replaceChildren(notice('这个书库中没有找到该作品。', true))
      return
    }

    const { book, blob } = stored
    const heading = element('header', 'page-heading reader-heading')
    const title = element('div', 'reader-title')
    title.append(element('p', 'eyebrow', '作品详情'), element('h1', '', book.title), fileDetails(book))
    const download = button('下载原文件', 'button button-primary', 'download')
    download.addEventListener('click', () => downloadOriginal(blob, book.originalName))
    heading.append(title, download)
    const preview = element('section', 'reader-panel')
    preview.setAttribute('aria-label', '文件预览')
    preview.append(notice('正在准备文件预览…'))
    content.replaceChildren(heading, preview)
    await showPreview(preview, book, blob, signal)
  } catch (error) {
    if (!signal.aborted) content.replaceChildren(notice(storageError(error), true))
  }
}
