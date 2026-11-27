import { t } from '../i18n'
import { formDialog } from '../dialogs'
import { storageError } from '../library'
import { bookPath, button, element, link, notice } from '../ui'
import { showNotice } from '../undo'
import type { RegisterLeave } from '../documents/editor-view'
import type { Edition } from '../documents/model'
import { foreshadowingForm } from './form'
import { chapterTargetKey, linksChapter } from './model'
import type { ChapterTarget, Foreshadowing, ForeshadowingLocation, ForeshadowingWork } from './model'
import { chapterPath, foreshadowingPath } from './route'
import { deleteForeshadowing, readForeshadowingBox, setForeshadowingResolved } from './store'
import './foreshadowing.css'

const label = (key: string) => t('foreshadowing.' + key)
const filters = ['all', 'unresolved', 'resolved'] as const

export function renderForeshadowing(
  root: HTMLElement, work: ForeshadowingWork, target: ChapterTarget | undefined, signal: AbortSignal, registerLeave: RegisterLeave,
) {
  const page = element('section', `reader-page mode-${work.library} foreshadowing-page`)
  const content = element('div', 'foreshadowing-content')
  const heading = element('header', 'page-heading')
  const headingCopy = element('div', 'page-heading-copy')
  const back = link(bookPath(work.library, work.bookId), label('backToWork'), 'foreshadowing-link')
  const title = element('h1', '', label('titleOfBox'))
  const subtitle = element('p', 'page-heading-desc')
  const add = button(label('add'), 'button button-primary button-small', 'plus')
  add.disabled = true
  headingCopy.append(back, title, subtitle)
  heading.append(headingCopy, add)
  page.append(heading, content)
  root.append(page)
  document.title = `${label('titleOfBox')} · New World`

  const load = element('div')
  load.append(notice(label('loading')))
  const tools = element('div', 'foreshadowing-tools')
  tools.hidden = true
  const scope = element('div', 'foreshadowing-scope')
  scope.hidden = !target
  const counts = element('p', 'dialog-help foreshadowing-counts')
  counts.setAttribute('role', 'status')
  const controls = element('div', 'foreshadowing-controls')
  const choices = element('div', 'foreshadowing-filters')
  choices.setAttribute('role', 'group')
  choices.setAttribute('aria-label', label('filter'))
  let filter: (typeof filters)[number] = 'all'
  const filterButtons = new Map(filters.map((state) => {
    const control = button(label(state), 'button button-quiet button-small')
    control.addEventListener('click', () => {
      filter = state
      renderRows()
    })
    choices.append(control)
    return [state, control] as const
  }))
  const search = element('input', 'title-input')
  search.type = 'search'
  search.placeholder = label('search')
  search.setAttribute('aria-label', label('search'))
  search.addEventListener('input', renderRows)
  controls.append(choices, search)
  tools.append(scope, counts, controls)
  const editor = element('div', 'foreshadowing-editor')
  const list = element('ul', 'foreshadowing-list')
  list.setAttribute('aria-label', label('titleOfBox'))
  const empty = notice('')
  content.append(load, tools, editor, list, empty)
  empty.hidden = true

  let entries: Foreshadowing[] = []
  let editions: Edition[] = []
  const chapters = new Map<string, { title: string; edition: string }>()
  let form: ReturnType<typeof foreshadowingForm> | undefined
  let request = 0
  let changing = false
  const scopedChapter = () => target ? chapters.get(chapterTargetKey(target)) : undefined
  registerLeave(async () => !form || await form.flush())

  function paintScope() {
    if (!target) return
    const chapter = scopedChapter()
    back.href = chapter ? chapterPath(work, target) : bookPath(work.library, work.bookId)
    back.textContent = label(chapter ? 'backToChapter' : 'backToWork')
    const scopeTitle = chapter
      ? element('strong', '', t('foreshadowing.chapterScope', [chapter.title]))
      : element('p', 'dialog-help', label('missingChapter'))
    scope.replaceChildren(scopeTitle, link(foreshadowingPath(work), label('viewAll'), 'foreshadowing-link'))
  }

  function paintLocations(row: Foreshadowing, kind: 'setups' | 'payoffs') {
    const group = element('div', 'foreshadowing-location-group')
    group.append(element('h3', '', label(kind)))
    const list = element('ul')
    for (const { chapter, note } of row[kind]) {
      const item = element('li')
      if (chapter) {
        const live = chapters.get(chapterTargetKey(chapter))
        if (live) {
          const anchor = link(chapterPath(work, chapter), live.title, 'foreshadowing-link')
          item.append(anchor)
          if (editions.length > 1) item.append(element('span', 'foreshadowing-edition', live.edition))
        } else {
          item.append(element('span', 'foreshadowing-missing', t('foreshadowing.missingChapterNamed', [chapter.title])))
        }
      }
      if (note) item.append(element('p', 'foreshadowing-copy', note))
      list.append(item)
    }
    group.append(list)
    return group
  }

  function renderRows() {
    const scoped = target && scopedChapter() ? entries.filter((entry) => linksChapter(entry, target)) : entries
    const unresolved = scoped.filter((entry) => !entry.resolved).length
    const countText = t('foreshadowing.counts', [scoped.length, unresolved])
    if (counts.textContent !== countText) counts.textContent = countText
    for (const [state, control] of filterButtons) control.setAttribute('aria-pressed', String(filter === state))
    const query = search.value.trim().toLocaleLowerCase()
    const visible = scoped.filter((entry) =>
      (filter === 'all' || entry.resolved === (filter === 'resolved'))
      && (!query || entry.title.toLocaleLowerCase().includes(query) || entry.description.toLocaleLowerCase().includes(query)),
    )
    const focus = document.activeElement as HTMLElement | null
    const focusedId = focus?.closest<HTMLElement>('[data-foreshadowing-id]')?.dataset.foreshadowingId
    const focusedAction = focus?.dataset.action
    const rows = new Map<string, HTMLElement>()
    for (const entry of visible) {
      const row = element('li', 'reader-panel foreshadowing-entry')
      row.dataset.foreshadowingId = entry.id
      const top = element('div', 'foreshadowing-entry-head')
      top.append(element('h2', '', entry.title), element('span', 'file-format', label(entry.resolved ? 'resolved' : 'unresolved')))
      row.append(top)
      if (entry.description) row.append(element('p', 'foreshadowing-copy', entry.description))
      for (const kind of ['setups', 'payoffs'] as const) if (entry[kind].length) row.append(paintLocations(entry, kind))
      if (entry.notes) {
        const notes = element('div', 'foreshadowing-location-group')
        notes.append(element('h3', '', label('notes')), element('p', 'foreshadowing-copy', entry.notes))
        row.append(notes)
      }
      const actions = element('div', 'foreshadowing-actions')
      const toggle = button(label(entry.resolved ? 'markUnresolved' : 'markResolved'), 'button button-quiet button-small')
      const edit = button(t('main.edit'), 'button button-quiet button-small', 'edit')
      const remove = button(t('shelf.delete'), 'button button-quiet button-small', 'trash')
      toggle.dataset.action = 'toggle'
      edit.dataset.action = 'edit'
      remove.dataset.action = 'delete'
      toggle.disabled = edit.disabled = remove.disabled = Boolean(form)
      toggle.addEventListener('click', async () => {
        if (changing) return
        changing = true
        try {
          const next = await setForeshadowingResolved(entry, !entry.resolved)
          if (next && !signal.aborted) updateEntry(next)
        } catch (error) {
          if (!signal.aborted) { showNotice(storageError(error)); await refresh() }
        } finally { changing = false }
      })
      edit.addEventListener('click', () => openForm(entry))
      remove.addEventListener('click', () => formDialog(root, {
        title: label('deleteTitle'), action: t('shelf.delete'), danger: true,
        description: t('foreshadowing.deleteDescription', [entry.title]),
      }, async () => {
        await deleteForeshadowing(entry)
        if (signal.aborted) return
        request++
        entries = entries.filter((row) => row.id !== entry.id)
        renderRows()
      }))
      actions.append(toggle, edit, remove)
      row.append(actions)
      rows.set(entry.id, row)
    }
    list.replaceChildren(...rows.values())
    empty.hidden = Boolean(visible.length)
    empty.textContent = label(query || filter !== 'all' ? 'noMatches' : target && scopedChapter() ? 'noChapterEntries' : 'empty')
    if (focusedAction && focusedId) {
      const next = rows.get(focusedId)?.querySelector<HTMLButtonElement>(`[data-action="${focusedAction}"]`)
      if (next && !next.disabled) next.focus({ preventScroll: true })
      else if (!form) filterButtons.get(filter)?.focus({ preventScroll: true })
    }
  }

  function updateEntry(row: Foreshadowing) {
    request++
    entries = [row, ...entries.filter((item) => item.id !== row.id)]
    renderRows()
  }

  function openForm(row?: Foreshadowing) {
    if (form || changing) return
    const chapter = scopedChapter()
    form = foreshadowingForm(work, row, target && chapter ? { ...target, title: chapter.title } : undefined, editions, signal, updateEntry, (id) => {
      form = undefined
      add.disabled = false
      renderRows()
      const item = Array.from(list.children).find((row) => (row as HTMLElement).dataset.foreshadowingId === id)
      const control = item?.querySelector<HTMLButtonElement>('[data-action="edit"]') ?? add
      control.focus()
    })
    editor.append(form.element)
    add.disabled = true
    renderRows()
    form.focus()
  }
  add.addEventListener('click', () => openForm())

  async function refresh() {
    const token = ++request
    try {
      const next = await readForeshadowingBox(work)
      if (signal.aborted || token !== request) return
      const chaptersChanged = JSON.stringify(editions) !== JSON.stringify(next.editions)
      entries = next.entries
      editions = next.editions
      chapters.clear()
      for (const edition of editions) for (const chapter of edition.chapters) {
        chapters.set(chapterTargetKey({ editionId: edition.id, chapterId: chapter.id }), { title: chapter.title, edition: edition.name })
      }
      if (chaptersChanged) form?.updateChapters(editions)
      subtitle.textContent = next.book.title
      load.replaceChildren()
      add.disabled = Boolean(form)
      tools.hidden = false
      paintScope()
      renderRows()
    } catch (error) {
      if (signal.aborted || token !== request) return
      load.replaceChildren(notice(storageError(error), true))
    }
  }
  window.addEventListener('focus', () => { void refresh() }, { signal })
  void refresh()
}
