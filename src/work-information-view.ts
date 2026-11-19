import { t } from './i18n'
import { formDialog, nameField } from './dialogs'
import { libraryChanges, readBook, saveWorkInformation, storageError } from './library'
import { showNotice } from './undo'
import type { Book } from './library'
import { button, element } from './ui'
import { metadataLimits, validateWorkMetadata, workStatuses } from './work-metadata'
import type { WorkMetadata } from './work-metadata'

/** Only edited known fields change; opaque fields and untouched CRLF text remain exact. */
export function workMetadataFields(metadata?: WorkMetadata) {
  if (metadata !== undefined) validateWorkMetadata(metadata)
  const initial = structuredClone(metadata ?? {})
  const fields: HTMLElement[] = []
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>()
  for (const key of ['subtitle', 'author', 'synopsis', 'tags', 'status'] as const) {
    const label = element('label', 'field-label', t('work.' + key))
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    if (key === 'status') {
      const select = element('select', 'title-input')
      const empty = element('option', '', t('work.unset')); empty.value = ''; select.append(empty)
      for (const status of workStatuses) { const option = element('option', '', t('work.status.' + status)); option.value = status; select.append(option) }
      if (metadata?.status && !workStatuses.includes(metadata.status as typeof workStatuses[number])) {
        const custom = element('option', '', metadata.status); custom.value = metadata.status; select.append(custom)
      }
      input = select
    } else if (key === 'synopsis' || key === 'tags') {
      const area = element('textarea', 'title-input')
      area.rows = key === 'synopsis' ? 5 : 2
      area.maxLength = key === 'synopsis' ? metadataLimits.text : metadataLimits.tags * (metadataLimits.tag + 1)
      input = area
    } else {
      const field = element('input', 'title-input'); field.type = 'text'; field.maxLength = metadataLimits.short; field.autocomplete = 'off'; input = field
    }
    input.name = 'work-' + key
    input.setAttribute('aria-label', t('work.' + key))
    input.value = key === 'tags' ? metadata?.tags?.join('\n') ?? '' : metadata?.[key] ?? ''
    label.append(input)
    if (key === 'tags') {
      const help = element('span', 'dialog-help', t('work.tagsHint'))
      help.id = 'work-tags-' + crypto.randomUUID()
      input.setAttribute('aria-describedby', help.id); label.append(help)
    }
    fields.push(label); inputs.set(key, input)
  }
  const values = new Map([...inputs].map(([key, input]) => [key, input.value]))
  const container = element('div', 'work-metadata-fields')
  container.append(...fields)
  return {
    fields: [container],
    read(): WorkMetadata | undefined {
      const next = structuredClone(initial)
      for (const [key, input] of inputs) {
        if (input.value === values.get(key)) continue
        if (input.value === '') delete next[key]
        else next[key] = key === 'tags' ? [...new Set(input.value.split(/\r\n|\r|\n/).map((tag) => tag.trim()).filter(Boolean))] : input.value
      }
      validateWorkMetadata(next)
      return Object.keys(next).length ? next : undefined
    },
  }
}

export function showWorkInformation(book: Book, changed?: (next: Book) => void) {
  const metadata = workMetadataFields(book.metadata)
  formDialog(document.body, {
    title: t('work.edit'), action: t('work.save'), description: t('work.optional'),
    fields: [nameField(t('shelf.workTitle'), book.title), ...metadata.fields],
  }, async (form) => {
    // Save first: an optional call skips its arguments when there is no listener, which used to skip the save.
    const next = await saveWorkInformation(book, String(form.get('name')), metadata.read())
    changed?.(next)
  })
}

export function workInformationButton(book: Book, changed?: (next: Book) => void) {
  const control = button(t('work.edit'), 'button button-quiet button-small', 'edit')
  control.addEventListener('click', async () => {
    // Read the latest metadata, so opening the form never discards extensions added elsewhere.
    try {
      const stored = await readBook(book.library, book.id)
      if (stored) showWorkInformation(stored.book, changed)
    } catch (error) { showNotice(storageError(error)) }
  })
  return control
}

export function workInformationPanel(book: Book, signal: AbortSignal, changed?: (next: Book) => void, observe = true) {
  const panel = element('section', 'work-information')
  panel.setAttribute('aria-label', t('work.info'))
  const render = (current: Book) => {
    const copy = element('div', 'work-information-copy')
    const meta = current.metadata
    if (meta !== undefined) validateWorkMetadata(meta)
    if (meta?.subtitle) copy.append(element('p', 'work-subtitle', meta.subtitle))
    const facts: string[] = []
    if (meta?.author) facts.push(t('work.author') + '：' + meta.author)
    // Unknown statuses stay visible as inert text and remain selectable in the edit form.
    if (meta?.status) facts.push(workStatuses.includes(meta.status as typeof workStatuses[number]) ? t('work.status.' + meta.status) : meta.status)
    if (facts.length) copy.append(element('p', 'file-details', facts.join(' · ')))
    if (meta?.tags?.length) copy.append(element('p', 'work-tags', meta.tags.join(' · ')))
    if (meta?.synopsis) copy.append(element('p', 'work-synopsis', meta.synopsis))
    panel.replaceChildren(copy, workInformationButton(current, render))
    changed?.(current)
  }
  render(book)
  let request = 0
  if (observe) libraryChanges.addEventListener('update', () => {
    const token = ++request
    void readBook(book.library, book.id).then((stored) => { if (stored && !signal.aborted && token === request) render(stored.book) }, () => {})
  }, { signal })
  return panel
}
