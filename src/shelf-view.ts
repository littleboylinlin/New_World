import { t } from './i18n'
import { bookImport } from './book-import-view'
import { formDialog, nameField } from './dialogs'
import { createNovel } from './documents/store'
import { coverOf, deleteBook, libraryChanges, listArchived, listShelf, maxTitleLength, renameBook, setArchived, setCover, storageError } from './library'
import type { Book, LibraryId } from './library'
import { bookPath, breadcrumbs, button, element, fileDetails, icon, libraries, link, notice } from './ui'
import { stagger } from './motion'
import { offerArchiveUndo, offerUndo } from './undo'
import { renderWritingStats } from './writing-stats'
import { openMenu } from './menu'
import type { MenuItem } from './menu'

const changes = libraryChanges
const libraryIds: LibraryId[] = ['original', 'reference']

export function renderHome(root: HTMLElement, signal: AbortSignal) {
  const home = element('section', 'home')
  const intro = element('header', 'home-intro')
  intro.append(element('h1', '', t('shelf.myNovelLibrary')))

  const cards = element('div', 'shelf-grid')
  const counts = new Map<LibraryId, HTMLElement>()
  for (const id of libraryIds) {
    const library = libraries[id]
    const card = element('a', `shelf-card shelf-${id}`)
    card.href = bookPath(id)
    card.setAttribute('aria-label', t('shelf.open', [library.name]))
    const copy = element('div', 'card-copy')
    copy.append(element('h2', '', library.name))
    const bottom = element('div', 'card-bottom')
    const count = element('span', 'card-count', t('shelf.loading'))
    const enter = element('span', 'card-enter')
    enter.append(t('shelf.openLibrary'), icon('arrow'))
    counts.set(id, count)
    bottom.append(count, enter)
    card.append(element('span', 'card-index', library.index), copy, bottom)
    cards.append(card)
  }

  // Archived works sit outside both libraries, so their entry is on the home page.
  const archive = link('#/archive', '', 'archive-entry')
  archive.setAttribute('aria-label', t('archive.title'))
  const archiveCount = element('span', 'list-count archive-count')
  archive.append(icon('archive'), element('span', '', t('archive.title')), archiveCount)
  home.append(intro, stagger(cards), archive)
  renderWritingStats(home, signal)
  root.append(home)

  async function refreshCounts() {
    void listArchived().then((books) => {
      if (!signal.aborted) archiveCount.textContent = books.length ? String(books.length) : ''
    }, () => {})
    await Promise.all(libraryIds.map(async (id) => {
      const count = counts.get(id)!
      try {
        const books = await listShelf(id)
        if (!signal.aborted) count.textContent = t('shelf.workS', [books.length])
      } catch {
        if (!signal.aborted) count.textContent = t('shelf.libraryUnavailable')
      }
    }))
  }
  changes.addEventListener('update', () => void refreshCounts(), { signal })
  window.addEventListener('focus', () => void refreshCounts(), { signal })
  void refreshCounts()
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
    form.append(message)
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
  const row = element('li', 'book-card')
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
    { label: t('shelf.rename'), icon: 'edit', action: () => manageBook(root, book, 'rename') },
    { label: t('shelf.changeCover'), icon: 'image', action: () => chooseCover(root, book, report) },
    ...(image ? [{ label: t('shelf.defaultCover'), icon: 'undo' as const, action: () => {
      setCover(book.library, book.id, null).catch((error) => report(storageError(error)))
    } }] : []),
    { label: t('archive.archive'), icon: 'archive', action: async () => {
      try {
        await setArchived(book.library, book.id, true)
        offerArchiveUndo(book.title, () => setArchived(book.library, book.id, false))
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
  row.append(open, meta, details)
  return row
}

export function renderShelf(root: HTMLElement, id: LibraryId, signal: AbortSignal) {
  const library = libraries[id]
  const panel = element('section', `shelf-page mode-${id}`)
  const header = element('div', 'page-heading')
  const heading = element('div')
  heading.append(element('p', 'eyebrow', `${library.index} / ${library.label}`), element('h1', '', library.name))
  const { choose, input, progress } = bookImport(id, id === 'reference' ? t('shelf.importSourceToCreateAProject') : t('shelf.importFiles'), () => changes.dispatchEvent(new Event('update')))
  const create = button(t('shelf.newNovel'), 'button button-quiet', 'plus')
  const controls = element('div', 'shelf-actions')
  create.addEventListener('click', () => formDialog(root, { title: t('shelf.newNovel'), action: t('shelf.createNovel'), fields: [nameField(t('shelf.workTitle'))] }, async (data) => {
    void navigator.storage?.persist?.().catch(() => {})
    const { book, edition } = await createNovel(id, String(data.get('name')))
    changes.dispatchEvent(new Event('update'))
    location.hash = bookPath(id, book.id, edition.id)
  }))
  if (id === 'original') controls.append(create)
  controls.append(choose, input)
  header.append(heading, controls)

  const listHeader = element('div', 'list-heading')
  const listTitle = element('h2', '', id === 'reference' ? t('shelf.groupedBySourceWork') : t('shelf.allWorks'))
  const count = element('span', 'list-count')
  const archived = link('#/archive', t('archive.view'), 'archive-view-link')
  listHeader.append(listTitle, count, archived)
  const content = element('div', 'shelf-content')
  content.append(notice(t('shelf.loadingLocalLibrary')))
  panel.append(breadcrumbs(id), header, progress, listHeader, content)
  root.append(panel)

  let requestNumber = 0
  // Only the first render animates in. Later refreshes swap the list quietly.
  let arriving = true
  // Cover images are shown through object URLs, released when the list is redrawn or the page left.
  let covers: string[] = []
  const releaseCovers = () => { for (const url of covers.splice(0)) URL.revokeObjectURL(url) }
  signal.addEventListener('abort', releaseCovers)
  const report = (message: string) => { content.prepend(notice(message, true)) }
  async function refresh() {
    const current = ++requestNumber
    try {
      const books = await listShelf(id)
      if (signal.aborted || current !== requestNumber) return
      count.textContent = t('shelf.workS308', [books.length])
      if (books.length) {
        const list = element('ul', 'book-list book-grid')
        list.setAttribute('aria-label', t('shelf.allWorks'))
        const shown: string[] = []
        list.append(...books.map((book) => bookCard(root, book, shown, report)))
        releaseCovers()
        covers = shown
        content.replaceChildren(arriving ? stagger(list) : list)
      } else {
        const empty = element('div', arriving ? 'empty-shelf arrive' : 'empty-shelf')
        const emptyIcon = element('div', 'empty-icon')
        emptyIcon.append(icon('book'))
        empty.append(emptyIcon, element('h3', '', library.empty))
        if (id === 'original') empty.append(element('p', '', t('shelf.importNovelsInTxtPdfEpubDocxAnd')))
        content.replaceChildren(empty)
      }
    } catch (error) {
      if (!signal.aborted && current === requestNumber) {
        count.textContent = ''
        content.replaceChildren(notice(storageError(error), true))
      }
    }
    if (!signal.aborted && current === requestNumber) arriving = false
  }

  changes.addEventListener('update', () => void refresh(), { signal })
  window.addEventListener('focus', () => void refresh(), { signal })
  void refresh()
}
