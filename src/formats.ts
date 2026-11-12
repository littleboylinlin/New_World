import { t } from './i18n'
export const formats = {
  txt: { label: 'TXT', preview: 'text' },
  pdf: { label: 'PDF', preview: 'pdf' },
  epub: { label: 'EPUB', preview: 'archive' },
  doc: { label: 'DOC', preview: null },
  docx: { label: 'DOCX', preview: 'archive' },
  md: { label: 'Markdown', preview: 'text' },
  rtf: { label: 'RTF', preview: 'rtf' },
  html: { label: 'HTML', preview: 'text' },
  odt: { label: 'ODT', preview: 'archive' },
  mobi: { label: 'MOBI', preview: null },
  azw3: { label: 'AZW3', preview: null },
} as const

export type Format = keyof typeof formats

export function canConvert(format: Format) {
  return formats[format].preview !== null
}

const extensions = {
  txt: 'txt', pdf: 'pdf', epub: 'epub', doc: 'doc', docx: 'docx',
  md: 'md', markdown: 'md', rtf: 'rtf', html: 'html', htm: 'html',
  odt: 'odt', mobi: 'mobi', azw3: 'azw3',
} as const satisfies Record<string, Format>

export const acceptedExtensions = Object.keys(extensions).map((extension) => `.${extension}`).join(',')
export const maxImportSize = 128 * 1024 * 1024

export function fileFormat(filename: string): Format | undefined {
  const extension = filename.match(/\.([^.]+)$/)?.[1].toLowerCase()
  if (extension && Object.hasOwn(extensions, extension)) {
    return extensions[extension as keyof typeof extensions]
  }
}

export const textEncodings = {
  'utf-8': 'UTF-8',
  gb18030: 'GB18030 / GBK',
  big5: 'Big5',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'windows-1252': 'Windows-1252',
} as const

export type TextEncoding = keyof typeof textEncodings

export function decodeText(bytes: Uint8Array, selected?: TextEncoding) {
  const bom: TextEncoding | undefined = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be'
    : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8'
    : undefined
  const preferred = selected ?? bom
  const candidates: TextEncoding[] = preferred ? [preferred] : ['utf-8', 'gb18030', 'big5']
  for (const encoding of candidates) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
      if (!text.includes('\0')) return { text, encoding }
    } catch {
      // Invalid byte sequences can be decoded with another encoding.
    }
  }
  throw new Error(t('formats.theFileCouldNotBeReadWithThis'))
}
