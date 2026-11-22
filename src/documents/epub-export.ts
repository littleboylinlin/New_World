import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js'
import type { JSONContent } from '@tiptap/core'
import type { ChapterInput } from './model'
import type { ExportWorkInfo } from './work-export'

const maxRasterBytes = 4 * 1024 * 1024
const rasterDataPattern = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i
const xmlControlChars = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

interface EmbeddedAsset {
  id: string
  href: string
  mediaType: string
  bytes: Uint8Array<ArrayBuffer>
}

export interface EpubExportLabels {
  toc?: string
  cover?: string
  author?: string
  synopsis?: string
  imageFallback?: string
}

export interface EpubExportOptions {
  title: string
  author?: string
  description?: string
  language?: string
  fallbackLanguage?: string
  identifier?: string
  modified?: Date
  chapters: ChapterInput[]
  cover?: Blob
  information?: ExportWorkInfo
  labels?: EpubExportLabels
}

function stripXmlControls(value: string): string {
  return value.replace(xmlControlChars, '')
}

function escapeXml(value: string): string {
  return stripXmlControls(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function padIndex(index: number): string {
  return String(index).padStart(3, '0')
}

function decodeBase64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function detectImageType(bytes: Uint8Array): 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif' | undefined {
  if (bytes.length < 4) return undefined
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.subarray(0, 6))
    if (header === 'GIF87a' || header === 'GIF89a') return 'gif'
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.subarray(0, 4))
    const webp = String.fromCharCode(...bytes.subarray(8, 12))
    if (riff === 'RIFF' && webp === 'WEBP') return 'webp'
    const box = String.fromCharCode(...bytes.subarray(4, 12))
    if (box === 'ftypavif' || box === 'ftypavis') return 'avif'
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'
  return undefined
}

function parseRasterDataUrl(source: unknown): { type: 'png' | 'jpeg' | 'gif' | 'webp'; bytes: Uint8Array<ArrayBuffer> } | undefined {
  if (typeof source !== 'string' || source.length > maxRasterBytes * 4 / 3 + 40) return undefined
  const match = rasterDataPattern.exec(source)
  if (!match || match[2].length < 16 || match[2].length % 4) return undefined
  const declared = match[1].toLowerCase() as 'png' | 'jpeg' | 'gif' | 'webp'
  const byteLength = match[2].length * 3 / 4 - (source.endsWith('==') ? 2 : source.endsWith('=') ? 1 : 0)
  if (byteLength > maxRasterBytes) return undefined
  const bytes = decodeBase64Bytes(match[2])
  if (detectImageType(bytes) !== declared) return undefined
  return { type: declared, bytes }
}

function extensionForImageType(type: 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif'): string {
  return type === 'jpeg' ? 'jpg' : type
}

function mediaTypeForImageType(type: 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif'): string {
  return `image/${type}`
}

async function prepareCoverAsset(cover: Blob): Promise<EmbeddedAsset | undefined> {
  if (!cover.size) return undefined
  const rawBytes = new Uint8Array(await cover.arrayBuffer())
  let type = detectImageType(rawBytes)
  if (!type) {
    const normalized = cover.type.toLowerCase()
    if (normalized === 'image/png') type = 'png'
    else if (normalized === 'image/jpeg' || normalized === 'image/jpg') type = 'jpeg'
    else if (normalized === 'image/gif') type = 'gif'
    else if (normalized === 'image/webp') type = 'webp'
    else if (normalized === 'image/bmp') type = 'bmp'
    else if (normalized === 'image/avif') type = 'avif'
  }
  if (!type) return undefined
  let bytes: Uint8Array<ArrayBuffer> = rawBytes
  if ((type === 'bmp' || type === 'avif') && typeof document !== 'undefined' && typeof URL !== 'undefined') {
    const objectUrl = URL.createObjectURL(new Blob([rawBytes], { type: mediaTypeForImageType(type) }))
    try {
      const image = new Image()
      image.src = objectUrl
      await image.decode()
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')
        if (context) {
          context.drawImage(image, 0, 0)
          const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
          if (png) {
            bytes = new Uint8Array(await png.arrayBuffer())
            type = 'png'
          }
        }
      }
    } catch {
      // Keep original cover bytes if browser transcoding is unavailable.
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }
  return {
    id: 'cover-image',
    href: `images/cover.${extensionForImageType(type)}`,
    mediaType: mediaTypeForImageType(type),
    bytes,
  }
}

