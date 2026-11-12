import { t } from '../i18n'
import {
  BorderStyle, Document, HeadingLevel, ImageRun, LevelFormat, LineRuleType, Packer, Paragraph,
  Table, TableCell, TableRow, TextRun, WidthType, convertMillimetersToTwip,
} from 'docx'
import type { ILevelsOptions, IStylesOptions } from 'docx'
import type { JSONContent } from '@tiptap/core'
import { a4, headingLayout, headingScales } from './export-style'
import type { ExportPreset } from './export-style'
import { imageInfo } from './markup'
import { hasChapterHeading } from './model'
import type { ChapterInput } from './model'

const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
const bodyFont = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: 'SimSun' }
const headingFont = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Microsoft YaHei' }
const codeFont = { ...bodyFont, ascii: 'Consolas', hAnsi: 'Consolas' }

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
      return new ImageRun({ type, data, transformation: { width, height }, altText: { name: alt || t('docxExport.illustration'), title: alt, description: alt } })
    } catch {
      // Retain the image description if the browser cannot decode the raster.
    }
  }
  return new TextRun(alt ? t('docxExport.image', [alt]) : t('docxExport.image46'))
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
          text, break: index ? 1 : undefined, bold: marks.has('bold') || undefined, italics: marks.has('italic') || undefined,
          underline: marks.has('underline') ? {} : undefined, strike: marks.has('strike') || undefined,
          font: code || marks.has('code') ? codeFont : undefined,
        }))
      }
    }
  }
  return runs
}

export async function wordExport(title: string, chapters: ChapterInput[], preset: ExportPreset) {
  const numbering: { reference: string; levels: ILevelsOptions[] }[] = []
  const children: (Paragraph | Table)[] = []
  const spacing = {
    after: Math.round(preset.fontPt * preset.paragraphGap * 20),
    line: Math.round(preset.lineHeight * 240),
    lineRule: LineRuleType.AUTO,
  }
  const listGap = Math.round(preset.fontPt * 5)
  const styles: IStylesOptions = {
    default: {
      document: {
        run: { font: bodyFont, size: preset.fontPt * 2, color: '000000', language: { eastAsia: 'zh-CN' } },
        paragraph: { spacing },
      },
    },
    paragraphStyles: headings.map((id, index) => {
      const size = preset.fontPt * headingScales[index]
      return {
        id, name: 'Heading ' + (index + 1), basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: headingFont, size: Math.round(size * 2), bold: true, color: '000000' },
        paragraph: {
          outlineLevel: index, keepNext: true, keepLines: true,
          spacing: {
            before: Math.round(size * headingLayout.before * 20),
            after: Math.round(size * headingLayout.after * 20),
            line: Math.round(headingLayout.lineHeight * 240), lineRule: LineRuleType.AUTO,
          },
        },
      }
    }),
  }

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
          items.push(new Paragraph({
            children: await inline(first?.content ?? []), numbering: { reference, level: 0 },
            spacing: { ...spacing, before: listGap, after: listGap },
          }))
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
        items.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, color: '000000', size: 6, space: 4 } } }))
      } else if (node.type === 'image') {
        items.push(new Paragraph({ children: [await imageRun(node)] }))
      } else {
        const heading = node.type === 'heading' ? headings[Number(node.attrs?.level ?? 1) - 1] : undefined
        items.push(new Paragraph({
          heading, children: await inline(node.content ?? [], node.type === 'codeBlock'),
          indent: quote || depth ? { left: depth * 420 + (quote ? 320 : 0) } : undefined,
          border: quote ? { left: { style: BorderStyle.SINGLE, color: '000000', size: 8, space: 8 } } : undefined,
        }))
      }
    }
    return items
  }

  for (const chapter of chapters) {
    if (!hasChapterHeading(chapter)) children.push(new Paragraph({ text: chapter.title, heading: HeadingLevel.HEADING_1 }))
    children.push(...await blocks(chapter.content.content ?? []))
  }
  const margin = convertMillimetersToTwip(preset.marginMm)
  const document = new Document({
    title, styles, numbering: { config: numbering },
    sections: [{
      properties: {
        page: {
          size: { width: convertMillimetersToTwip(a4.width), height: convertMillimetersToTwip(a4.height) },
          margin: { top: margin, bottom: margin, left: margin, right: margin },
        },
      },
      children,
    }],
  })
  return Packer.toBlob(document)
}
