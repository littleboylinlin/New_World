import { t } from '../i18n'
import { nameField } from '../dialogs'
import { storageError } from '../library'
import { button, element } from '../ui'
import type { Edition } from '../documents/model'
import { chapterTargetKey, maxForeshadowingText } from './model'
import type { Foreshadowing, ForeshadowingFields, ForeshadowingLocation, ForeshadowingWork } from './model'
import { saveForeshadowing } from './store'

const label = (key: string) => t('foreshadowing.' + key)

function area(labelText: string, value = '', rows = 3) {
  const field = element('label', 'field-label', labelText)
  const input = element('textarea', 'title-input')
  input.value = value
  input.rows = rows
  input.maxLength = maxForeshadowingText
  field.append(input)
  return { field, input }
}

function locationFields(kind: 'setups' | 'payoffs', locations: ForeshadowingLocation[], editions: Edition[], changed: () => void) {
  const field = element('fieldset', 'foreshadowing-locations')
  const title = label(kind)
  const rows = element('div', 'foreshadowing-location-rows')
  const add = button(label(kind === 'setups' ? 'addSetup' : 'addPayoff'), 'button button-small button-quiet', 'plus')
  const controls = new Map<HTMLElement, { read: () => ForeshadowingLocation | null; choices: () => void }>()
  field.append(element('legend', '', title), rows, add)

  function append(location: ForeshadowingLocation, focus = false) {
    let chosen = location.chapter
    const select = element('select', 'title-input')
    const chapterField = element('label', 'field-label', label('chapter'))
    chapterField.append(select)
    const note = area(label(kind === 'setups' ? 'setupNote' : 'payoffNote'), location.note, 2)
    const drop = button(label('removeLocation'), 'button button-small button-quiet')
    const row = element('div', 'foreshadowing-location-row')
    row.append(chapterField, note.field, drop)

    function choices() {
      const empty = element('option', '', label('noChapter'))
      empty.value = ''
      const groups = editions.map((edition) => {
        const group = element('optgroup')
        group.label = edition.name
        for (const chapter of edition.chapters) {
          const option = element('option', '', chapter.title)
          option.value = chapterTargetKey({ editionId: edition.id, chapterId: chapter.id })
          group.append(option)
        }
        return group
      })
      select.replaceChildren(empty, ...groups)
      if (!chosen) return
      const key = chapterTargetKey(chosen)
      select.value = key
      if (select.value === key) return
      const missing = element('option', '', t('foreshadowing.missingChapterNamed', [chosen.title]))
      missing.value = key
      select.append(missing)
      select.value = key
    }
    select.addEventListener('change', () => {
      const [editionId, chapterId] = select.value.split('/')
      const current = editions.find((edition) => edition.id === editionId)?.chapters.find((chapter) => chapter.id === chapterId)
      if (current) chosen = { editionId, chapterId, title: current.title }
      else if (!select.value) chosen = undefined
      changed()
    })
    const read = () => {
      if (chosen) {
        const { editionId, chapterId } = chosen
        const current = editions.find((edition) => edition.id === editionId)?.chapters.find((chapter) => chapter.id === chapterId)
        return { chapter: { ...chosen, title: current?.title ?? chosen.title }, note: note.input.value }
      }
      return note.input.value.trim() ? { note: note.input.value } : null
    }
    drop.addEventListener('click', () => {
      const hadValue = read()
      controls.delete(row)
      row.remove()
      add.focus()
      if (hadValue) changed()
    })
    controls.set(row, { read, choices })
    choices()
    rows.append(row)
    if (focus) (editions.length ? select : note.input).focus()
  }
  for (const location of locations) append(location)
  add.addEventListener('click', () => append({ note: '' }, true))
  return {
    element: field,
    read: () => [...controls.values()].flatMap(({ read }) => read() ?? []),
    update(next: Edition[]) {
      editions = next
      for (const { choices } of controls.values()) choices()
    },
  }
}

