import { t } from '../i18n'
import type { JSONContent } from '@tiptap/core'
import { decodeText } from '../formats'
import type { Format, TextEncoding } from '../formats'
import { maxTextPreviewSize } from '../text-preview'
import { cleanMarkup, imageBudget, inertMarkup, rasterData } from './markup'
import { maxChapters, maxEditionImageBytes, maxImageBytes } from './model'
import type { ChapterInput, DocumentContent } from './model'
import { checkDocument, fromMarkup } from './schema'

interface Conversion {
  chapters: ChapterInput[]
  notes: string[]
}

const chapterCharacters = 160_000
const chapterBlocks = 1200
const chapterLine = /^(?:第[零〇一二两三四五六七八九十百千万0-9０-９]+[章回卷节篇]|chapter\s+\d+\b).{0,70}$/i

function paragraph(text: string): JSONContent {
  return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }
}

function nodeText(node: JSONContent): string {
  return node.text ?? node.content?.map(nodeText).join('') ?? ''
}

function meaningful(node: JSONContent): boolean {
  return node.type === 'image' || Boolean(node.text?.trim()) || Boolean(node.content?.some(meaningful))
}

function titleOf(text: string, fallback: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120) || fallback
}

function chunked(blocks: JSONContent[], name: string): ChapterInput[] {
  const chapters: ChapterInput[] = []
  let current: JSONContent[] = []
  let characters = 0
  function flush() {
    if (!current.length) return
    const title = chapters.length ? t('import.continued', [name, chapters.length]) : name
    chapters.push({ title, content: { type: 'doc', content: current } })
    current = []
    characters = 0
  }
  for (const block of blocks) {
    const length = nodeText(block).length
    const justHeading = current.length === 1 && current[0].type === 'heading'
    if (current.length >= chapterBlocks || (current.length && !justHeading && characters + length > chapterCharacters)) flush()
    current.push(block)
    characters += length
  }
  flush()
  return chapters
}

function textChapters(text: string, name = t('import.text'), detectChapters = true): ChapterInput[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n', 250_001)
  if (lines.length > 250_000) throw new Error(t('import.theTextHasTooManyLinesToConvert'))
  const result: ChapterInput[] = []
  let title = name
  let blocks: JSONContent[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (detectChapters && chapterLine.test(trimmed)) {
      if (blocks.some(meaningful)) result.push(...chunked(blocks, title))
      title = titleOf(trimmed, name)
      blocks = [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: line }] }]
      continue
    }
    let start = 0
    while (line.length - start > chapterCharacters) {
      let end = start + chapterCharacters
      const last = line.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end--
      blocks.push(paragraph(line.slice(start, end)))
      start = end
    }
    blocks.push(paragraph(line.slice(start)))
  }
  result.push(...chunked(blocks, title))
  return result
}

function structuredChapters(content: DocumentContent, name = t('import.text'), detectChapters = true) {
  const blocks = content.content ?? []
  const result: ChapterInput[] = []
  const level = blocks.some((block) => block.type === 'heading' && block.attrs?.level === 1) ? 1 : 2
  let chapter: JSONContent[] = []
  let title = name
  for (const block of blocks) {
    if (detectChapters && block.type === 'heading' && block.attrs?.level === level) {
      if (chapter.some(meaningful)) result.push(...chunked(chapter, title))
      chapter = []
      title = titleOf(nodeText(block), name)
    }
    chapter.push(block)
  }
  result.push(...chunked(chapter, title))
  return result
}

function htmlChapters(markup: string, notes: string[]) {
  const budget = imageBudget()
  const doc = fromMarkup(cleanMarkup(inertMarkup(markup), budget))
  if (budget.omitted) notes.push(t('import.remoteExternalOrOversizedImageSWereNot', [budget.omitted]))
  return structuredChapters(doc)
}

async function convertText(format: 'txt' | 'md' | 'html', blob: Blob, encoding?: TextEncoding): Promise<Conversion> {
  if (blob.size > maxTextPreviewSize) throw new Error(t('import.theTextExceedsThe16MibConversionLimit'))
  const { text } = decodeText(new Uint8Array(await blob.arrayBuffer()), encoding)
  if (format === 'txt') return { chapters: textChapters(text), notes: [] }
  const notes = format === 'html' ? [t('import.preservesSupportedDocumentStructureCommonTextStylesAnd')] : []
  if (format === 'html') return { chapters: htmlChapters(text, notes), notes }
  const { default: MarkdownIt } = await import('markdown-it')
  const markup = new MarkdownIt({ html: true }).render(text)
  return { chapters: htmlChapters(markup, notes), notes }
}

