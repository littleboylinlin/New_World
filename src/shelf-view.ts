import { showProjectExport } from './projects/view'
import { showWorkInformation, workMetadataFields } from './work-information-view'
import { locale, t } from './i18n'
import { bookImport } from './book-import-view'
import { formDialog, nameField } from './dialogs'
import { createNovel } from './documents/store'
import { coverOf, deleteBook, libraryChanges, listBooks, listShelf, maxTitleLength, renameBook, setArchived, setCover, storageError } from './library'
import type { Book, LibraryId } from './library'
import { bookPath, button, element, fileDetails, icon, libraries, link, notice } from './ui'
import { stagger } from './motion'
import { offerArchiveUndo, offerUndo } from './undo'
import { renderWritingStats } from './writing-stats'
import { openMenu } from './menu'
import { lastOpened, recentWorks } from './ideas'
import { writingFilter, writingSort } from './navigation-preferences'
import { chooseWorkType, workType } from './work-type'
import type { MenuItem } from './menu'

const changes = libraryChanges
const libraryIds: LibraryId[] = ['original', 'reference']

function typeBadge(library: LibraryId) {
  return element('span', 'work-type mode-' + library, workType(library))
}

function createWork(root: HTMLElement, id: LibraryId) {
  const metadata = workMetadataFields()
  formDialog(root, {
    title: t(id === 'original' ? 'shelf.newNovel' : 'work.newContinuation'),
    action: t('shelf.createNovel'), fields: [nameField(t('shelf.workTitle')), ...metadata.fields],
  }, async (data) => {
    void navigator.storage?.persist?.().catch(() => {})
    const { book, edition } = await createNovel(id, String(data.get('name')), metadata.read())
    changes.dispatchEvent(new Event('update'))
    location.hash = bookPath(id, book.id, id === 'original' ? edition.id : undefined)
  })
}

function createButton(root: HTMLElement, signal: AbortSignal) {
  const create = button(t('writing.create'), 'button button-primary', 'plus')
  create.onclick = async () => {
    const library = await chooseWorkType(t('writing.chooseType'), signal)
    if (library) createWork(root, library)
  }
  return create
}

export function renderHome(root: HTMLElement, signal: AbortSignal) {
  const home = element('section', 'home')
  renderWritingStats(home, signal)
  const recent = element('section', 'recent-projects')
  const heading = element('h2', '', t('writing.recent'))
  const content = element('div')
  recent.append(heading, content)
  home.append(recent)
  root.append(home)

  let request = 0
  async function refresh() {
    const turn = ++request
    try {
      const books = (await Promise.all(libraryIds.map(listBooks))).flat().filter((book) => !book.workId)
      if (signal.aborted || turn !== request) return
      const list = element('ul', 'recent-list')
      for (const ref of recentWorks().slice(0, 8)) {
        const book = books.find((item) => item.id === ref.bookId && item.library === ref.library)
        if (!book) continue
        const entry = link(bookPath(book.library, book.id), '', 'recent-link')
        entry.append(typeBadge(book.library), element('strong', '', book.title))
        if (ref.openedAt && Number.isFinite(new Date(ref.openedAt).getTime())) {
          const date = new Date(ref.openedAt)
          const time = element('time', '', t('writing.openedAt', [date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })]))
          time.dateTime = date.toISOString()
          entry.append(time)
        }
        const row = element('li')
        row.append(entry)
        list.append(row)
      }
      if (list.childElementCount) content.replaceChildren(list)
      else if (books.length) content.replaceChildren(element('p', 'intro-copy', t('writing.noRecent')), link('#/writing', t('navigation.writing'), 'button button-quiet'))
      else content.replaceChildren(element('p', 'intro-copy', t('writing.empty')), createButton(root, signal))
    } catch (error) {
      if (!signal.aborted && turn === request) content.replaceChildren(notice(storageError(error), true))
    }
  }
  changes.addEventListener('update', refresh, { signal })
  window.addEventListener('focus', refresh, { signal })
  window.addEventListener('storage', refresh, { signal })
  void refresh()
}