function collectPlainText(node: JSONContent | undefined): string {
  if (!node) return ''
  if (node.text) return node.text
  if (!node.content?.length) return ''
  return node.content.map(collectPlainText).join(' ')
}

function resolveEpubLanguage(title: string, chapters: ChapterInput[], explicit?: string, fallback?: string): string {
  const trimmed = explicit?.trim()
  if (trimmed) return trimmed
  const body = chapters.map((chapter) => collectPlainText(chapter.content)).join(' ').trim()
  const sample = body ? `${title} ${body}` : [title, ...chapters.map((chapter) => chapter.title)].join(' ')
  const cjkCount = sample.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const latinWords = sample.match(/[A-Za-z]+/g)?.length ?? 0
  if (cjkCount > 0 && cjkCount >= latinWords) return 'zh-CN'
  if (latinWords > 0 && cjkCount === 0) return 'en'
  const fallbackTrimmed = fallback?.trim()
  return fallbackTrimmed || 'en'
}

function hasChapterHeading(chapter: ChapterInput): boolean {
  const first = chapter.content.content?.[0]
  const heading = first?.content?.map((node) => node.text ?? '').join('').replace(/\s+/g, ' ').trim()
  return first?.type === 'heading' && heading === chapter.title
}

function wrapXhtmlDocument(title: string, language: string, stylesheetHref: string, bodyHtml: string, bodyClass?: string): string {
  const lang = escapeXml(language)
  const classAttr = bodyClass ? ` class="${escapeXml(bodyClass)}"` : ''
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}" lang="${lang}">`,
    '<head>',
    '  <meta charset="utf-8"/>',
    `  <title>${escapeXml(title)}</title>`,
    `  <link rel="stylesheet" type="text/css" href="${escapeXml(stylesheetHref)}"/>`,
    '</head>',
    `<body${classAttr}>`,
    bodyHtml,
    '</body>',
    '</html>',
  ].join('\n')
}

