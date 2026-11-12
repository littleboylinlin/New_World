import { locale, t } from './i18n'
import { formDialog } from './dialogs'
import { libraryChanges, storageError } from './library'
import { emptyTrash, listTrash, restoreTrash, trashDays } from './trash'
import type { TrashItem } from './trash'
import { button, element, icon, libraries, link, notice } from './ui'
import { stagger } from './motion'
import { trashKinds } from './undo'

const day = 24 * 60 * 60 * 1000

function trashRow(root: HTMLElement, { entry, place }: TrashItem, report: (message: string, error?: boolean) => void) {
  const row = element('li', 'book-row trash-row')
  const copy = element('div', 'book-copy')
  const details = element('div', 'file-details')
  const left = Math.max(1, Math.ceil((entry.deletedAt + trashDays * day - Date.now()) / day))
  const deleted = new Date(entry.deletedAt).toLocaleString(locale, { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  details.append(
    element('span', 'file-format', trashKinds[entry.kind]),
    element('span', 'filename', place ? `${libraries[entry.library].name} · ${place}` : libraries[entry.library].name),
    element('span', 'file-size', t('trash.deletedDaySRemaining', [deleted, left])),
  )
  copy.append(element('strong', 'book-title', entry.title), details)
  const controls = element('div', 'book-controls')
  const restore = button(t('trash.restore'), 'button button-primary button-small', 'undo')
  const remove = button(t('trash.deletePermanently'), 'button button-quiet button-small remove-button', 'trash')
  restore.addEventListener('click', async () => {
    restore.disabled = remove.disabled = true
    try {
      await restoreTrash(entry.id)
      report(t('trash.restored', [entry.title]))
    } catch (error) {
      report(storageError(error), true)
      restore.disabled = remove.disabled = false
    }
  })
  remove.addEventListener('click', () => formDialog(root, {
    title: t('trash.deletePermanently334'), action: t('trash.confirmPermanentDeletion'), danger: true, description: t('trash.willBePermanentlyDeletedAndCannotBeRestored', [entry.title]),
  }, async () => {
    await emptyTrash(entry.id)
    report(t('trash.permanentlyDeleted', [entry.title]))
  }))
  controls.append(restore, remove)
  row.append(copy, controls)
  return row
}

export function renderTrash(root: HTMLElement, signal: AbortSignal) {
  const panel = element('section', 'trash-page')
  const nav = element('nav', 'breadcrumbs')
  nav.setAttribute('aria-label', t('trash.currentLocation'))
  const current = element('span', '', t('trash.title'))
  current.setAttribute('aria-current', 'page')
  nav.append(link('#/', t('navigation.home')), element('span', 'crumb-separator', '/'), current)

  const header = element('div', 'page-heading')
  const heading = element('div')
  heading.append(element('p', 'eyebrow', 'TRASH'), element('h1', '', t('trash.title')),
    element('p', 'intro-copy', t('trash.deletedWorksSourcesEditableVersionsAndChaptersAre', [trashDays])))
  const clear = button(t('trash.emptyTrash'), 'button button-quiet remove-button', 'trash')
  header.append(heading, clear)
  const message = element('div', 'version-message')
  const content = element('div')
  content.append(notice(t('trash.loadingTrash')))
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
      const items = await listTrash()
      if (signal.aborted || turn !== request) return
      clear.disabled = !items.length
      if (items.length) {
        const list = element('ul', 'book-list')
        list.setAttribute('aria-label', t('trash.trashContents'))
        list.append(...items.map((item) => trashRow(root, item, report)))
        content.replaceChildren(arriving ? stagger(list) : list)
      } else {
        const empty = element('div', arriving ? 'empty-shelf arrive' : 'empty-shelf')
        const emptyIcon = element('div', 'empty-icon')
        emptyIcon.append(icon('trash'))
        empty.append(emptyIcon, element('h3', '', t('trash.theTrashIsEmpty')), element('p', '', t('trash.deletedContentWillAppearHereFirst')))
        content.replaceChildren(empty)
      }
    } catch (error) {
      if (!signal.aborted && turn === request) content.replaceChildren(notice(storageError(error), true))
    }
    if (!signal.aborted && turn === request) arriving = false
  }

  clear.addEventListener('click', () => formDialog(root, {
    title: t('trash.emptyTheTrash'), action: t('trash.confirmEmptyTrash'), danger: true, description: t('trash.everythingInTheTrashWillBePermanentlyDeleted'),
  }, async () => {
    await emptyTrash()
    report(t('trash.theTrashIsNowEmpty'))
  }))
  libraryChanges.addEventListener('update', () => { void refresh() }, { signal })
  window.addEventListener('focus', () => { void refresh() }, { signal })
  void refresh()
}
