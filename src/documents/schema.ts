import { t } from '../i18n'
import { generateHTML, generateJSON, getSchema } from '@tiptap/core'
import { Image } from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { StarterKit } from '@tiptap/starter-kit'
import { imageInfo } from './markup'
import type { DocumentContent } from './model'

const LocalImage = Image.extend({
  parseHTML() {
    return [{ tag: 'img[src]', getAttrs: (node) => imageInfo(node.getAttribute('src')) ? null : false }]
  },
  renderHTML({ HTMLAttributes }) {
    const { src, alt } = HTMLAttributes
    return ['img', imageInfo(src) ? { src, alt: alt ?? '' } : { alt: alt || t('schema.imageUnavailable') }]
  },
}).configure({ allowBase64: true })

export const documentExtensions = [StarterKit.configure({ link: false }), LocalImage, TableKit.configure({ table: { resizable: false } })]

export function fromMarkup(markup: string) {
  return generateJSON(markup, documentExtensions) as DocumentContent
}

export function toMarkup(content: DocumentContent) {
  return generateHTML(content, documentExtensions)
}

const schema = getSchema(documentExtensions)

export function checkDocument(content: DocumentContent) {
  const node = schema.nodeFromJSON(content)
  node.check()
  if (node.type !== schema.topNodeType) throw new Error(t('schema.theManuscriptTextStructureIsInvalid'))
}
