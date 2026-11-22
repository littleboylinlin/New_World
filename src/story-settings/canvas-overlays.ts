import { t } from '../i18n'
import { button, element } from '../ui'
import type { Rect, StoryCard, StoryTag } from './model'

export interface InlineEditor {
  form: HTMLFormElement
  field: HTMLInputElement | HTMLTextAreaElement
  place: (rect: Rect) => void
  close: () => void
}

interface InlineOptions {
  rect: Rect
  value: string
  label: string
  className: string
  multiline?: boolean
  fontSize?: number
  /** Return false to keep the editor open (e.g. while saving failed). */
  commit: (value: string) => void
  cancel: () => void
}

/**
 * A small text field placed over the canvas, where the text appears. Enter saves, Shift+Enter adds a
 * line in multi-line text, Escape cancels and clicking elsewhere saves.
 */
export function inlineEditor(surface: HTMLElement, options: InlineOptions): InlineEditor {
  const form = element('form', `story-canvas-control story-inline ${options.className}`)
  const field = options.multiline ? element('textarea') : element('input')
  field.className = 'story-inline-field'
  field.value = options.value
  field.setAttribute('aria-label', options.label)
  if (field instanceof HTMLInputElement) field.enterKeyHint = 'done'
  form.append(field)
  surface.append(form)
  let open = true
  function place(rect: Rect) {
    Object.assign(form.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    if (options.fontSize) field.style.fontSize = `${options.fontSize}px`
  }
  function close() {
    if (!open) return
    open = false
    form.remove()
  }
  function finish(save: boolean) {
    if (!open) return
    const value = field.value
    close()
    surface.focus({ preventScroll: true })
    if (save) options.commit(value)
    else options.cancel()
  }
  form.onsubmit = (event) => { event.preventDefault(); finish(true) }
  field.addEventListener('keydown', (event) => {
    const key = event as KeyboardEvent
    if (key.isComposing) return
    key.stopPropagation()
    if (key.key === 'Escape') { key.preventDefault(); finish(false) }
    else if (key.key === 'Enter' && !(options.multiline && key.shiftKey)) { key.preventDefault(); finish(true) }
  })
  field.addEventListener('blur', () => finish(true))
  for (const type of ['pointerdown', 'dblclick', 'wheel'] as const) form.addEventListener(type, (event) => event.stopPropagation())
  place(options.rect)
  field.focus({ preventScroll: true })
  field.select()
  return { form, field, place, close }
}

/** A short note at the bottom of the canvas, optionally with one action button. */
export function canvasToast(surface: HTMLElement) {
  const box = element('div', 'story-canvas-control story-toast')
  box.setAttribute('role', 'status')
  const text = element('span', 'story-toast-text')
  const action = button('', 'button button-small button-quiet story-toast-action')
  action.hidden = true
  box.append(text, action)
  surface.append(box)
  let timer = 0
  function show(message: string, options: { error?: boolean; action?: { label: string; run: () => void }; duration?: number } = {}) {
    clearTimeout(timer)
    text.textContent = message
    box.classList.toggle('story-toast-error', Boolean(options.error))
    box.dataset.visible = message ? 'true' : 'false'
    action.hidden = !options.action
    action.textContent = options.action?.label ?? ''
    action.onclick = options.action ? () => { hide(); options.action!.run() } : null
    if (message) timer = window.setTimeout(hide, options.duration ?? (options.action ? 6000 : 2400))
  }
  function hide() {
    clearTimeout(timer)
    text.textContent = ''
    action.hidden = true
    box.dataset.visible = 'false'
  }
  hide()
  return { element: box, show, hide, message: () => text.textContent ?? '' }
}


/** A card's details as shown beside it on hover and in the properties panel: tags, aliases, fields and body. */
export function cardDetails(card: StoryCard, tags: readonly StoryTag[], bodyLines = 6) {
  const box = element('div', 'story-card-details')
  const chips = element('div', 'story-detail-tags')
  for (const id of card.tagIds) {
    const tag = tags.find((item) => item.id === id)
    if (!tag) continue
    const chip = element('span', 'story-chip', tag.name)
    chip.style.setProperty('--tag-color', tag.color)
    chips.append(chip)
  }
  if (chips.childElementCount) box.append(chips)
  if (card.aliases.length) box.append(element('p', 'story-detail-alias', t('story.aliasLine', [card.aliases.join(t('story.nameSeparator'))])))
  const fields = card.fields.filter((field) => field.key || field.value).slice(0, 4)
  if (fields.length) {
    const list = element('dl', 'story-detail-fields')
    for (const field of fields) list.append(element('dt', '', field.key), element('dd', '', field.value))
    box.append(list)
  }
  if (card.body.trim()) {
    const body = element('p', 'story-detail-body', card.body.trim())
    body.style.setProperty('--lines', String(bodyLines))
    box.append(body)
  }
  return box.childElementCount ? box : undefined
}
