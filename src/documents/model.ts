import { t } from '../i18n'
import type { JSONContent } from '@tiptap/core'
import type { LibraryId } from '../library'

export type DocumentContent = JSONContent & { type: 'doc' }

export interface ChapterInfo {
  id: string
  title: string
}

export interface ChapterInput {
  title: string
  content: DocumentContent
}

export interface EditionKey {
  library: LibraryId
  bookId: string
  id: string
}

export interface Edition extends EditionKey {
  name: string
  source: 'original' | 'blank' | 'copy'
  copiedFrom?: string
  originalId?: string
  notes: string[]
  chapters: ChapterInfo[]
  createdAt: number
  revision: number
}

export interface ChapterRecord {
  library: LibraryId
  bookId: string
  editionId: string
  id: string
  content: DocumentContent
  revision: number
}

export interface EditionBundle {
  edition: Edition
  chapters: ChapterInput[]
}

export const maxChapters = 2000
export const maxImageBytes = 4 * 1024 * 1024
export const maxEditionImageBytes = 24 * 1024 * 1024

export function emptyChapter(title = t('editor.firstChapter')): ChapterInput {
  return { title, content: { type: 'doc', content: [{ type: 'paragraph' }] } }
}

export function chapterText(content: DocumentContent, paragraphSeparator = '\n') {
  function text(node: JSONContent): string {
    if (node.type === 'image') return node.attrs?.alt ? t('docxExport.image', [node.attrs.alt]) : t('docxExport.image46')
    if (node.type === 'hardBreak') return '\n'
    if (node.type === 'horizontalRule') return '\n——\n'
    const separator = node.type === 'doc' ? paragraphSeparator
      : node.type === 'tableRow' ? '\t'
        : /^(blockquote|table|tableCell|tableHeader|listItem|bulletList|orderedList)$/.test(node.type ?? '') ? '\n' : ''
    return node.text ?? node.content?.map(text).join(separator) ?? ''
  }
  return text(content)
}

const ideographs = '\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}'
const fullWidth = '\\u3000-\\u303f\\uff01-\\uff60\\uffe0-\\uffee'
const letter = `(?:(?![${ideographs}])[\\p{L}\\p{N}\\p{M}])`
const sharedMarks = '“”‘’—…·'
// A word of letters or digits (joined by apostrophes, hyphens or dots), one Chinese or Japanese
// character or full-width mark, or a run of quotes and dashes that both languages use.
const tokens = new RegExp(`${letter}+(?:['’.\\-]${letter}+)*|[${ideographs}${fullWidth}]|[${sharedMarks}]+`, 'gu')
const eastAsian = new RegExp(`[${ideographs}${fullWidth}]`, 'u')
const shared = new RegExp(`^[${sharedMarks}]+$`, 'u')

/**
 * Counts like a word processor's Chinese word count: each Chinese character and Chinese
 * punctuation mark is one, and each English (or other spaced-language) word is one.
 * Quotes and dashes count as Chinese punctuation only next to Chinese text.
 */
export function countText(text: string) {
  let total = 0
  for (const match of text.matchAll(tokens)) {
    const token = match[0]
    if (!shared.test(token)) { total++; continue }
    const before = text.slice(0, match.index).slice(-2)
    const after = text.slice(match.index + token.length, match.index + token.length + 2)
    if (eastAsian.test(Array.from(before).at(-1) ?? '') || eastAsian.test(Array.from(after)[0] ?? '')) total += Array.from(token).length
  }
  return total
}

/** The text of a document with each block on its own line, so words never join across blocks. */
function plainText(node: JSONContent): string {
  if (node.text) return node.text
  if (node.type === 'hardBreak') return '\n'
  if (!node.content) return ''
  return node.content.map(plainText).join('') + '\n'
}

export function wordCount(content: JSONContent) {
  return countText(plainText(content))
}

export function hasChapterHeading(chapter: ChapterInput) {
  const first = chapter.content.content?.[0]
  const heading = first?.content?.map((node) => node.text ?? '').join('').replace(/\s+/g, ' ').trim()
  return first?.type === 'heading' && heading === chapter.title
}