function manageBook(root: HTMLElement, book: Book, mode: 'rename' | 'delete') {
  const isRename = mode === 'rename'
  const dialog = element('dialog', 'manage-dialog')
  const form = element('form', 'manage-form')
  const title = element('h2', '', isRename ? t('shelf.renameWork') : t('shelf.deleteThisWork'))
  title.id = 'manage-title'
  dialog.setAttribute('aria-labelledby', title.id)
  form.append(title)
  const input = element('input', 'title-input')
  if (isRename) {
    const label = element('label', 'field-label', t('shelf.workTitle'))
    input.type = 'text'
    input.name = 'title'
    input.maxLength = maxTitleLength
    input.value = book.title
    label.append(input)
    form.append(label)
    if (book.format !== 'draft') form.append(element('p', 'dialog-help', t('shelf.originalFilename', [book.originalName])))
  } else {
    const message = element('p', 'dialog-help')
    message.append(t('shelf.move'), element('strong', '', book.title), book.library === 'reference' ? t('shelf.andAllContinuationsAndSourceFilesInThis') : t('shelf.andAllItsEditableVersionsAndLocalOriginal'))
    form.append(message,element('p','dialog-help',t('tasks.workDeleteHint')))
  }

  const error = element('p', 'field-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  const controls = element('div', 'dialog-controls')
  const cancel = button(t('common.cancel'), 'button button-quiet')
  const submit = button(isRename ? t('shelf.saveName') : t('shelf.confirmDeletion'), isRename ? 'button button-primary' : 'button button-danger')
  submit.type = 'submit'
  controls.append(cancel, submit)
  form.append(error, controls)
  dialog.append(form)
  root.append(dialog)
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  dialog.addEventListener('cancel', (event) => {
    if (submit.disabled) event.preventDefault()
  })
  cancel.addEventListener('click', () => dialog.close())
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (submit.disabled) return
    submit.disabled = true
    cancel.disabled = true
    error.hidden = true
    try {
      if (isRename) {
        await renameBook(book.library, book.id, input.value)
        changes.dispatchEvent(new Event('update'))
      } else {
        offerUndo(await deleteBook(book.library, book.id))
      }
      dialog.close()
    } catch (reason) {
      error.textContent = storageError(reason)
      error.hidden = false
      submit.disabled = false
      cancel.disabled = false
    }
  })
  dialog.showModal()
  if (isRename) {
    input.focus()
    input.select()
  } else {
    cancel.focus()
  }
}

// Covers stay the same for a book across visits because the variant comes from its id.
function coverVariant(id: string) {
  let sum = 0
  for (const char of id) sum = (sum * 31 + char.charCodeAt(0)) >>> 0
  return sum % 4
}

