import { t } from '../i18n'
import { BlobReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { openPackage, packagePath, xml } from '../archive-preview'
import { decodeText } from '../formats'
import { maxTextPreviewSize } from '../text-preview'
import { rasterData } from './markup'
import { maxEditionImageBytes, maxImageBytes } from './model'

const xmlDeclaration = /<!\s*(?:DOCTYPE|ENTITY)\b/i
const xmlPart = /\.(xml|rels)$/i
const rasterPart = /\.(png|jpe?g|gif|webp)$/i

export async function docxMarkup(blob: Blob, signal: AbortSignal) {
  const archive = await openPackage(blob, signal)
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  let total = 0
  let skipped = 0
  for (const [name, entry] of archive.entries) {
    const isXml = xmlPart.test(name)
    if (!isXml && !rasterPart.test(name)) continue
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw new Error(t('officeImport.theDocxContainsAnInvalidPartPath'))
    if (!isXml && entry.uncompressedSize > maxImageBytes) {
      skipped++
      continue
    }
    const data = await archive.binary(name, Math.min(isXml ? maxTextPreviewSize : maxImageBytes, 48 * 1024 * 1024 - total))
    total += data.size
    if (isXml && xmlDeclaration.test(decodeText(new Uint8Array(await data.arrayBuffer())).text)) throw new Error(t('officeImport.theDocxContainsAnUnsupportedXmlDeclaration'))
    await zip.add(name, new BlobReader(data), { level: 0 })
  }
  const safePackage = await zip.close()
  signal.throwIfAborted()
  const { convertToHtml, images } = await import('mammoth')
  let imageRemaining = maxEditionImageBytes
  const result = await convertToHtml({ arrayBuffer: safePackage.slice().buffer }, {
    externalFileAccess: false,
    includeEmbeddedStyleMap: false,
    ignoreEmptyParagraphs: false,
    styleMap: ['u => u', 'strike => s'],
    convertImage: images.imgElement(async (image) => {
      const bytes = await image.readAsArrayBuffer()
      const data = bytes.byteLength <= imageRemaining ? await rasterData(new Blob([bytes])) : undefined
      if (!data) skipped++
      else imageRemaining -= bytes.byteLength
      return { src: data ?? '' }
    }),
  })
  const notes = [t('officeImport.preservesCommonTextStylesHeadingsListsTablesAnd')]
  if (skipped) notes.push(t('officeImport.imagePartSAreOversizedOrCouldNot', [skipped]))
  if (result.messages.length) notes.push(t('officeImport.thereAreWordCompatibilityWarningSCheckComplex', [result.messages.length]))
  return { markup: result.value, notes }
}

const office = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'
const text = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
const style = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0'
const fo = 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0'
const draw = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0'
const table = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0'
const xlink = 'http://www.w3.org/1999/xlink'

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
}

export async function odtMarkup(blob: Blob, signal: AbortSignal) {
  const archive = await openPackage(blob, signal)
  const content = xml(await archive.text('content.xml'))
  const sheets = archive.entries.has('styles.xml') ? [xml(await archive.text('styles.xml')), content] : [content]
  const styles = new Map<string, Element>()
  const numbered = new Set<string>()
  for (const sheet of sheets) {
    for (const entry of sheet.getElementsByTagNameNS(style, 'style')) styles.set(entry.getAttributeNS(style, 'name') ?? '', entry)
    for (const entry of sheet.getElementsByTagNameNS(text, 'list-style')) {
      if (entry.getElementsByTagNameNS(text, 'list-level-style-number').length) numbered.add(entry.getAttributeNS(style, 'name') ?? '')
    }
  }
  const body = content.getElementsByTagNameNS(office, 'text')[0]
  if (!body) throw new Error(t('archivePreview.theOdtIsMissingItsDocumentBody'))
  let expanded = 0
  const assetCache = new Map<string, string | undefined>()

  async function walk(node: Node, depth = 0): Promise<string> {
    signal.throwIfAborted()
    if (depth > 128) throw new Error(t('officeImport.theOdtDocumentStructureIsNestedTooDeeply'))
    if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.nodeValue ?? '')
    if (!(node instanceof Element)) return ''
    const name = node.localName
    if (node.namespaceURI === office && name === 'annotation') return ''
    if (node.namespaceURI === draw && name === 'image') {
      const href = node.getAttributeNS(xlink, 'href') ?? ''
      const path = packagePath('content.xml', href)
      if (path && archive.entries.has(path) && !assetCache.has(path)) {
        const entry = archive.entries.get(path)!
        assetCache.set(path, entry.uncompressedSize <= maxImageBytes ? await rasterData(await archive.binary(path, maxImageBytes)) : undefined)
      }
      const url = path && assetCache.get(path)
      expanded += url?.length ?? 0
      if (expanded > 40 * 1024 * 1024) throw new Error(t('officeImport.theEmbeddedOdtContentExceedsTheConversionLimit'))
      return `<img src="${url ?? ''}" alt="${escapeHtml(t('officeImport.illustration'))}">`
    }
    if (node.namespaceURI === text) {
      if (name === 'line-break') return '<br>'
      if (name === 'tab') return '&nbsp;&nbsp;&nbsp;&nbsp;'
      if (name === 's') {
        const count = Math.min(256, Math.max(1, Number.parseInt(node.getAttributeNS(text, 'c') ?? '1', 10) || 1))
        expanded += count * 6
        if (expanded > 40 * 1024 * 1024) throw new Error(t('officeImport.theEmbeddedOdtContentExceedsTheConversionLimit'))
        return '&nbsp;'.repeat(count)
      }
    }

    const parts: string[] = []
    for (const child of node.childNodes) parts.push(await walk(child, depth + 1))
    let markup = parts.join('')
    if (node.namespaceURI === text) {
      const styleName = node.getAttributeNS(text, 'style-name') ?? ''
      const properties = styles.get(styleName)?.getElementsByTagNameNS(style, 'text-properties')[0]
      if (properties && ['p', 'h', 'span'].includes(name)) {
        if (properties.getAttributeNS(fo, 'font-weight') === 'bold') markup = `<strong>${markup}</strong>`
        if (properties.getAttributeNS(fo, 'font-style') === 'italic') markup = `<em>${markup}</em>`
        const underline = properties.getAttributeNS(style, 'text-underline-style')
        if (underline && underline !== 'none') markup = `<u>${markup}</u>`
      }
      if (name === 'p') return `<p>${markup}</p>`
      if (name === 'h') {
        const level = Math.max(1, Math.min(6, Number.parseInt(node.getAttributeNS(text, 'outline-level') ?? '1', 10) || 1))
        return `<h${level}>${markup}</h${level}>`
      }
      if (name === 'list') return numbered.has(styleName) ? `<ol>${markup}</ol>` : `<ul>${markup}</ul>`
      if (name === 'list-item') return `<li>${markup}</li>`
    }
    if (node.namespaceURI === table) {
      if (name === 'table') return `<table>${markup}</table>`
      if (name === 'table-row') return `<tr>${markup}</tr>`
      if (name === 'table-cell') {
        const span = (axis: string) => Math.max(1, Math.min(100, Number.parseInt(node.getAttributeNS(table, `number-${axis}-spanned`) ?? '1', 10) || 1))
        return `<td colspan="${span('columns')}" rowspan="${span('rows')}">${markup}</td>`
      }
    }
    return markup
  }

  const markup = await walk(body)
  return { markup, notes: [t('officeImport.convertsTextCommonStylesListsBasicTablesAnd')] }
}
