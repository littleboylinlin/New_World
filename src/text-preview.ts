import { t } from './i18n'
import { decodeText } from './formats'
import type { TextEncoding } from './formats'

export const maxTextPreviewSize = 16 * 1024 * 1024

const hiddenTags = new Set(['HEAD', 'TITLE', 'STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH'])
const blockTags = new Set(['ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'P', 'PRE', 'SECTION', 'TR'])

export function htmlText(source: string): string {
  // A template has no active browsing context. Only its text is used in the reader.
  const template = document.createElement('template')
  template.innerHTML = source
  const parts: string[] = []
  function visit(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push((node.nodeValue ?? '').replace(/[\t\n\f\r ]+/g, ' '))
      return
    }
    if (!(node instanceof Element)) return
    const tag = node.localName.toUpperCase()
    if (hiddenTags.has(tag) || node.hasAttribute('hidden')) return
    if (tag === 'BR') parts.push('\n')
    if (blockTags.has(tag)) parts.push('\n\n')
    if (tag === 'LI') parts.push('• ')
    node.childNodes.forEach(visit)
    if (tag === 'TD' || tag === 'TH') parts.push(' ')
    if (blockTags.has(tag)) parts.push('\n\n')
  }
  template.content.childNodes.forEach(visit)
  return parts.join('').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function requireText(text: string) {
  if (!text.trim()) throw new Error(t('textPreview.thisSectionHasNoTextAvailableToPreview'))
  return text
}

export async function openText(blob: Blob, isHtml: boolean, encoding?: TextEncoding) {
  if (blob.size > maxTextPreviewSize) throw new Error(t('archivePreview.theTextExceedsThe16MibPreviewLimit'))
  const result = decodeText(new Uint8Array(await blob.arrayBuffer()), encoding)
  return { ...result, text: requireText(isHtml ? htmlText(result.text) : result.text) }
}
