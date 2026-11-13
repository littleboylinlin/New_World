import { locale, t } from './i18n'
import { deleteBook, libraryChanges, listArchived, setArchived, storageError } from './library'
import type { Book } from './library'
import { bookPath, button, element, icon, libraries, link, notice } from './ui'
import { stagger } from './motion'
import { offerUndo } from './undo'

function archivedRow(book: Book, report: (message: string, error?: boolean) => void) {
  const row = element('li', 'book-row archive-row')
  const copy = element('div', 'book-copy')
  const details = element('div', 'file-details')
  const archived = new Date(book.archivedAt!).toLocaleString(locale, { year: 'numeric', month: 'long', day: 'numeric' })
  details.append(
    element('span', 'file-format', libraries[book.library].name),
    element('span', 'file-size', t('archive.archivedOn', [archived])),
  )
  const title = link(bookPath(book.library, book.id), book.title, 'book-title')
  copy.append(title, details)
  const controls = element('div', 'book-controls')
  const restore = button(t('archive.unarchive'), 'button button-primary button-small', 'unarchive')
  const remove = button(t('shelf.delete'), 'button button-quiet button-small remove-button', 'trash')
  restore.addEventListener('click', async () => {
    restore.disabled = remove.disabled = true
    try {
      await setArchived(book.library, book.id, false)
      report(t('archive.unarchived', [book.title, libraries[book.library].name]))
    } catch (error) {
      report(storageError(error), true)
      restore.disabled = remove.disabled = false
    }
  })
  remove.addEventListener('click', async () => {
    restore.disabled = remove.disabled = true
    try {
      offerUndo(await deleteBook(book.library, book.id))
    } catch (error) {
      report(storageError(error), true)
      restore.disabled = remove.disabled = false
    }
  })
  controls.append(restore, remove)
  row.append(copy, controls)
  return row
}

/** Works taken off the shelves. They keep everything and can still be opened, edited and exported. */
export function renderArchive(root: HTMLElement, signal: AbortSignal) {
  const panel = element('section', 'trash-page archive-page')
  const nav = element('nav', 'breadcrumbs')
  nav.setAttribute('aria-label', t('trash.currentLocation'))
  const current = element('span', '', t('archive.title'))
  current.setAttribute('aria-current', 'page')
  nav.append(link('#/', t('navigation.home')), element('span', 'crumb-separator', '/'), current)

  const header = element('div', 'page-heading')
  const heading = element('div')
  heading.append(element('p', 'eyebrow', 'ARCHIVE'), element('h1', '', t('archive.title')), element('p', 'intro-copy', t('archive.intro')))
  header.append(heading)
  const message = element('div', 'version-message')
  const content = element('div')
  content.append(notice(t('archive.loading')))
  panel.append(nav, header, message, content)
  root.append(panel)

  function report(text: string, error = false) {
    message.replaceChildren(notice(text, error))
  }

  let request = 0
  let arriving = true
  async function refresh() {
    const turn = ++request
    try {
      const books = await listArchived()
      if (signal.aborted || turn !== request) return
      if (books.length) {
        const list = element('ul', 'book-list')
        list.setAttribute('aria-label', t('archive.contents'))
        list.append(...books.map((book) => archivedRow(book, report)))
        content.replaceChildren(arriving ? stagger(list) : list)
      } else {
        const empty = element('div', arriving ? 'empty-shelf arrive' : 'empty-shelf')
        const emptyIcon = element('div', 'empty-icon')
        emptyIcon.append(icon('archive'))
        empty.append(emptyIcon, element('h3', '', t('archive.empty')))
        content.replaceChildren(empty)
      }
    } catch (error) {
      if (!signal.aborted && turn === request) content.replaceChildren(notice(storageError(error), true))
    }
    if (!signal.aborted && turn === request) arriving = false
  }

  libraryChanges.addEventListener('update', () => { void refresh() }, { signal })
  window.addEventListener('focus', () => { void refresh() }, { signal })
  void refresh()
}
