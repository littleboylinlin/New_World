import {
  BorderStyle, Document, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph,
  Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx'
import type { ILevelsOptions } from 'docx'
import type { JSONContent } from '@tiptap/core'
import { imageInfo } from './markup'
import { hasChapterHeading } from './model'
import type { ChapterInput } from './model'

const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]

async function imageRun(node: JSONContent): Promise<ImageRun | TextRun> {
  const source = node.attrs?.src
  const alt = String(node.attrs?.alt ?? '')
  const info = imageInfo(source)
  if (info) {
    try {
      const image = new Image()
      image.src = source
      await image.decode()
      if (!image.naturalWidth || !image.naturalHeight) throw new Error()
      const scale = Math.min(1, 560 / image.naturalWidth, 730 / image.naturalHeight)
      const width = Math.max(1, Math.round(image.naturalWidth * scale))
      const height = Math.max(1, Math.round(image.naturalHeight * scale))
      let data = Uint8Array.from(atob(info.base64), (character) => character.charCodeAt(0))
      let type: 'png' | 'jpg' | 'gif' = info.type === 'jpeg' ? 'jpg' : info.type === 'gif' ? 'gif' : 'png'
      if (info.type === 'webp') {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) throw new Error()
        context.drawImage(image, 0, 0, width, height)
        const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (!png) throw new Error()
        data = new Uint8Array(await png.arrayBuffer())
        type = 'png'
      }
      return new ImageRun({ type, data, transformation: { width, height }, altText: { name: alt || '插图', title: alt, description: alt } })
    } catch {
      // Retain the image description if the browser cannot decode the raster.
    }
  }
  return new TextRun(alt ? `[图片：${alt}]` : '[图片]')
}

async function inline(content: JSONContent[], code = false) {
  const runs: (TextRun | ImageRun)[] = []
  for (const node of content) {
    if (node.type === 'image') runs.push(await imageRun(node))
    else if (node.type === 'hardBreak') runs.push(new TextRun({ break: 1 }))
    else if (node.type === 'text') {
      const marks = new Set(node.marks?.map((mark) => mark.type))
      const parts = (node.text ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').split('\n')
      for (const [index, text] of parts.entries()) {
        runs.push(new TextRun({
          text, break: index ? 1 : undefined, bold: marks.has('bold'), italics: marks.has('italic'),
          underline: marks.has('underline') ? {} : undefined, strike: marks.has('strike'),
          font: code || marks.has('code') ? 'Consolas' : undefined,
        }))
      }
    }
  }
  return runs
}

export async function wordExport(title: string, chapters: ChapterInput[]) {
  const numbering: { reference: string; levels: ILevelsOptions[] }[] = []
  const children: (Paragraph | Table)[] = []

  async function blocks(nodes: JSONContent[], depth = 0, quote = false): Promise<(Paragraph | Table)[]> {
    const items: (Paragraph | Table)[] = []
    for (const node of nodes) {
      if (node.type === 'blockquote') {
        items.push(...await blocks(node.content ?? [], depth, true))
      } else if (node.type === 'bulletList' || node.type === 'orderedList') {
        const reference = `list-${numbering.length + 1}`
        numbering.push({ reference, levels: [{
          level: 0, format: node.type === 'orderedList' ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: node.type === 'orderedList' ? '%1.' : '•', start: Number(node.attrs?.start ?? 1),
          style: { paragraph: { indent: { left: (depth + 1) * 420, hanging: 240 } } },
        }] })
        for (const item of node.content ?? []) {
          const [first, ...rest] = item.content ?? []
          items.push(new Paragraph({ children: await inline(first?.content ?? []), numbering: { reference, level: 0 } }))
          items.push(...await blocks(rest, depth + 1, quote))
        }
      } else if (node.type === 'table') {
        const rows: TableRow[] = []
        for (const row of node.content ?? []) {
          const cells: TableCell[] = []
          for (const cell of row.content ?? []) {
            const content = await blocks(cell.content ?? [])
            if (!content.length || content.at(-1) instanceof Table) content.push(new Paragraph(''))
            cells.push(new TableCell({ children: content, columnSpan: cell.attrs?.colspan, rowSpan: cell.attrs?.rowspan }))
          }
          if (cells.length) rows.push(new TableRow({ children: cells, tableHeader: row.content?.every((cell) => cell.type === 'tableHeader') }))
        }
        if (rows.length) items.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }))
      } else if (node.type === 'horizontalRule') {
        items.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, color: 'A0A69E', size: 6, space: 4 } } }))
      } else if (node.type === 'image') {
        items.push(new Paragraph({ children: [await imageRun(node)] }))
      } else {
        const heading = node.type === 'heading' ? headings[Number(node.attrs?.level ?? 1) - 1] : undefined
        items.push(new Paragraph({
          heading, children: await inline(node.content ?? [], node.type === 'codeBlock'),
          indent: quote || depth ? { left: depth * 420 + (quote ? 320 : 0) } : undefined,
          border: quote ? { left: { style: BorderStyle.SINGLE, color: 'A0A69E', size: 8, space: 8 } } : undefined,
          spacing: { after: 140 },
        }))
      }
    }
    return items
  }

  for (const chapter of chapters) {
    if (!hasChapterHeading(chapter)) children.push(new Paragraph({ text: chapter.title, heading: HeadingLevel.HEADING_1 }))
    children.push(...await blocks(chapter.content.content ?? []))
  }
  const document = new Document({ title, numbering: { config: numbering }, sections: [{ children }] })
  return Packer.toBlob(document)
}
