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

export function emptyChapter(title = '第一章'): ChapterInput {
  return { title, content: { type: 'doc', content: [{ type: 'paragraph' }] } }
}

export function chapterText(content: DocumentContent) {
  function text(node: JSONContent): string {
    if (node.type === 'image') return node.attrs?.alt ? `[图片：${node.attrs.alt}]` : '[图片]'
    if (node.type === 'hardBreak') return '\n'
    if (node.type === 'horizontalRule') return '\n——\n'
    const separator = node.type === 'tableRow' ? '\t' : /^(doc|blockquote|table|tableCell|tableHeader|listItem|bulletList|orderedList)$/.test(node.type ?? '') ? '\n' : ''
    return node.text ?? node.content?.map(text).join(separator) ?? ''
  }
  return text(content)
}

export function hasChapterHeading(chapter: ChapterInput) {
  const first = chapter.content.content?.[0]
  const heading = first?.content?.map((node) => node.text ?? '').join('').replace(/\s+/g, ' ').trim()
  return first?.type === 'heading' && heading === chapter.title
}