export async function epubExport(options: EpubExportOptions): Promise<Blob> {
  const title = stripXmlControls(options.title).trim() || 'Untitled'
  const author = options.author ? stripXmlControls(options.author).trim() : ''
  const description = options.description ? stripXmlControls(options.description).trim() : ''
  const language = resolveEpubLanguage(title, options.chapters, options.language, options.fallbackLanguage)
  const identifier = stripXmlControls(options.identifier?.trim() || `urn:uuid:${crypto.randomUUID()}`)
  const modified = (options.modified ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')

  const tocLabel = options.labels?.toc?.trim() || 'Table of Contents'
  const coverLabel = options.labels?.cover?.trim() || 'Cover'
  const authorLabel = options.labels?.author?.trim() || 'Author'
  const synopsisLabel = options.labels?.synopsis?.trim() || 'Synopsis'
  const imageFallbackLabel = options.labels?.imageFallback?.trim() || '[Image]'

  const imagesBySource = new Map<string, EmbeddedAsset>()
  const images: EmbeddedAsset[] = []

  const registerInlineImage = (source: unknown): EmbeddedAsset | undefined => {
    const parsed = parseRasterDataUrl(source)
    if (!parsed) return undefined
    const existing = imagesBySource.get(source as string)
    if (existing) return existing
    const number = padIndex(images.length + 1)
    const asset: EmbeddedAsset = {
      id: `image-${number}`,
      href: `images/image-${number}.${extensionForImageType(parsed.type)}`,
      mediaType: mediaTypeForImageType(parsed.type),
      bytes: parsed.bytes,
    }
    imagesBySource.set(source as string, asset)
    images.push(asset)
    return asset
  }

  const renderInlineNodes = (nodes: JSONContent[] | undefined): string => {
    if (!nodes?.length) return ''
    return nodes.map((node) => {
      if (node.type === 'hardBreak') return '<br/>'
      if (node.type === 'image') {
        const alt = String(node.attrs?.alt ?? '')
        const asset = registerInlineImage(node.attrs?.src)
        if (asset) return `<img src="../${asset.href}" alt="${escapeXml(alt)}"/>`
        return escapeXml(alt ? `[${alt}]` : imageFallbackLabel)
      }
      if (node.type === 'text') {
        let rendered = escapeXml(node.text ?? '')
        const markTypes = new Set(node.marks?.map((mark) => mark.type))
        if (markTypes.has('code')) rendered = `<code>${rendered}</code>`
        if (markTypes.has('bold')) rendered = `<strong>${rendered}</strong>`
        if (markTypes.has('italic')) rendered = `<em>${rendered}</em>`
        if (markTypes.has('underline')) rendered = `<u>${rendered}</u>`
        if (markTypes.has('strike')) rendered = `<s>${rendered}</s>`
        return rendered
      }
      return renderInlineNodes(node.content)
    }).join('')
  }

  const renderBlocks = (nodes: JSONContent[] | undefined): string => {
    if (!nodes?.length) return ''
    return nodes.map((node) => {
      switch (node.type) {
        case 'paragraph': {
          const inner = renderInlineNodes(node.content)
          return `<p>${inner || '<br/>'}</p>`
        }
        case 'heading': {
          const rawLevel = Number(node.attrs?.level ?? 1)
          const level = Number.isInteger(rawLevel) ? Math.min(6, Math.max(1, rawLevel)) : 1
          const inner = renderInlineNodes(node.content)
          return `<h${level}>${inner || '<br/>'}</h${level}>`
        }
        case 'blockquote': {
          const inner = renderBlocks(node.content)
          return inner ? `<blockquote>${inner}</blockquote>` : ''
        }
        case 'bulletList': {
          const inner = renderBlocks(node.content)
          return inner ? `<ul>${inner}</ul>` : ''
        }
        case 'orderedList': {
          const inner = renderBlocks(node.content)
          if (!inner) return ''
          const start = Number(node.attrs?.start ?? 1)
          const startAttr = Number.isInteger(start) && start > 1 ? ` start="${start}"` : ''
          return `<ol${startAttr}>${inner}</ol>`
        }
        case 'listItem': {
          return `<li>${renderBlocks(node.content)}</li>`
        }
        case 'codeBlock': {
          const text = collectPlainText(node)
          return `<pre><code>${escapeXml(text)}</code></pre>`
        }
        case 'horizontalRule':
          return '<hr/>'
        case 'image': {
          const alt = String(node.attrs?.alt ?? '')
          const asset = registerInlineImage(node.attrs?.src)
          if (asset) return `<p class="illustration"><img src="../${asset.href}" alt="${escapeXml(alt)}"/></p>`
          return `<p>${escapeXml(alt ? `[${alt}]` : imageFallbackLabel)}</p>`
        }
        case 'table': {
          const rows = renderBlocks(node.content)
          return rows ? `<table><tbody>${rows}</tbody></table>` : ''
        }
        case 'tableRow': {
          const cells = (node.content ?? []).map((cell) => {
            const tag = cell.type === 'tableHeader' ? 'th' : 'td'
            const attrs: string[] = []
            const colspan = Number(cell.attrs?.colspan ?? 1)
            const rowspan = Number(cell.attrs?.rowspan ?? 1)
            if (Number.isInteger(colspan) && colspan > 1) attrs.push(`colspan="${colspan}"`)
            if (Number.isInteger(rowspan) && rowspan > 1) attrs.push(`rowspan="${rowspan}"`)
            const attrText = attrs.length ? ' ' + attrs.join(' ') : ''
            return `<${tag}${attrText}>${renderBlocks(cell.content)}</${tag}>`
          }).join('')
          return cells ? `<tr>${cells}</tr>` : ''
        }
        default:
          return node.content ? renderBlocks(node.content) : ''
      }
    }).filter(Boolean).join('\n')
  }

  const coverAsset = options.cover ? await prepareCoverAsset(options.cover) : undefined
  const coverXhtml = coverAsset
    ? wrapXhtmlDocument(
      coverLabel,
      language,
      'styles.css',
      `<figure class="cover-wrap"><img class="cover-image" src="${coverAsset.href}" alt="${escapeXml(coverLabel)}"/></figure>`,
      'cover-page',
    )
    : undefined

  const info = options.information
  const hasInfoSection = Boolean(info && (info.title || info.subtitle || info.author || info.synopsis))
  const titlepageXhtml = hasInfoSection && info
    ? wrapXhtmlDocument(
      info.title || title,
      language,
      'styles.css',
      [
        '<section class="title-page">',
        info.title ? `  <h1 class="book-title">${escapeXml(info.title)}</h1>` : '',
        info.subtitle ? `  <p class="book-subtitle">${escapeXml(info.subtitle)}</p>` : '',
        info.author ? `  <p class="book-author">${escapeXml(`${authorLabel}: ${info.author}`)}</p>` : '',
        info.synopsis
          ? [
            `  <h2 class="book-synopsis-heading">${escapeXml(synopsisLabel)}</h2>`,
            `  <p class="book-synopsis">${info.synopsis.split(/\r\n|\r|\n/).map(escapeXml).join('<br/>')}</p>`,
          ].join('\n')
          : '',
        '</section>',
      ].filter(Boolean).join('\n'),
    )
    : undefined

  const chapterFiles = options.chapters.map((chapter, index) => {
    const number = padIndex(index + 1)
    const chapterTitle = stripXmlControls(chapter.title).trim() || `Chapter ${index + 1}`
    const heading = hasChapterHeading(chapter) ? '' : `<h1>${escapeXml(chapterTitle)}</h1>`
    const body = renderBlocks(chapter.content.content)
    const sectionBody = ['<section>', heading, body, '</section>'].filter(Boolean).join('\n')
    return {
      id: `chapter-${number}`,
      href: `chapters/chapter-${number}.xhtml`,
      title: chapterTitle,
      xhtml: wrapXhtmlDocument(chapterTitle, language, '../styles.css', sectionBody),
    }
  })

  const stylesCss = [
    'body { margin: 0; padding: 0 4%; line-height: 1.75; overflow-wrap: anywhere; }',
    'h1, h2, h3, h4, h5, h6 { margin: 1.1em 0 0.5em; line-height: 1.35; font-weight: bold; }',
    'h1 { font-size: 1.6em; }',
    'h2 { font-size: 1.35em; }',
    'h3 { font-size: 1.18em; }',
    'p { margin: 0 0 0.85em; }',
    'ul, ol { margin: 0 0 0.85em; padding-left: 1.6em; }',
    'li p { margin: 0.2em 0; }',
    'blockquote { margin: 0.85em 0; padding-left: 1em; border-left: 2px solid currentColor; opacity: 0.9; }',
    'pre { margin: 0.85em 0; padding: 0.65em 0.85em; white-space: pre-wrap; overflow-wrap: anywhere; font-family: monospace; }',
    'code { font-family: monospace; }',
    'hr { margin: 1.4em 0; border: 0; border-top: 1px solid currentColor; opacity: 0.35; }',
    'img { max-width: 100%; height: auto; }',
    'table { width: 100%; border-collapse: collapse; margin: 0.85em 0; }',
    'th, td { border: 1px solid currentColor; padding: 0.3em 0.5em; text-align: left; vertical-align: top; }',
    '.cover-page { margin: 0; padding: 0; }',
    '.cover-wrap { margin: 0; text-align: center; }',
    '.cover-image { max-width: 100%; max-height: 98vh; height: auto; }',
    '.title-page { margin-top: 2em; }',
    '.book-title, .book-subtitle, .book-author { text-align: center; }',
    '.book-subtitle { font-size: 1.2em; margin-top: -0.3em; }',
    '.book-author { margin-top: 0.6em; font-weight: bold; }',
    '.book-synopsis-heading { margin-top: 1.8em; font-size: 1.1em; }',
    '.book-synopsis { white-space: pre-wrap; }',
    '.illustration { text-align: center; margin: 1em 0; }',
  ].join('\n')

  const navBody = [
    `<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc" id="toc">`,
    `  <h1>${escapeXml(tocLabel)}</h1>`,
    '  <ol>',
    ...chapterFiles.map((chapter) => `    <li><a href="${chapter.href}">${escapeXml(chapter.title)}</a></li>`),
    '  </ol>',
    '</nav>',
    '<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="landmarks" id="landmarks" hidden="">',
    '  <ol>',
    ...(coverAsset ? [`    <li><a epub:type="cover" href="cover.xhtml">${escapeXml(coverLabel)}</a></li>`] : []),
    ...(chapterFiles.length ? [`    <li><a epub:type="bodymatter" href="${chapterFiles[0].href}">${escapeXml(chapterFiles[0].title)}</a></li>`] : []),
    '  </ol>',
    '</nav>',
  ].join('\n')
  const navXhtml = wrapXhtmlDocument(tocLabel, language, 'styles.css', navBody)

  const ncxPoints = chapterFiles.map((chapter, index) => [
    `    <navPoint id="navPoint-${index + 1}" playOrder="${index + 1}">`,
    `      <navLabel><text>${escapeXml(chapter.title)}</text></navLabel>`,
    `      <content src="${chapter.href}"/>`,
    '    </navPoint>',
  ].join('\n'))
  const ncxXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">',
    '  <head>',
    `    <meta name="dtb:uid" content="${escapeXml(identifier)}"/>`,
    '    <meta name="dtb:depth" content="1"/>',
    '    <meta name="dtb:totalPageCount" content="0"/>',
    '    <meta name="dtb:maxPageNumber" content="0"/>',
    '  </head>',
    `  <docTitle><text>${escapeXml(title)}</text></docTitle>`,
    ...(author ? [`  <docAuthor><text>${escapeXml(author)}</text></docAuthor>`] : []),
    '  <navMap>',
    ...ncxPoints,
    '  </navMap>',
    '</ncx>',
  ].join('\n')

  const manifestItems = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '    <item id="styles" href="styles.css" media-type="text/css"/>',
    ...(coverAsset ? [
      `    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`,
      `    <item id="${coverAsset.id}" href="${coverAsset.href}" media-type="${coverAsset.mediaType}" properties="cover-image"/>`,
    ] : []),
    ...(titlepageXhtml ? ['    <item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>'] : []),
    ...chapterFiles.map((chapter) => `    <item id="${chapter.id}" href="${chapter.href}" media-type="application/xhtml+xml"/>`),
    ...images.map((image) => `    <item id="${image.id}" href="${image.href}" media-type="${image.mediaType}"/>`),
  ]
  const spineRefs = [
    ...(coverAsset ? ['    <itemref idref="cover"/>'] : []),
    ...(titlepageXhtml ? ['    <itemref idref="titlepage"/>'] : []),
    ...chapterFiles.map((chapter) => `    <itemref idref="${chapter.id}"/>`),
  ]
  const opfXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(language)}">`,
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `    <dc:identifier id="book-id">${escapeXml(identifier)}</dc:identifier>`,
    `    <dc:title>${escapeXml(title)}</dc:title>`,
    `    <dc:language>${escapeXml(language)}</dc:language>`,
    ...(author ? [`    <dc:creator>${escapeXml(author)}</dc:creator>`] : []),
    ...(description ? [`    <dc:description>${escapeXml(description)}</dc:description>`] : []),
    `    <meta property="dcterms:modified">${modified}</meta>`,
    ...(coverAsset ? ['    <meta name="cover" content="cover-image"/>'] : []),
    '  </metadata>',
    '  <manifest>',
    ...manifestItems,
    '  </manifest>',
    '  <spine toc="ncx">',
    ...spineRefs,
    '  </spine>',
    ...(coverAsset ? [
      '  <guide>',
      `    <reference type="cover" title="${escapeXml(coverLabel)}" href="cover.xhtml"/>`,
      '  </guide>',
    ] : []),
    '</package>',
  ].join('\n')

  const containerXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">',
    '  <rootfiles>',
    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>',
    '  </rootfiles>',
    '</container>',
  ].join('\n')

  const zip = new ZipWriter(new BlobWriter('application/epub+zip'), { useWebWorkers: false })
  await zip.add('mimetype', new TextReader('application/epub+zip'), {
    level: 0,
    dataDescriptor: false,
    extendedTimestamp: false,
  })
  await zip.add('META-INF/container.xml', new TextReader(containerXml))
  await zip.add('OEBPS/content.opf', new TextReader(opfXml))
  await zip.add('OEBPS/nav.xhtml', new TextReader(navXhtml))
  await zip.add('OEBPS/toc.ncx', new TextReader(ncxXml))
  await zip.add('OEBPS/styles.css', new TextReader(stylesCss))
  if (coverAsset && coverXhtml) {
    await zip.add('OEBPS/cover.xhtml', new TextReader(coverXhtml))
    await zip.add(`OEBPS/${coverAsset.href}`, new Uint8ArrayReader(coverAsset.bytes))
  }
  if (titlepageXhtml) {
    await zip.add('OEBPS/titlepage.xhtml', new TextReader(titlepageXhtml))
  }
  for (const chapter of chapterFiles) {
    await zip.add(`OEBPS/${chapter.href}`, new TextReader(chapter.xhtml))
  }
  for (const image of images) {
    await zip.add(`OEBPS/${image.href}`, new Uint8ArrayReader(image.bytes))
  }
  return zip.close()
}
