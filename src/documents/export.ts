import { downloadFile, element } from '../ui'
import { chapterText, hasChapterHeading } from './model'
import type { ChapterInput } from './model'
import { toMarkup } from './schema'

export const outputFormats = {
  txt: 'TXT',
  md: 'Markdown',
  html: 'HTML',
  docx: 'DOCX',
  pdf: 'PDF',
} as const

export type OutputFormat = keyof typeof outputFormats

function article(chapters: ChapterInput[]) {
  const content = element('div', 'edition-print-content')
  for (const chapter of chapters) {
    const section = element('section')
    if (!hasChapterHeading(chapter)) section.append(element('h1', '', chapter.title))
    const body = element('div')
    body.innerHTML = toMarkup(chapter.content)
    section.append(body)
    content.append(section)
  }
  return content
}

async function printEdition(title: string, chapters: ChapterInput[]) {
  document.querySelector('.print-edition')?.remove()
  const printable = element('main', 'print-edition')
  printable.append(article(chapters))
  document.body.append(printable)
  const previousTitle = document.title
  const cleanup = () => {
    printable.remove()
    document.body.classList.remove('printing-edition')
    if (document.title === title) document.title = previousTitle
    window.removeEventListener('afterprint', cleanup)
  }
  try {
    await Promise.all(Array.from(printable.querySelectorAll('img'), (img) => img.decode().catch(() => {})))
    document.title = title
    document.body.classList.add('printing-edition')
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

export async function exportEdition(format: OutputFormat, title: string, chapters: ChapterInput[]) {
  const filename = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 130).trim() || 'New World 编辑稿'
  if (format === 'pdf') {
    await printEdition(filename, chapters)
    return
  }
  let output: Blob
  if (format === 'docx') {
    const { wordExport } = await import('./docx-export')
    output = await wordExport(title, chapters)
  } else if (format === 'txt') {
    output = new Blob([chapters.map((chapter) => `${hasChapterHeading(chapter) ? '' : `${chapter.title}\n\n`}${chapterText(chapter.content)}`).join('\n\n')], { type: 'text/plain;charset=utf-8' })
  } else if (format === 'md') {
    const [{ default: Turndown }, { gfm }] = await Promise.all([import('turndown'), import('turndown-plugin-gfm')])
    const convert = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    convert.use(gfm)
    convert.addRule('describeImages', { filter: 'img', replacement: (_, node) => `［图片${node.getAttribute('alt') ? `：${convert.escape(node.getAttribute('alt')!)}` : ''}］` })
    output = new Blob([convert.turndown(article(chapters)) + '\n'], { type: 'text/markdown;charset=utf-8' })
  } else {
    const titleNode = element('title', '', title)
    const style = 'body{margin:2rem auto;padding:0 1rem;max-width:48rem;font-family:system-ui,sans-serif;line-height:1.8}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #b4b9af;padding:.4rem}blockquote{border-left:3px solid #9aa798;margin-left:0;padding-left:1rem}pre{white-space:pre-wrap}'
    output = new Blob([`<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${titleNode.outerHTML}<style>${style}</style></head><body>${article(chapters).outerHTML}</body></html>`], { type: 'text/html;charset=utf-8' })
  }
  downloadFile(output, `${filename}.${format}`)
}
