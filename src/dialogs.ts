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
  const cancel = button('取消', 'button button-quiet')
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