async function convertEpub(blob: Blob, signal: AbortSignal): Promise<Conversion> {
  const { openEpub } = await import('../archive-preview')
  const book = await openEpub(blob, signal)
  if (book.length > maxChapters) throw new Error(t('import.thisEpubExceedsTheConversionLimitOfSections', [maxChapters]))
  const chapters: ChapterInput[] = []
  const notes = [t('import.convertsTextCommonStylesAndEmbeddedImagesIn')]
  const budget = imageBudget()
  const cached = new Map<string, string | undefined>()
  let loaded = 0
  let characters = 0
  for (let index = 0; index < book.length; index++) {
    const { path, source } = await book.readSource(index)
    characters += source.length
    if (characters > 24 * 1024 * 1024) throw new Error(t('import.theEpubTextExceedsTheTotalConversionSize'))
    const template = inertMarkup(source)
    const firstHeading = (template.content.querySelector('h1,h2,h3,h4,h5,h6') ?? template.content.querySelector('title'))?.textContent ?? ''
    for (const img of template.content.querySelectorAll('img[src]')) {
      const href = img.getAttribute('src') ?? ''
      if (!href || href.startsWith('data:')) continue
      const key = `${path}\0${href}`
      if (!cached.has(key) && loaded < maxEditionImageBytes * 4 / 3) {
        const asset = await book.readAsset(path, href, maxImageBytes).catch(() => null)
        signal.throwIfAborted()
        const data = asset ? await rasterData(asset) : undefined
        loaded += data?.length ?? 0
        cached.set(key, data)
      }
      img.setAttribute('src', cached.get(key) ?? '')
    }
    const doc = fromMarkup(cleanMarkup(template, budget))
    const chapterTitle = titleOf(firstHeading, t('import.section', [index + 1]))
    chapters.push(...structuredChapters(doc, chapterTitle, false))
  }
  if (budget.omitted) notes.push(t('import.externalProtectedOrOversizedImageSWereNot', [budget.omitted]))
  return { chapters, notes }
}

async function convertPdf(blob: Blob, signal: AbortSignal): Promise<Conversion> {
  const { openPdf } = await import('../pdf-preview')
  const controller = new AbortController()
  try {
    const pdf = await openPdf(blob, AbortSignal.any([controller.signal, signal]))
    if (pdf.length > maxChapters) throw new Error(t('import.thisPdfExceedsTheConversionLimitOfPages', [maxChapters]))
    const chapters: ChapterInput[] = []
    let skipped = 0
    let length = 0
    for (let index = 0; index < pdf.length; index++) {
      const text = await pdf.readText(index)
      length += text.length
      if (length > maxTextPreviewSize) throw new Error(t('import.theExtractedPdfTextExceedsTheConversionLimit'))
      if (text.trim()) chapters.push(...textChapters(text, t('import.page', [index + 1]), false))
      else skipped++
    }
    if (!chapters.length) throw new Error(t('import.thisPdfHasNoExtractableTextScannedDocuments'))
    const notes = [t('import.textIsExtractedPageByPageThePdf')]
    if (skipped) notes.push(t('import.pageSHaveNoExtractableTextAndCan', [skipped]))
    return { chapters, notes }
  } finally {
    controller.abort()
  }
}

export async function convertFile(format: Format, blob: Blob, signal: AbortSignal, encoding?: TextEncoding) {
  let converted: Conversion
  switch (format) {
    case 'txt': case 'md': case 'html':
      converted = await convertText(format, blob, encoding)
      break
    case 'rtf': {
      const { readRtf } = await import('./rtf')
      converted = { chapters: structuredChapters(await readRtf(blob)), notes: [t('import.convertsTextAndBasicInlineStylesReferTo')] }
      break
    }
    case 'docx': case 'odt': {
      const { docxMarkup, odtMarkup } = await import('./office-import')
      const { markup, notes } = await (format === 'docx' ? docxMarkup : odtMarkup)(blob, signal)
      converted = { chapters: htmlChapters(markup, notes), notes }
      break
    }
    case 'epub': converted = await convertEpub(blob, signal); break
    case 'pdf': converted = await convertPdf(blob, signal); break
    default: throw new Error(t('import.thisFormatCanOnlyBeStoredAsAn'))
  }
  signal.throwIfAborted()
  if (!converted.chapters.some((chapter) => meaningful(chapter.content))) throw new Error(t('import.noConvertibleTextOrImagesWereFound'))
  if (converted.chapters.length > maxChapters) throw new Error(t('import.theConvertedDocumentExceedsChapters', [maxChapters]))
  for (const chapter of converted.chapters) checkDocument(chapter.content)
  return converted
}
