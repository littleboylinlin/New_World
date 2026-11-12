import { t } from './i18n'
import { BlobReader, ZipReader } from '@zip.js/zip.js'
import type { FileEntry } from '@zip.js/zip.js'
import { decodeText } from './formats'
import { htmlText, maxTextPreviewSize, requireText } from './text-preview'

const maxArchiveEntries = 10_000
const packageOrigin = 'https://book.invalid'

export async function openPackage(blob: Blob, signal: AbortSignal) {
  const zip = new ZipReader(new BlobReader(blob), { useWebWorkers: false })
  const entries = new Map<string, FileEntry>()
  try {
    let count = 0
    for await (const entry of zip.getEntriesGenerator()) {
      signal.throwIfAborted()
      if (++count > maxArchiveEntries) throw new Error(t('archivePreview.theArchiveContainsTooManyFiles'))
      if (!entry.directory) {
        if (entries.has(entry.filename)) throw new Error(t('archivePreview.theArchiveContainsDuplicateFileNamesAndCannot'))
        entries.set(entry.filename, entry)
      }
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof Error && error.message.startsWith(t('archivePreview.archive'))) throw error
    throw new Error(t('archivePreview.theDocumentArchiveCouldNotBeReadIt'))
  } finally {
    await zip.close()
  }

  async function binary(path: string, limit = maxTextPreviewSize) {
    signal.throwIfAborted()
    const entry = entries.get(path)
    if (!entry) throw new Error(t('archivePreview.theDocumentIsMissingFilesRequiredForPreview'))
    if (entry.encrypted) throw new Error(t('archivePreview.theDocumentContentIsEncrypted'))
    if (entry.uncompressedSize > limit) throw new Error(t('archivePreview.thisPartOfTheDocumentExceedsTheProcessing'))

    let size = 0
    const chunks: Uint8Array<ArrayBuffer>[] = []
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        size += chunk.length
        if (size > limit) throw new Error(t('archivePreview.theContentExceedsTheProcessingLimit'))
        chunks.push(chunk.slice())
      },
    })
    try {
      await entry.getData(output, { checkSignature: true, signal })
      return new Blob(chunks)
    } catch {
      signal.throwIfAborted()
      throw new Error(t('archivePreview.thisPartOfTheDocumentCouldNotBe'))
    }
  }
  return {
    entries,
    binary,
    async text(path: string) {
      return decodeText(new Uint8Array(await (await binary(path)).arrayBuffer())).text
    },
  }
}

export function xml(source: string) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error(t('archivePreview.theDocumentContainsAnXmlDeclarationThePreviewer'))
  const parsed = new DOMParser().parseFromString(source, 'application/xml')
  if (parsed.getElementsByTagName('parsererror').length) throw new Error(t('archivePreview.theDocumentStructureIsDamagedAndCannotBe'))
  return parsed
}

export function packagePath(base: string, href: string): string | undefined {
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|[/\\]{2})/i.test(href.trim())) return
  try {
    const baseUrl = `${packageOrigin}/${base.split('/').map(encodeURIComponent).join('/')}`
    const url = new URL(href, baseUrl)
    if (url.origin === packageOrigin && url.pathname !== '/') return decodeURIComponent(url.pathname.slice(1))
  } catch {
    // Invalid references have no corresponding local entry.
  }
}

export async function openEpub(blob: Blob, signal: AbortSignal) {
  const archive = await openPackage(blob, signal)
  const read = archive.text
  const container = xml(await read('META-INF/container.xml'))
  const root = container.getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path')
  const packageFile = root && packagePath('', root)
  if (!packageFile) throw new Error(t('archivePreview.theEpubIsMissingItsBookDirectory'))
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
  if (!pages.some(Boolean)) throw new Error(t('archivePreview.theEpubHasNoReadableContentDirectory'))

  const encrypted = new Set<string>()
  if (archive.entries.has('META-INF/encryption.xml')) {
    const descriptor = xml(await read('META-INF/encryption.xml'))
    for (const reference of descriptor.getElementsByTagNameNS('*', 'CipherReference')) {
      const path = packagePath('', reference.getAttribute('URI') ?? '')
      if (path) encrypted.add(path)
    }
  }
  async function readSource(index: number) {
    const path = pages[index]
    if (!path) throw new Error(t('archivePreview.thisSectionSContentTypeOrPathCannot'))
    if (encrypted.has(path)) throw new Error(t('archivePreview.thisSectionIsProtectedByDrmOrOther'))
    return { path, source: await read(path) }
  }
  return {
    length: pages.length,
    readSource,
    async readAsset(base: string, href: string, limit: number) {
      const path = packagePath(base, href)
      if (!path || encrypted.has(path) || !archive.entries.has(path)) return null
      return archive.binary(path, limit)
    },
    async readSection(index: number) {
      return requireText(htmlText((await readSource(index)).source))
    },
  }
}

export async function openDocx(blob: Blob, signal: AbortSignal) {
  const { text: read } = await openPackage(blob, signal)
  const relationships = xml(await read('_rels/.rels'))
  const main = Array.from(relationships.getElementsByTagNameNS('*', 'Relationship')).find((entry) => (
    entry.getAttribute('Type')?.endsWith('/officeDocument') && entry.getAttribute('TargetMode') !== 'External'
  ))
  const target = main?.getAttribute('Target')
  const path = target && packagePath('', target)
  if (!path) throw new Error(t('archivePreview.theDocxIsMissingItsDocumentEntryPoint'))
  const doc = xml(await read(path))
  const ns = doc.documentElement.namespaceURI
  const body = doc.getElementsByTagNameNS(ns, 'body')[0]
  if (ns !== 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
      && ns !== 'http://purl.oclc.org/ooxml/wordprocessingml/main') throw new Error(t('archivePreview.theFileDoesNotContainAWordDocument'))
  if (!body) throw new Error(t('archivePreview.theDocxIsMissingItsDocumentBody'))
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
  const { text: read } = await openPackage(blob, signal)
  const doc = xml(await read('content.xml'))
  const office = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'
  const text = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
  const body = doc.getElementsByTagNameNS(office, 'text')[0]
  if (!body) throw new Error(t('archivePreview.theOdtIsMissingItsDocumentBody'))

  let length = 0
  function readParagraph(paragraph: Element) {
    const walker = doc.createTreeWalker(paragraph, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
    const parts: string[] = []
    const append = (value: string) => {
      length += value.length
      if (length > maxTextPreviewSize) throw new Error(t('archivePreview.theTextExceedsThe16MibPreviewLimit'))
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
