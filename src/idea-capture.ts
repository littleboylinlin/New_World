import { t } from './i18n'
import { addIdea, lastWork, maxIdeaLength } from './ideas'
import { listBooks, storageError } from './library'
import type { Book, LibraryId } from './library'
import { button, element, libraries } from './ui'

const libraryIds: LibraryId[] = ['original', 'reference']

/**
 * The quick note form: a text box, the work it belongs to, and a button. Enter keeps the idea,
 * Shift + Enter starts a new line and Escape leaves.
 */
export function captureForm(done?: () => void, cancel?: () => void) {
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
  const close = button(t('common.cancel'), 'button button-quiet')
  const save = button(t('ideas.save'), 'button button-primary', 'plus')
  save.type = 'submit'
  const controls = element('div', 'dialog-controls')
  if (cancel) controls.append(close)
  controls.append(save)
  form.append(text, workLabel, status, controls)

  // The list of works loads after the form opens; saving waits for it so a quick Enter keeps the work.
  let loading: Promise<void> = Promise.resolve()
  let request = 0
  let userChanged = false
  let loadError = ''
  work.addEventListener('change', () => { userChanged = true })

  function refresh(selected = lastWork()) {
    const turn = ++request
    userChanged = false
    loading = fillWorks(selected, turn)
    return loading
  }
  async function fillWorks(selected: ReturnType<typeof lastWork>, turn: number) {
    try {
      const loaded = await Promise.all(libraryIds.map(async (library) => [library, await listBooks(library)] as const))
      if (turn !== request) return
      loadError = ''
      if (status.classList.contains('field-error')) {
        status.textContent = ''
        status.classList.remove('field-error')
      }

      const byLibrary = new Map<LibraryId, Book[]>(loaded)
      let resolvedSelected = selected
      if (selected) {
        const books = byLibrary.get(selected.library) ?? []
        const match = books.find((book) => book.id === selected.bookId)
        if (match?.workId) {
          const parent = books.find((book) => book.id === match.workId)
          if (parent) resolvedSelected = { library: parent.library, bookId: parent.id }
        }
      }

      const options: (HTMLOptionElement | HTMLOptGroupElement)[] = []
      const none = element('option', '', t('ideas.noWork'))
      none.value = ''
      options.push(none)
      const wanted = resolvedSelected ? `${resolvedSelected.library}:${resolvedSelected.bookId}` : ''
      for (const library of libraryIds) {
        const books = (byLibrary.get(library) ?? []).filter((book) => !book.workId && (!book.archivedAt || `${library}:${book.id}` === wanted))
        if (!books.length) continue
        const group = element('optgroup')
        group.label = libraries[library].name
        for (const book of books) {
          const option = element('option', '', book.title)
          option.value = `${library}:${book.id}`
          group.append(option)
        }
        options.push(group)
      }
      const previous = work.value
      work.replaceChildren(...options)
      const preferred = userChanged ? previous : wanted
      work.value = [...work.options].some((option) => option.value === preferred) ? preferred : ''
    } catch (cause) {
      if (turn !== request) return
      loadError = storageError(cause)
      status.textContent = loadError
      status.classList.add('field-error')
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (save.disabled) return
    save.disabled = true
    status.classList.remove('field-error')
    try {
      while (true) {
        const active = loading
        await active
        if (active === loading) break
      }
      if (loadError) throw new Error(loadError)
      const [library, bookId] = work.value ? work.value.split(':') as [LibraryId, string] : []
      await addIdea(text.value, library && bookId ? { library, bookId } : undefined)
      text.value = ''
      status.textContent = t('ideas.saved')
      done?.()
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

const acceleratorKeys: Partial<Record<string, string>> = {
  ' ': 'Space', Enter: 'Return', '+': 'Plus',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
}

function shortcutKey(event: KeyboardEvent) {
  if (/^Numpad[0-9]$/.test(event.code)) return `num${event.code.at(-1)}`
  if (/^Digit[0-9]$/.test(event.code) || /^Key[A-Z]$/.test(event.code) && !/^[a-z]$/i.test(event.key)) return event.code.at(-1)!
  return acceleratorKeys[event.code] ?? acceleratorKeys[event.key] ?? event.key
}

/** The quick note section of the settings: the desktop shortcut, or how to use it on the web. */
export function mountCaptureSettings(section: HTMLElement) {
  const desktop = window.newWorldDesktop
  if (!desktop?.getCaptureState || !desktop.setCaptureShortcut) {
    section.append(element('p', 'dialog-help', t('ideas.webShortcut')))
    return
  }
  const label = element('p', 'field-label', t('ideas.shortcut'))
  label.id = 'capture-shortcut-label'
  const group = element('div', 'settings-actions')
  const record = button('', 'button button-quiet button-small')
  const value = element('span')
  value.id = 'capture-shortcut-value'
  record.setAttribute('aria-labelledby', `${label.id} ${value.id}`)
  record.title = t('ideas.shortcutRecord')
  record.append(value)
  const reset = button(t('ideas.shortcutReset'), 'button button-quiet button-small')
  const disable = button(t('ideas.shortcutDisable'), 'button button-quiet button-small')
  group.append(record, reset, disable)
  const status = element('p', 'settings-state')
  status.setAttribute('role', 'status')
  const error = element('p', 'field-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  section.append(label, group, status, error)
  let state: CaptureState | undefined
  let recording = false
  let saving = false
  let request = 0

  function paint() {
    value.textContent = recording ? t('ideas.shortcutRecording')
      : state ? state.label || t('ideas.shortcutOff') : t('ideas.shortcutRecord')
    record.setAttribute('aria-pressed', String(recording))
    record.disabled = !state
    reset.disabled = !state || saving || state.shortcut === state.defaultShortcut && state.registered
    disable.disabled = !state || saving || state.shortcut === 'off'
  }

  function showError(key?: string) {
    error.textContent = key ? t(key) : ''
    error.hidden = !key
  }

  async function choose(shortcut: string) {
    if (!state || saving) return
    request++
    saving = true
    recording = false
    status.textContent = ''
    showError()
    paint()
    try {
      const result = await desktop!.setCaptureShortcut!(shortcut)
      if (result.ok) {
        state = result.state
        status.textContent = t('editor.saved')
      } else showError(result.error === 'taken' ? 'ideas.shortcutTaken' : 'ideas.shortcutInvalid')
    } catch {
      showError('settings.settingsCouldNotBeSavedTryAgain')
    } finally {
      saving = false
      paint()
    }
  }

  record.addEventListener('click', () => {
    if (saving) return
    recording = !recording
    showError()
    status.textContent = ''
    paint()
  })
  record.addEventListener('blur', () => {
    if (!recording) return
    recording = false
    paint()
  })
  record.addEventListener('keydown', (event) => {
    if (!recording) return
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat || event.isComposing || ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(event.key)) return
    const modifiers = [
      event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift',
      event.metaKey && (desktop.platform === 'darwin' ? 'Command' : 'Super'),
    ].filter(Boolean)
    if (!modifiers.length && event.key === 'Escape') {
      recording = false
      showError()
      paint()
      return
    }
    const key = shortcutKey(event)
    if (!modifiers.length || modifiers.length === 1 && event.shiftKey && !/^F(?:[1-9]|1\d|2[0-4])$/.test(key)) {
      showError('ideas.shortcutNeedsModifier')
      return
    }
    void choose([...modifiers, key].join('+'))
  })
  reset.addEventListener('click', () => { if (state) void choose(state.defaultShortcut) })
  disable.addEventListener('click', () => void choose('off'))

  async function refresh() {
    if (saving) return
    const turn = ++request
    try {
      const current = await desktop!.getCaptureState!()
      if (turn !== request) return
      state = current
      showError(state.registered ? undefined : 'ideas.shortcutTaken')
      paint()
    } catch { /* The next visit can retry. */ }
  }
  paint()
  void refresh()
  return refresh
}