/** Lets the writer pick a cover image; the file is kept exactly as chosen. */
function chooseCover(root: HTMLElement, book: Book, report: (message: string) => void) {
  const input = element('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp'
  input.hidden = true
  input.addEventListener('change', async () => {
    const image = input.files?.[0]
    input.remove()
    if (!image) return
    try {
      await setCover(book.library, book.id, image)
    } catch (error) {
      report(storageError(error))
    }
  })
  input.addEventListener('cancel', () => input.remove())
  root.append(input)
  input.click()
}

function bookCard(root: HTMLElement, book: Book, covers: string[], report: (message: string) => void) {
  const row = element('li', 'book-card mode-' + book.library)
  const open = element('a', 'book-link')
  open.href = bookPath(book.library, book.id)
  open.setAttribute('aria-label', t('shelf.view', [book.title]))
  open.title = book.title
  const image = coverOf(book)
  const cover = element('span', image ? 'book-cover book-cover-image' : `book-cover cover-${coverVariant(book.id)}`)
  if (image) {
    const url = URL.createObjectURL(image)
    covers.push(url)
    const picture = element('img')
    picture.src = url
    picture.alt = ''
    picture.decoding = 'async'
    cover.append(picture)
  } else {
    const length = Array.from(book.title).length
    cover.append(element('strong', length > 14 ? 'book-title book-title-long' : length > 6 ? 'book-title book-title-medium' : 'book-title', book.title))
  }
  open.append(cover)

  const actions = (): MenuItem[] => [
    { label: t('shelf.openWork'), icon: 'book', action: () => { location.hash = bookPath(book.library, book.id) } },
    { label: t('project.export'), icon: 'download', action: () => showProjectExport({ library: book.library, id: book.id }, book.title) },
    { label: t('shelf.rename'), icon: 'edit', action: () => manageBook(root, book, 'rename') },
    { label: t('work.edit'), icon: 'edit', action: () => showWorkInformation(book) },
    { label: t('shelf.changeCover'), icon: 'image', action: () => chooseCover(root, book, report) },
    ...(image ? [{ label: t('shelf.defaultCover'), icon: 'undo' as const, action: () => {
      setCover(book.library, book.id, null).catch((error) => report(storageError(error)))
    } }] : []),
    { label: t('archive.archive'), icon: 'archive', action: async () => {
      try {
        await setArchived(book.library, book.id, true)
        offerArchiveUndo(book.title, () => setArchived(book.library, book.id, false), t('tasks.workArchiveHint'))
      } catch (error) {
        report(storageError(error))
      }
    } },
    { label: t('shelf.delete'), icon: 'trash', danger: true, action: () => manageBook(root, book, 'delete') },
  ]
  const menuLabel = t('shelf.actionsFor', [book.title])

  const meta = element('div', 'book-meta')
  const name = element('a', 'book-name', book.title)
  name.href = open.href
  name.tabIndex = -1
  name.title = book.title
  const more = button('', 'book-menu-toggle', 'chevron')
  more.setAttribute('aria-label', menuLabel)
  more.setAttribute('aria-haspopup', 'menu')
  more.setAttribute('aria-expanded', 'false')
  more.addEventListener('click', () => openMenu(actions(), more, menuLabel, more))
  meta.append(name, more)
  const details = book.library === 'reference'
    ? element('span', 'file-details', t('continuation.continuationProject')) : fileDetails(book)

  // A right click, or the context menu key on the cover, opens the same actions.
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    const point = event.button === -1 || (!event.clientX && !event.clientY)
      ? (() => { const box = more.getBoundingClientRect(); return { x: box.left, y: box.bottom } })()
      : { x: event.clientX, y: event.clientY }
    openMenu(actions(), point, menuLabel, more)
  })
  row.append(open, meta, typeBadge(book.library), details)
  return row
}

