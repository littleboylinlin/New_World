import { BlobReader, ZipReader } from '@zip.js/zip.js'
import type { FileEntry } from '@zip.js/zip.js'
import { decodeText } from './formats'
import { htmlText, maxTextPreviewSize, requireText } from './text-preview'

const maxArchiveEntries = 10_000
const packageOrigin = 'https://book.invalid'

async function readArchive(blob: Blob, signal: AbortSignal) {
  const zip = new ZipReader(new BlobReader(blob), { useWebWorkers: false })
  const entries = new Map<string, FileEntry>()
  try {
    let count = 0
    for await (const entry of zip.getEntriesGenerator()) {
      signal.throwIfAborted()
      if (++count > maxArchiveEntries) throw new Error('压缩包内的文件过多。')
      if (!entry.directory) {
        if (entries.has(entry.filename)) throw new Error('压缩包含有重名文件，无法安全预览。')
        entries.set(entry.filename, entry)
      }
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof Error && error.message.startsWith('压缩包')) throw error
    throw new Error('无法读取文档的压缩包。文件可能损坏或与扩展名不符。')
  } finally {
    await zip.close()
  }

  return async (path: string) => {
    signal.throwIfAborted()
    const entry = entries.get(path)
    if (!entry) throw new Error('文档缺少预览所需的文件。')
    if (entry.encrypted) throw new Error('文档内容已加密。')
    if (entry.uncompressedSize > maxTextPreviewSize) throw new Error('此部分超过 16 MiB 的文本预览上限。')

    let size = 0
    const chunks: Uint8Array<ArrayBuffer>[] = []
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        size += chunk.length
        if (size > maxTextPreviewSize) throw new Error('内容超过预览上限。')
        chunks.push(chunk.slice())
      },
    })
    try {
      await entry.getData(output, { checkSignature: true, signal })
      return decodeText(new Uint8Array(await new Blob(chunks).arrayBuffer())).text
    } catch {
      signal.throwIfAborted()
      throw new Error('无法解包或解码文档的这一部分。')
    }
  }
}

function xml(source: string) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('文档使用了预览器无法处理的 XML 声明。')
  const parsed = new DOMParser().parseFromString(source, 'application/xml')
  if (parsed.getElementsByTagName('parsererror').length) throw new Error('文档结构损坏，无法预览。')
  return parsed
}

function packagePath(base: string, href: string): string | undefined {
  try {
    const baseUrl = `${packageOrigin}/${base.split('/').map(encodeURIComponent).join('/')}`
    const url = new URL(href, baseUrl)
    if (url.origin === packageOrigin && url.pathname !== '/') return decodeURIComponent(url.pathname.slice(1))
  } catch {
    // Invalid references have no corresponding local entry.
  }
}

export async function openEpub(blob: Blob, signal: AbortSignal) {
  const read = await readArchive(blob, signal)
  const container = xml(await read('META-INF/container.xml'))
  const root = container.getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path')
  const packageFile = root && packagePath('', root)
  if (!packageFile) throw new Error('EPUB 缺少书籍目录。')
  const book = xml(await read(packageFile))
  const manifest = new Map<string, Element>()
  for (const item of book.getElementsByTagNameNS('*', 'item')) {
    const id = item.getAttribute('id')
    if (id) manifest.set(id, item)
  }
  const spine = book.getElementsByTagNameNS('*', 'spine')[0]
  const pages = Array.from(spine?.getElementsByTagNameNS('*', 'itemref') ?? [], (item) => {
    const chapter = manifest.get(item.getAttribute('idref') ?? '')
    const href = chapter?.getAttribute('href')
    const type = chapter?.getAttribute('media-type')
    if (href && (type === 'application/xhtml+xml' || type === 'text/html')) return packagePath(packageFile, href)
  })
  if (!pages.some(Boolean)) throw new Error('EPUB 没有可预览的正文目录。')

  return {
    length: pages.length,
    async readSection(index: number) {
      const path = pages[index]
      if (!path) throw new Error('本节的内容类型或路径无法预览。')
      return requireText(htmlText(await read(path)))
    },
  }
}

export async function openDocx(blob: Blob, signal: AbortSignal) {
  const read = await readArchive(blob, signal)
  const relationships = xml(await read('_rels/.rels'))
  const main = Array.from(relationships.getElementsByTagNameNS('*', 'Relationship')).find((entry) => (
    entry.getAttribute('Type')?.endsWith('/officeDocument') && entry.getAttribute('TargetMode') !== 'External'
  ))
  const target = main?.getAttribute('Target')
  const path = target && packagePath('', target)
  if (!path) throw new Error('DOCX 缺少正文入口。')
  const doc = xml(await read(path))
  const ns = doc.documentElement.namespaceURI
  const body = doc.getElementsByTagNameNS(ns, 'body')[0]
  if (ns !== 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
      && ns !== 'http://purl.oclc.org/ooxml/wordprocessingml/main') throw new Error('文件不包含 Word 正文。')
  if (!body) throw new Error('DOCX 缺少正文。')
  const paragraphs = Array.from(body.getElementsByTagNameNS(ns, 'p'), (paragraph) => {
    const parts: string[] = []
    for (const item of paragraph.getElementsByTagNameNS(ns, '*')) {
      if (item.localName === 't') parts.push(item.textContent ?? '')
      if (item.localName === 'tab') parts.push('\t')
      if (item.localName === 'br' || item.localName === 'cr') parts.push('\n')
    }
    return parts.join('')
  })
  return requireText(paragraphs.join('\n\n'))
}

export async function openOdt(blob: Blob, signal: AbortSignal) {
  const read = await readArchive(blob, signal)
  const doc = xml(await read('content.xml'))
  const office = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'
  const text = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
  const body = doc.getElementsByTagNameNS(office, 'text')[0]
  if (!body) throw new Error('ODT 缺少正文。')

  let length = 0
  function readParagraph(paragraph: Element) {
    const walker = doc.createTreeWalker(paragraph, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
    const parts: string[] = []
    const append = (value: string) => {
      length += value.length
      if (length > maxTextPreviewSize) throw new Error('正文超过 16 MiB 的文本预览上限。')
      parts.push(value)
    }
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) append(node.nodeValue ?? '')
      if (node instanceof Element && node.namespaceURI === text) {
        if (node.localName === 'line-break') append('\n')
        if (node.localName === 'tab') append('\t')
        if (node.localName === 's') {
          const count = Number.parseInt(node.getAttributeNS(text, 'c') ?? '1', 10)
          append(' '.repeat(Math.min(256, Math.max(1, count || 1))))
        }
      }
    }
    return parts.join('')
  }

  const paragraphs = Array.from(body.getElementsByTagNameNS(text, '*'))
    .filter((item) => item.localName === 'p' || item.localName === 'h')
  return requireText(paragraphs.map(readParagraph).join('\n\n'))
}
