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
    const title = chapters.length ? `${name}（续 ${chapters.length}）` : name
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

function textChapters(text: string, name = '正文', detectChapters = true): ChapterInput[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n', 250_001)
  if (lines.length > 250_000) throw new Error('文本的行数超过可转换上限。')
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

function structuredChapters(content: DocumentContent, name = '正文', detectChapters = true) {
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
  if (budget.omitted) notes.push(`有 ${budget.omitted} 张远程、外部或超限图片未导入。`)
  return structuredChapters(doc)
}

async function convertText(format: 'txt' | 'md' | 'html', blob: Blob, encoding?: TextEncoding): Promise<Conversion> {
  if (blob.size > maxTextPreviewSize) throw new Error('正文超过 16 MiB 的转换上限。')
  const { text } = decodeText(new Uint8Array(await blob.arrayBuffer()), encoding)
  if (format === 'txt') return { chapters: textChapters(text), notes: [] }
  const notes = format === 'html' ? ['保留可用的正文结构、常见文字样式和内嵌图片。网页样式、脚本和远程内容不进入编辑稿。'] : []
  if (format === 'html') return { chapters: htmlChapters(text, notes), notes }
  const { default: MarkdownIt } = await import('markdown-it')
  const markup = new MarkdownIt({ html: true }).render(text)
  return { chapters: htmlChapters(markup, notes), notes }
}

async function convertEpub(blob: Blob, signal: AbortSignal): Promise<Conversion> {
  const { openEpub } = await import('../archive-preview')
  const book = await openEpub(blob, signal)
  if (book.length > maxChapters) throw new Error(`此 EPUB 超过 ${maxChapters} 节的转换上限。`)
  const chapters: ChapterInput[] = []
  const notes = ['按 EPUB 阅读顺序转换正文、常见样式和包内图片。书籍样式、外部资源和固定排版以原文件为准。']
  const budget = imageBudget()
  const cached = new Map<string, string | undefined>()
  let loaded = 0
  let characters = 0
  for (let index = 0; index < book.length; index++) {
    const { path, source } = await book.readSource(index)
    characters += source.length
    if (characters > 24 * 1024 * 1024) throw new Error('EPUB 正文部件总大小超过转换上限。')
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
    const chapterTitle = titleOf(firstHeading, `第 ${index + 1} 节`)
    chapters.push(...structuredChapters(doc, chapterTitle, false))
  }
  if (budget.omitted) notes.push(`有 ${budget.omitted} 张外部、受保护或超限图片未导入。`)
  return { chapters, notes }
}

async function convertPdf(blob: Blob, signal: AbortSignal): Promise<Conversion> {
  const { openPdf } = await import('../pdf-preview')
  const controller = new AbortController()
  try {
    const pdf = await openPdf(blob, AbortSignal.any([controller.signal, signal]))
    if (pdf.length > maxChapters) throw new Error(`此 PDF 超过 ${maxChapters} 页的转换上限。`)
    const chapters: ChapterInput[] = []
    let skipped = 0
    let length = 0
    for (let index = 0; index < pdf.length; index++) {
      const text = await pdf.readText(index)
      length += text.length
      if (length > maxTextPreviewSize) throw new Error('PDF 提取的文字超过转换上限。')
      if (text.trim()) chapters.push(...textChapters(text, `第 ${index + 1} 页`, false))
      else skipped++
    }
    if (!chapters.length) throw new Error('此 PDF 没有可提取的文字。扫描件需要先做 OCR，原文件仍可阅读和下载。')
    const notes = ['编辑稿按页提取文字。原始版式、图片和分页保存在 PDF 中，提取的阅读顺序可能需要调整。']
    if (skipped) notes.push(`有 ${skipped} 页没有可提取的文字，仍可在原 PDF 查看。`)
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
      converted = { chapters: structuredChapters(await readRtf(blob)), notes: ['转换正文与基本行内样式。RTF 的图片、复杂列表、表格和页式布局以原件为准。'] }
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
    default: throw new Error('此格式只能保存原文件。可另建空白编辑稿。')
  }
  signal.throwIfAborted()
  if (!converted.chapters.some((chapter) => meaningful(chapter.content))) throw new Error('未找到可转换的正文或图片。')
  if (converted.chapters.length > maxChapters) throw new Error(`转换结果超过 ${maxChapters} 章。`)
  for (const chapter of converted.chapters) checkDocument(chapter.content)
  return converted
}
