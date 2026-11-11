import { downloadFile, element } from '../ui'
import { applyExportStyle, exportStyles, printPageStyle } from './export-style'
import type { ExportPreset } from './export-style'
import { chapterText, hasChapterHeading } from './model'
import type { ChapterInput } from './model'
import { toMarkup } from './schema'
import paperCSS from './export-paper.css?raw'
import './export-paper.css'

export const outputFormats = {
  txt: 'TXT',
  md: 'Markdown',
  html: 'HTML',
  docx: 'DOCX',
  pdf: 'PDF',
} as const

export type OutputFormat = keyof typeof outputFormats
type TextFormat = 'txt' | 'md'

export function isTextFormat(format: OutputFormat): format is TextFormat {
  return format === 'txt' || format === 'md'
}

function article(chapters: ChapterInput[], preset?: ExportPreset) {
  const paper = element('article', 'export-paper')
  if (preset) applyExportStyle(paper, preset)
  for (const chapter of chapters) {
    const section = element('section')
    if (!hasChapterHeading(chapter)) section.append(element('h1', '', chapter.title))
    const body = element('div')
    body.innerHTML = toMarkup(chapter.content)
    section.append(body)
    paper.append(section)
  }
  return paper
}

async function textExport(format: TextFormat, chapters: ChapterInput[]) {
  if (format === 'txt') {
    return chapters.map((chapter) => {
      const heading = hasChapterHeading(chapter) ? '' : chapter.title + '\n\n'
      return heading + chapterText(chapter.content, '\n\n')
    }).join('\n\n')
  }
  const [{ default: Turndown }, { gfm }] = await Promise.all([import('turndown'), import('turndown-plugin-gfm')])
  const convert = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  convert.use(gfm)
  convert.addRule('describeImages', { filter: 'img', replacement: (_, node) => {
    const alt = node.getAttribute('alt')
    return alt ? '［图片：' + convert.escape(alt) + '］' : '［图片］'
  } })
  return convert.turndown(article(chapters)) + '\n'
}

export async function renderExportPreview(format: OutputFormat, preset: ExportPreset, chapter: ChapterInput) {
  const sample = { ...chapter, content: { ...chapter.content, content: chapter.content.content?.slice(0, 8) } }
  if (isTextFormat(format)) return element('pre', 'export-plain', await textExport(format, [sample]))
  return article([sample], preset)
}

let finishPrint: (() => void) | undefined

async function printEdition(title: string, chapters: ChapterInput[], preset: ExportPreset) {
  finishPrint?.()
  const printable = element('main', 'print-edition')
  printable.append(article(chapters, preset))
  const pageStyle = element('style', '', printPageStyle(preset))
  pageStyle.media = 'print'
  document.head.append(pageStyle)
  document.body.append(printable)
  const previousTitle = document.title
  const root = document.documentElement
  const cleanup = () => {
    if (finishPrint !== cleanup) return
    printable.remove()
    pageStyle.remove()
    root.classList.remove('printing-edition')
    if (document.title === title) document.title = previousTitle
    window.removeEventListener('afterprint', cleanup)
    finishPrint = undefined
  }
  finishPrint = cleanup
  try {
    await Promise.all(Array.from(printable.querySelectorAll('img'), (img) => img.decode().catch(() => {})))
    if (finishPrint !== cleanup) return
    document.title = title
    root.classList.add('printing-edition')
    if (window.newWorldDesktop) {
      await window.newWorldDesktop.savePdf(title)
      cleanup()
    } else {
      window.addEventListener('afterprint', cleanup, { once: true })
      window.print()
    }
  } catch (error) {
    cleanup()
    throw error
  }
}

export async function exportEdition(format: OutputFormat, title: string, chapters: ChapterInput[], preset: ExportPreset = exportStyles.standard) {
  const filename = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 130).trim() || 'New World 编辑稿'
  if (format === 'pdf') {
    await printEdition(filename, chapters, preset)
    return
  }
  let output: Blob
  if (format === 'docx') {
    const { wordExport } = await import('./docx-export')
    output = await wordExport(title, chapters, preset)
  } else if (isTextFormat(format)) {
    const type = format === 'txt' ? 'text/plain;charset=utf-8' : 'text/markdown;charset=utf-8'
    output = new Blob([await textExport(format, chapters)], { type })
  } else {
    const titleNode = element('title', '', title)
    const style = paperCSS + '\n' + printPageStyle(preset)
    const html = article(chapters, preset).outerHTML
    output = new Blob([
      '<!doctype html>\n<html lang="zh-CN" class="export-document"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      titleNode.outerHTML, '<style>', style, '</style></head><body>', html, '</body></html>',
    ], { type: 'text/html;charset=utf-8' })
  }
  downloadFile(output, filename + '.' + format)
}
