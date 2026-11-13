import { t } from './i18n'
import { addIdea, lastWork, maxIdeaLength } from './ideas'
import { listShelf, storageError } from './library'
import type { LibraryId } from './library'
import { button, element, libraries } from './ui'

const libraryIds: LibraryId[] = ['original', 'reference']

/**
 * The quick note form: a text box, the work it belongs to, and a button. Enter keeps the idea,
 * Shift + Enter starts a new line and Escape leaves.
 */
export function captureForm(done: () => void, cancel?: () => void) {
  const form = element('form', 'capture-form')
  const text = element('textarea', 'title-input capture-text')
  text.name = 'idea'
  text.rows = 4
  text.maxLength = maxIdeaLength
  text.placeholder = t('ideas.placeholder')
  text.setAttribute('aria-label', t('ideas.text'))
  const workLabel = element('label', 'field-label capture-work')
  workLabel.append(element('span', '', t('ideas.work')))
  const work = element('select', 'editor-select')
  workLabel.append(work)
  const status = element('p', 'settings-state capture-state')
  status.setAttribute('role', 'status')
  const hint = element('p', 'dialog-help capture-hint', t('ideas.keys'))
  const close = button(t('common.cancel'), 'button button-quiet')
  const save = button(t('ideas.save'), 'button button-primary', 'plus')
  save.type = 'submit'
  const controls = element('div', 'dialog-controls')
  if (cancel) controls.append(close)
  controls.append(save)
  form.append(text, workLabel, hint, status, controls)

  async function refresh(selected = lastWork()) {
    const options: HTMLOptionElement[] = []
    const none = element('option', '', t('ideas.noWork'))
    none.value = ''
    options.push(none)
    for (const library of libraryIds) {
      let books: Awaited<ReturnType<typeof listShelf>> = []
      try { books = await listShelf(library) } catch { continue }
      if (!books.length) continue
      const group = element('optgroup')
      group.label = libraries[library].name
      for (const book of books) {
        const option = element('option', '', book.title)
        option.value = `${library}:${book.id}`
        group.append(option)
      }
      options.push(group as unknown as HTMLOptionElement)
    }
    work.replaceChildren(...options)
    const wanted = selected ? `${selected.library}:${selected.bookId}` : ''
    work.value = [...work.options].some((option) => option.value === wanted) ? wanted : ''
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (save.disabled) return
    save.disabled = true
    status.classList.remove('field-error')
    try {
      const [library, bookId] = work.value ? work.value.split(':') as [LibraryId, string] : []
      await addIdea(text.value, library && bookId ? { library, bookId } : undefined)
      text.value = ''
      status.textContent = t('ideas.saved')
      done()
    } catch (cause) {
      status.textContent = storageError(cause)
      status.classList.add('field-error')
    } finally {
      save.disabled = false
    }
  })
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      form.requestSubmit()
    }
  })
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && cancel) {
      event.preventDefault()
      cancel()
    }
  })
  close.addEventListener('click', () => cancel?.())

  return {
    form,
    refresh,
    focus() {
      status.textContent = ''
      text.focus()
    },
    setText(value: string) { text.value = value },
  }
}

/** The quick note as a dialog inside the page: the web version's shortcut and the editor's button. */
export function openCaptureDialog(work?: { library: LibraryId; bookId: string }, initial = '') {
  const dialog = element('dialog', 'manage-dialog capture-dialog')
  const title = element('h2', '', t('ideas.capture'))
  title.id = 'capture-dialog-title'
  dialog.setAttribute('aria-labelledby', title.id)
  const shell = element('div', 'manage-form')
  const capture = captureForm(() => dialog.close(), () => dialog.close())
  shell.append(title, capture.form)
  dialog.append(shell)
  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  // Escape is handled by the form, which also clears a half-typed idea only when it was kept.
  dialog.addEventListener('cancel', (event) => event.preventDefault())
  capture.setText(initial)
  void capture.refresh(work ?? lastWork())
  dialog.showModal()
  capture.focus()
}

/** The quick note section of the settings: the desktop shortcut, or how to use it on the web. */
export function mountCaptureSettings(section: HTMLElement) {
  const desktop = window.newWorldDesktop?.getCaptureState ? window.newWorldDesktop : undefined
  if (!desktop) {
    section.append(element('p', 'dialog-help', t('ideas.webShortcut')))
    return async () => {}
  }
  const group = element('div', 'settings-options')
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', t('ideas.shortcut'))
  const status = element('p', 'settings-state')
  status.setAttribute('role', 'status')
  const error = element('p', 'field-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  section.append(group, status, error, element('p', 'dialog-help', t('ideas.shortcutHint')))
  let inputs: HTMLInputElement[] = []

  function paint(state: CaptureState) {
    if (!inputs.length) {
      inputs = state.options.map((shortcut) => {
        const item = element('label', 'settings-option')
        const input = element('input')
        input.type = 'radio'
        input.name = 'capture-shortcut'
        input.value = shortcut
        input.addEventListener('change', () => void choose(shortcut))
        item.append(input, element('span', '', shortcut === 'off' ? t('backup.off') : state.labels[shortcut] ?? shortcut))
        group.append(item)
        return input
      })
    }
    for (const input of inputs) input.checked = input.value === state.shortcut
    error.hidden = state.registered
    error.textContent = state.registered ? '' : t('ideas.shortcutTaken')
  }
  async function choose(shortcut: string) {
    status.textContent = ''
    try {
      paint(await desktop!.setCaptureShortcut!(shortcut))
      status.textContent = t('editor.saved')
    } catch (cause) {
      error.textContent = storageError(cause)
      error.hidden = false
    }
  }
  async function refresh() {
    try { paint(await desktop!.getCaptureState!()) } catch { /* Shown again when the settings open. */ }
  }
  void refresh()
  return refresh
}