export function renderShelf(root: HTMLElement, signal: AbortSignal) {
  const panel = element('section', 'shelf-page')
  const header = element('div', 'page-heading')
  const actions = element('div', 'shelf-actions')
  const { choose, input, progress } = bookImport(() => chooseWorkType(t('writing.importType'), signal),
    t('writing.import'), () => changes.dispatchEvent(new Event('update')))
  choose.className = 'button button-quiet'
  const create = createButton(root, signal)
  actions.append(create, choose, input)
  header.append(element('h1', '', t('navigation.writing')), actions)
  const toolbar = element('div', 'writing-toolbar')
  const filters = element('div', 'segment-switch')
  filters.setAttribute('role', 'group')
  filters.setAttribute('aria-label', t('writing.filter'))
  for (const id of ['all', ...libraryIds] as const) {
    const toggle = button(id === 'all' ? t('writing.filterAll') : workType(id), 'segment')
    toggle.dataset.filter = id
    toggle.onclick = () => { writingFilter.set(id); paint() }
    filters.append(toggle)
  }
  const search = element('input', 'title-input')
  search.type = 'search'
  search.placeholder = t('writing.search')
  search.setAttribute('aria-label', search.placeholder)
  search.oninput = () => paint()
  const sort = element('select', 'editor-select')
  sort.setAttribute('aria-label', t('writing.sort'))
  for (const value of ['added', 'opened', 'title'] as const) {
    const option = element('option', '', t('writing.sort.' + value))
    option.value = value
    sort.append(option)
  }
  sort.value = writingSort.get()
  sort.onchange = () => { writingSort.set(sort.value as ReturnType<typeof writingSort.get>); paint() }
  toolbar.append(filters, search, sort)
  const listHeader = element('div', 'list-heading')
  const count = element('span', 'list-count')
  listHeader.append(element('h2', '', t('shelf.allWorks')), count)
  const content = element('div', 'shelf-content')
  content.append(notice(t('shelf.loadingLocalLibrary')))
  panel.append(header, toolbar, progress, listHeader, content)
  root.append(panel)

  let requestNumber = 0
  // Only the first render animates in. Later refreshes swap the list quietly.
  let arriving = true
  // Cover images are shown through object URLs, released when the list is redrawn or the page left.
  const covers: string[] = []
  const releaseCovers = () => { for (const url of covers.splice(0)) URL.revokeObjectURL(url) }
  signal.addEventListener('abort', releaseCovers)
  const report = (message: string) => { content.prepend(notice(message, true)) }
  let works: Book[] = []
  function paint() {
    const filter = writingFilter.get()
    for (const toggle of filters.querySelectorAll<HTMLElement>('[data-filter]')) {
      toggle.setAttribute('aria-pressed', String(toggle.dataset.filter === filter))
    }
    const query = search.value.trim().toLocaleLowerCase(locale)
    const books = works.filter((book) => (filter === 'all' || book.library === filter) && book.title.toLocaleLowerCase(locale).includes(query))
    const order = writingSort.get()
    const recent = recentWorks()
    const ranked = new Map(recent.map((work, index) => [work.library + work.bookId, index]))
    const opened = new Map(order === 'opened' ? books.map((book) => [book, lastOpened(book.library, book.id)]) : [])
    books.sort((a, b) => {
      if (order === 'title') return a.title.localeCompare(b.title, locale)
      if (order === 'opened') {
        const aRank = ranked.get(a.library + a.id) ?? recent.length
        const bRank = ranked.get(b.library + b.id) ?? recent.length
        const difference = aRank - bRank || opened.get(b)! - opened.get(a)!
        if (difference) return difference
      }
      return b.importedAt - a.importedAt || a.title.localeCompare(b.title, locale)
    })
    count.textContent = t('shelf.workS308', [books.length])
    releaseCovers()
    if (books.length) {
      const list = element('ul', 'book-list book-grid')
      list.setAttribute('aria-label', t('shelf.allWorks'))
      list.append(...books.map((book) => bookCard(root, book, covers, report)))
      content.replaceChildren(arriving ? stagger(list) : list)
    } else {
      const empty = element('div', 'empty-shelf')
      empty.append(icon('book'), element('h3', '', query ? t('writing.noMatch') : filter === 'all' ? t('writing.empty') : libraries[filter].empty))
      content.replaceChildren(empty)
    }
    arriving = false
  }
  async function refresh() {
    const current = ++requestNumber
    try {
      const books = await Promise.all(libraryIds.map(listShelf))
      if (signal.aborted || current !== requestNumber) return
      works = books.flat()
      paint()
    } catch (error) {
      if (!signal.aborted && current === requestNumber) {
        count.textContent = ''
        content.replaceChildren(notice(storageError(error), true))
      }
    }
  }
  try {
    if (sessionStorage.getItem('new-world:new-novel') === '1') {
      sessionStorage.removeItem('new-world:new-novel')
      create.click()
    }
  } catch { /* The writing page remains accessible. */ }
  changes.addEventListener('update', () => void refresh(), { signal })
  window.addEventListener('focus', () => void refresh(), { signal })
  void refresh()
}