export function foreshadowingForm(
  work: ForeshadowingWork, initial: Foreshadowing | undefined, chapter: ForeshadowingLocation['chapter'], editions: Edition[],
  signal: AbortSignal, saved: (row: Foreshadowing) => void, closed: (id?: string) => void,
) {
  const form = element('form', 'reader-panel foreshadowing-form')
  form.noValidate = true
  const scope = new AbortController()
  signal.addEventListener('abort', () => scope.abort(), { once: true, signal: scope.signal })
  let current = initial
  let change = 0
  let committed = 0
  let composing = false
  let timer = 0
  let pending: Promise<boolean> | undefined
  const heading = element('h2', '', label(initial ? 'edit' : 'add'))
  const titleField = nameField(label('title'), initial?.title)
  const title = titleField.querySelector('input')!
  const description = area(label('description'), initial?.description)
  const setups = locationFields('setups', initial?.setups ?? (chapter ? [{ chapter, note: '' }] : []), editions, changed)
  const payoffs = locationFields('payoffs', initial?.payoffs ?? [], editions, changed)
  const notes = area(label('notes'), initial?.notes)
  const stateField = element('label', 'field-label', label('status'))
  const state = element('select', 'title-input')
  const unresolved = element('option', '', label('unresolved'))
  const resolved = element('option', '', label('resolved'))
  unresolved.value = 'unresolved'
  resolved.value = 'resolved'
  state.append(unresolved, resolved)
  state.value = initial?.resolved ? 'resolved' : 'unresolved'
  stateField.append(state)

  const status = element('p', 'dialog-help', label('autosave'))
  status.setAttribute('role', 'status')
  const error = element('p', 'field-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  const discard = button(label('discard'), 'button button-quiet')
  discard.hidden = true
  const done = button(label('done'), 'button button-primary')
  done.type = 'submit'
  const actions = element('div', 'dialog-controls')
  actions.append(discard, done)
  form.append(heading, titleField, description.field, setups.element, payoffs.element, stateField, notes.field, status, error, actions)

  function warn(message: string) {
    error.textContent = message
    error.hidden = false
    discard.hidden = change === committed
  }

  function beforeUnload(event: BeforeUnloadEvent) {
    if (change === committed && !composing) return
    event.preventDefault()
    event.returnValue = ''
  }

  function changed() {
    change++
    error.hidden = discard.hidden = true
    window.clearTimeout(timer)
    if (!title.value.trim()) {
      status.textContent = label('titleRequired')
      discard.hidden = false
    } else {
      status.textContent = t('editor.unsaved')
      if (!composing) timer = window.setTimeout(() => { void flush(false) }, 500)
    }
  }

  async function flush(explicit = true): Promise<boolean> {
    window.clearTimeout(timer)
    while (pending) if (!await pending) return false
    if (composing) {
      if (explicit) warn(t('editor.finishTheCurrentInputFirst'))
      return false
    }
    while (!scope.signal.aborted && change !== committed) {
      if (!title.value.trim()) {
        if (explicit) { warn(label('titleRequired')); title.focus() }
        return false
      }
      const fields: ForeshadowingFields = {
        title: title.value.trim(), description: description.input.value, notes: notes.input.value,
        setups: setups.read(), payoffs: payoffs.read(), resolved: state.value === 'resolved',
      }
      const turn = change
      status.textContent = label('saving')
      error.hidden = discard.hidden = true
      pending = saveForeshadowing(work, fields, current).then((row) => {
        current = row
        committed = turn
        if (!scope.signal.aborted) {
          if (committed === change) status.textContent = t('editor.saved')
          saved(row)
        }
        return true
      }, (cause) => {
        if (!scope.signal.aborted) {
          status.textContent = t('editor.unsavedFailed')
          warn(storageError(cause))
        }
        return false
      }).finally(() => { pending = undefined })
      if (!await pending) return false
      if (!explicit) return change === committed
      // A newer edit may have started another save while the first one was committing.
      while (pending) if (!await pending) return false
      if (composing) return false
    }
    return true
  }

  function close() {
    scope.abort()
    form.remove()
    closed(current?.id)
  }

  discard.addEventListener('click', () => { if (!pending) close() })
  form.addEventListener('input', (event) => { if (!(event.target instanceof HTMLSelectElement)) changed() })
  // Selects use change; text inputs use input, including the location notes.
  form.addEventListener('change', (event) => { if (event.target === state) changed() })
  form.addEventListener('compositionstart', () => { composing = true; window.clearTimeout(timer) })
  form.addEventListener('compositionend', () => { composing = false; changed() })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (done.disabled) return
    done.disabled = true
    if (await flush() && !scope.signal.aborted) close()
    else done.disabled = false
  })
  window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 's' || (!event.ctrlKey && !event.metaKey) || event.altKey || composing) return
    event.preventDefault()
    void flush()
  }, { signal: scope.signal })
  document.addEventListener('visibilitychange', () => { if (document.hidden) void flush(false) }, { signal: scope.signal })
  window.addEventListener('pagehide', () => { void flush(false) }, { signal: scope.signal })
  window.addEventListener('beforeunload', beforeUnload, { signal: scope.signal })
  scope.signal.addEventListener('abort', () => window.clearTimeout(timer), { once: true })
  return {
    element: form, focus: () => title.focus(), flush,
    updateChapters(next: Edition[]) { setups.update(next); payoffs.update(next) },
  }
}
