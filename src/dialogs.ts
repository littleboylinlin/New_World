import { t } from './i18n'
import { maxTitleLength, storageError } from './library'
import { button, element } from './ui'

let sequence = 0

interface DialogOptions {
  title: string
  action: string
  description?: string
  danger?: boolean
  fields?: HTMLElement[]
}

export function formDialog(root: HTMLElement, options: DialogOptions, submit: (data: FormData) => Promise<void>) {
  const dialog = element('dialog', 'manage-dialog')
  const form = element('form', 'manage-form')
  const heading = element('h2', '', options.title)
  heading.id = `form-dialog-${++sequence}`
  dialog.setAttribute('aria-labelledby', heading.id)
  form.append(heading)
  if (options.description) form.append(element('p', 'dialog-help', options.description))
  form.append(...(options.fields ?? []))

  const error = element('p', 'field-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  const controls = element('div', 'dialog-controls')
  const cancel = button(t('common.cancel'), 'button button-quiet')
  const confirm = button(options.action, options.danger ? 'button button-danger' : 'button button-primary')
  confirm.type = 'submit'
  controls.append(cancel, confirm)
  form.append(error, controls)
  dialog.append(form)
  root.append(dialog)

  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  dialog.addEventListener('cancel', (event) => { if (confirm.disabled) event.preventDefault() })
  cancel.addEventListener('click', () => dialog.close())
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (confirm.disabled) return
    confirm.disabled = cancel.disabled = true
    error.hidden = true
    try {
      await submit(new FormData(form))
      dialog.close()
    } catch (cause) {
      error.textContent = storageError(cause)
      error.hidden = false
      confirm.disabled = cancel.disabled = false
    }
  })
  dialog.showModal()
  if (options.danger) cancel.focus()
}

export function nameField(label: string, value = '') {
  const field = element('label', 'field-label', label)
  const input = element('input', 'title-input')
  input.type = 'text'
  input.name = 'name'
  input.maxLength = maxTitleLength
  input.value = value
  input.required = true
  field.append(input)
  return field
}

/** A yes/no dialog. A checkbox, when given, starts at `checked` and reports the user's choice back through it. */
export function confirmDialog(title: string, lines: string[], action: string, danger = false, checkbox?: { label: string, checked: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = element('dialog', 'manage-dialog ai-access-dialog')
    const form = element('form', 'manage-form')
    form.method = 'dialog'
    const heading = element('h2', '', title)
    heading.id = `confirm-${crypto.randomUUID()}`
    dialog.setAttribute('aria-labelledby', heading.id)
    form.append(heading, ...lines.map((line, index) => element('p', index ? 'dialog-help ai-access-note' : 'dialog-help', line)))
    const box = element('input')
    if (checkbox) {
      const row = element('label', 'confirm-check')
      box.type = 'checkbox'
      box.checked = checkbox.checked
      row.append(box, element('span', '', checkbox.label))
      form.append(row)
    }
    const controls = element('div', 'dialog-controls')
    const cancel = button(t('common.cancel'), 'button button-quiet')
    const confirm = button(action, danger ? 'button button-danger' : 'button button-primary')
    controls.append(cancel, confirm)
    form.append(controls)
    dialog.append(form)
    document.body.append(dialog)
    let answer = false
    cancel.addEventListener('click', () => dialog.close())
    confirm.addEventListener('click', () => { answer = true; dialog.close() })
    dialog.addEventListener('close', () => {
      if (checkbox) checkbox.checked = box.checked
      dialog.remove()
      resolve(answer)
    }, { once: true })
    dialog.showModal()
    confirm.focus()
  })
}
