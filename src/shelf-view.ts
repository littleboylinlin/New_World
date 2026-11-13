import { t } from './i18n'
import { bookImport } from './book-import-view'
import { formDialog, nameField } from './dialogs'
import { createNovel } from './documents/store'
import { deleteBook, libraryChanges, listShelf, maxTitleLength, renameBook, setArchived, storageError } from './library'
import type { Book, LibraryId } from './library'
import { bookPath, breadcrumbs, button, element, fileDetails, icon, libraries, notice } from './ui'
import { stagger } from './motion'
import { offerArchiveUndo, offerUndo } from './undo'

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

  home.append(intro, stagger(cards))
  root.append(home)

  async function refreshCounts() {
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

function bookCard(root: HTMLElement, book: Book) {
  const row = element('li', 'book-card')
  const open = element('a', 'book-link')
  open.href = bookPath(book.library, book.id)
  open.setAttribute('aria-label', t('shelf.view', [book.title]))
  open.title = book.title
  const cover = element('span', `book-cover cover-${coverVariant(book.id)}`)
  const length = Array.from(book.title).length
  cover.append(element('strong', length > 14 ? 'book-title book-title-long' : length > 6 ? 'book-title book-title-medium' : 'book-title', book.title))
  open.append(cover, book.library === 'reference'
    ? element('span', 'file-details', t('continuation.continuationProject')) : fileDetails(book))
  const controls = element('div', 'book-controls')
  const rename = button(t('shelf.rename'), 'button button-quiet button-small', 'edit')
  const archive = button(t('archive.archive'), 'button button-quiet button-small', 'archive')
  const remove = button(t('shelf.delete'), 'button button-quiet button-small remove-button', 'trash')
  rename.addEventListener('click', () => manageBook(root, book, 'rename'))
  archive.addEventListener('click', async () => {
    archive.disabled = true
    try {
      await setArchived(book.library, book.id, true)
      offerArchiveUndo(book.title, () => setArchived(book.library, book.id, false))
    } catch (error) {
      archive.disabled = false
      row.append(notice(storageError(error), true))
    }
  })
  remove.addEventListener('click', () => manageBook(root, book, 'delete'))
  controls.append(rename, archive, remove)
  row.append(open, controls)
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
  listHeader.append(listTitle, count)
  const content = element('div', 'shelf-content')
  content.append(notice(t('shelf.loadingLocalLibrary')))
  panel.append(breadcrumbs(id), header, progress, listHeader, content)
  root.append(panel)

  let requestNumber = 0
  // Only the first render animates in. Later refreshes swap the list quietly.
  let arriving = true
  async function refresh() {
    const current = ++requestNumber
    try {
      const books = await listShelf(id)
      if (signal.aborted || current !== requestNumber) return
      count.textContent = t('shelf.workS308', [books.length])
      if (books.length) {
        const list = element('ul', 'book-list book-grid')
        list.setAttribute('aria-label', t('shelf.allWorks'))
        list.append(...books.map((book) => bookCard(root, book)))
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
