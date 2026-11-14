import { locale, t } from './i18n'
import { captureForm } from './idea-capture'
import { deleteIdea, listIdeaRevisionCounts, listIdeaRevisions, listIdeas, restoreIdeaRevision, saveIdea, setIdeaUsed } from './ideas'
import type { Idea } from './ideas'
import { libraryChanges, listBooks, storageError } from './library'
import type { Book, IdeaRevision, LibraryId } from './library'
import { openMenu } from './menu'
import type { MenuItem } from './menu'
import { stagger } from './motion'
import { restoreTrash } from './trash'
import { bookPath, button, element, icon, libraries, link, notice } from './ui'
import { offerActionUndo, showNotice } from './undo'
import './documents/editor.css'

function when(time: number) {
  return new Date(time).toLocaleString(locale, { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatRevisionTime(time: number) {
  return new Date(time).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function ideaRevisionSourceLabel(rev: IdeaRevision): string {
  if (rev.source === 'user-restore') return t('revisions.sourceRestore')
  return rev.clientName ? t('revisions.sourceAi', [rev.clientName]) : t('revisions.sourceAiGeneric')
}

async function showIdeaRevisionsDialog(idea: Idea, books: Book[]) {
  const dialog = element('dialog', 'manage-dialog revision-dialog') as HTMLDialogElement
  const titleId = `idea-revision-dialog-title-${crypto.randomUUID()}`
  dialog.setAttribute('aria-labelledby', titleId)

  const head = element('div', 'modal-head')
  const heading = element('h2', '', t('revisions.ideaDialogTitle'))
  heading.id = titleId
  const closeIcon = button(t('common.close'), 'close')
  closeIcon.setAttribute('aria-label', t('common.close'))
  head.append(heading, closeIcon)

  const hint = element('p', 'dialog-help', t('revisions.ideaHint'))
  const errBox = element('p', 'notice notice-error')
  errBox.setAttribute('role', 'alert')
  errBox.hidden = true

  const body = element('div', 'revision-layout')
  const listCol = element('div', 'revision-list-col')
  const listHeading = element('h3', 'revision-section-title', t('revisions.listLabel'))
  const list = element('ul', 'revision-list')
  list.setAttribute('aria-label', t('revisions.listLabel'))
  listCol.append(listHeading, list)

  const previewCol = element('div', 'revision-preview-col')
  const previewHeading = element('h3', 'revision-section-title', t('revisions.previewLabel'))
  const previewMeta = element('p', 'revision-preview-meta')
  const previewPage = element('div', 'export-preview-page revision-preview-page')
  const previewText = element('pre', 'export-plain revision-preview-text')
  previewPage.append(previewText)
  previewCol.append(previewHeading, previewMeta, previewPage)

  body.append(listCol, previewCol)

  const controls = element('div', 'dialog-controls')
  const cancelBtn = button(t('common.close'), 'button button-quiet')
  const restoreBtn = button('', 'button button-primary', 'undo')
  const restoreLabel = element('span', '', t('revisions.restoreThis'))
  restoreBtn.append(restoreLabel)
  restoreBtn.disabled = true
  controls.append(cancelBtn, restoreBtn)

  dialog.append(head, hint, errBox, body, controls)
  document.body.append(dialog)

  const close = () => {
    if (dialog.open) dialog.close()
  }
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  closeIcon.addEventListener('click', close)
  cancelBtn.addEventListener('click', close)

  let revisions: IdeaRevision[] = []
  let selectedId: string | null = null
  let busy = false

  function describeMeta(rev: IdeaRevision): string {
    const book = rev.bookId ? books.find((item) => item.library === rev.library && item.id === rev.bookId) : undefined
    const place = book ? book.title : rev.bookId ? t('ideas.workGone') : t('ideas.unlinked')
    const used = rev.usedAt ? ` · ${t('ideas.used')}` : ''
    return `${formatRevisionTime(rev.createdAt)} · ${ideaRevisionSourceLabel(rev)} · ${place}${used}`
  }

  function selectRevision(rev: IdeaRevision) {
    selectedId = rev.id
    for (const btn of list.querySelectorAll('button.revision-item')) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-rev-id') === rev.id))
    }
    previewMeta.textContent = describeMeta(rev)
    previewText.textContent = rev.text
    restoreBtn.disabled = busy
  }

  function renderList() {
    list.replaceChildren()
    if (!revisions.length) {
      list.append(element('li', 'dialog-help revision-empty', t('revisions.ideaEmpty')))
      previewMeta.textContent = ''
      previewText.textContent = ''
      restoreBtn.disabled = true
      return
    }
    for (const rev of revisions) {
      const li = element('li')
      const itemBtn = button('', 'revision-item')
      itemBtn.setAttribute('data-rev-id', rev.id)
      itemBtn.setAttribute('aria-pressed', String(rev.id === selectedId))
      const topRow = element('span', 'revision-item-top')
      topRow.append(
        element('span', 'revision-item-time', formatRevisionTime(rev.createdAt)),
        element('span', 'settings-badge', ideaRevisionSourceLabel(rev)),
      )
      const snippet = Array.from(rev.text.replace(/\s+/g, ' ').trim()).slice(0, 32).join('')
      const subRow = element('span', 'revision-item-meta', snippet)
      itemBtn.append(topRow, subRow)
      itemBtn.addEventListener('click', () => selectRevision(rev))
      li.append(itemBtn)
      list.append(li)
    }
    const active = revisions.find((item) => item.id === selectedId) ?? revisions[0]
    if (active) selectRevision(active)
  }

  restoreBtn.addEventListener('click', () => {
    if (busy || !selectedId) return
    const targetId = selectedId
    busy = true
    errBox.hidden = true
    restoreBtn.disabled = true
    cancelBtn.disabled = true
    restoreLabel.textContent = t('revisions.restoring')
    void (async () => {
      try {
        await restoreIdeaRevision(idea.id, targetId)
        close()
        showNotice(t('revisions.ideaRestored'))
      } catch (cause) {
        errBox.textContent = storageError(cause)
        errBox.hidden = false
        busy = false
        restoreLabel.textContent = t('revisions.restoreThis')
        restoreBtn.disabled = !selectedId
        cancelBtn.disabled = false
      }
    })()
  })

  dialog.showModal()

  try {
    revisions = await listIdeaRevisions(idea.id)
    if (revisions.length) selectedId = revisions[0].id
    renderList()
  } catch (cause) {
    errBox.textContent = storageError(cause)
    errBox.hidden = false
  }
}

/** Moves an idea to another work, or to none, with a small dialog. */
function chooseWork(idea: Idea, books: Book[]) {
  const dialog = element('dialog', 'manage-dialog')
  const form = element('form', 'manage-form')
  const title = element('h2', '', t('ideas.linkTitle'))
  title.id = 'idea-link-title'
  dialog.setAttribute('aria-labelledby', title.id)
  const label = element('label', 'field-label', t('ideas.work'))
  const select = element('select', 'editor-select')
  const none = element('option', '', t('ideas.noWork'))
  none.value = ''
  select.append(none)
  for (const library of ['original', 'reference'] as LibraryId[]) {
    const group = element('optgroup')
    group.label = libraries[library].name
    for (const book of books.filter((item) => item.library === library && !item.workId)) {
      const option = element('option', '', book.title)
      option.value = `${library}:${book.id}`
      group.append(option)
    }
    if (group.children.length) select.append(group)
  }
  select.value = idea.bookId ? `${idea.library}:${idea.bookId}` : ''
  label.append(select)
  const controls = element('div', 'dialog-controls')
  const cancel = button(t('common.cancel'), 'button button-quiet')
  const save = button(t('ideas.linkSave'), 'button button-primary')
  save.type = 'submit'
  controls.append(cancel, save)
  form.append(title, label, controls)
  dialog.append(form)
  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  cancel.addEventListener('click', () => dialog.close())
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const { library: _library, bookId: _book, ...rest } = idea
    const [library, bookId] = select.value ? select.value.split(':') as [LibraryId, string] : []
    await saveIdea(library && bookId ? { ...rest, library, bookId } : rest)
    dialog.close()
  })
  dialog.showModal()
  select.focus()
}

export function ideaActions(idea: Idea, books: Book[], report: (message: string) => void, revisionCount = 0): MenuItem[] {
  const run = (work: () => Promise<unknown>) => () => { work().catch((error) => report(storageError(error))) }
  const items: MenuItem[] = [
    idea.usedAt
      ? { label: t('ideas.markUnused'), icon: 'undo', action: run(() => setIdeaUsed(idea, false)) }
      : { label: t('ideas.markUsed'), icon: 'check', action: run(() => setIdeaUsed(idea, true)) },
    { label: t('ideas.link'), icon: 'book', action: () => chooseWork(idea, books) },
  ]
  if (revisionCount > 0) {
    items.push({ label: t('revisions.button'), icon: 'history', action: () => { void showIdeaRevisionsDialog(idea, books) } })
  }
  items.push(
    { label: t('ideas.copy'), icon: 'copy', action: run(() => navigator.clipboard.writeText(idea.text)) },
    { label: t('shelf.delete'), icon: 'trash', danger: true, action: run(async () => {
      const entry = await deleteIdea(idea.id)
      if (entry) offerActionUndo(t('ideas.deleted'), () => restoreTrash(entry.id))
    }) },
  )
  return items
}

function ideaRow(idea: Idea, books: Book[], report: (message: string) => void, revisionCount: number) {
  const row = element('li', idea.usedAt ? 'idea-row idea-used' : 'idea-row')
  const text = element('p', 'idea-text', idea.text)
  const meta = element('div', 'file-details idea-meta')
  meta.append(element('span', 'file-size', when(idea.createdAt)))
  const book = idea.bookId ? books.find((item) => item.library === idea.library && item.id === idea.bookId) : undefined
  if (book) meta.append(link(bookPath(book.library, book.id), book.title, 'idea-work'))
  else meta.append(element('span', 'file-format', idea.bookId ? t('ideas.workGone') : t('ideas.unlinked')))
  if (idea.usedAt) meta.append(element('span', 'settings-badge', t('ideas.used')))
  if (revisionCount > 0) {
    const badgeKey = revisionCount === 1 ? 'revisions.ideaBadgeOne' : 'revisions.ideaBadge'
    const historyChip = button(t(badgeKey, [revisionCount]), 'button button-quiet button-small idea-history-button', 'history')
    historyChip.addEventListener('click', () => { void showIdeaRevisionsDialog(idea, books) })
    meta.append(historyChip)
  }
  const label = t('ideas.actionsFor')
  const more = button('', 'book-menu-toggle', 'chevron')
  more.setAttribute('aria-label', label)
  more.setAttribute('aria-haspopup', 'menu')
  more.setAttribute('aria-expanded', 'false')
  more.addEventListener('click', () => openMenu(ideaActions(idea, books, report, revisionCount), more, label, more))
  row.addEventListener('contextmenu', (event) => {
    if ((event.target as Element).closest('a')) return
    event.preventDefault()
    openMenu(ideaActions(idea, books, report, revisionCount), { x: event.clientX, y: event.clientY }, label, more)
  })
  const body = element('div', 'idea-body')
  body.append(text, meta)
  row.append(body, more)
  return row
}

export function renderIdeas(root: HTMLElement, signal: AbortSignal) {
  const panel = element('section', 'trash-page ideas-page')
  const nav = element('nav', 'breadcrumbs')
  nav.setAttribute('aria-label', t('trash.currentLocation'))
  const current = element('span', '', t('ideas.title'))
  current.setAttribute('aria-current', 'page')
  nav.append(link('#/', t('navigation.home')), element('span', 'crumb-separator', '/'), current)
  const header = element('div', 'page-heading')
  const heading = element('div')
  heading.append(element('p', 'eyebrow', 'IDEAS'), element('h1', '', t('ideas.title')), element('p', 'intro-copy', t('ideas.intro')))
  header.append(heading)
  const capture = captureForm(() => {})
  capture.form.classList.add('ideas-capture')
  const message = element('div', 'version-message')
  const content = element('div')
  content.append(notice(t('ideas.loading')))
  panel.append(nav, header, capture.form, message, content)
  root.append(panel)
  void capture.refresh()

  const report = (text: string) => message.replaceChildren(notice(text, true))
  let request = 0
  let arriving = true
  async function refresh() {
    const turn = ++request
    try {
      const [ideas, original, reference, revCounts] = await Promise.all([
        listIdeas(),
        listBooks('original'),
        listBooks('reference'),
        listIdeaRevisionCounts(),
      ])
      if (signal.aborted || turn !== request) return
      const books = [...original, ...reference]
      if (ideas.length) {
        const list = element('ul', 'book-list idea-list')
        list.setAttribute('aria-label', t('ideas.list'))
        // Ideas not used yet come first; used ones stay below for reference.
        const ordered = [...ideas.filter((idea) => !idea.usedAt), ...ideas.filter((idea) => idea.usedAt)]
        list.append(...ordered.map((idea) => ideaRow(idea, books, report, revCounts.get(idea.id) ?? 0)))
        content.replaceChildren(arriving ? stagger(list) : list)
      } else {
        const empty = element('div', arriving ? 'empty-shelf arrive' : 'empty-shelf')
        const emptyIcon = element('div', 'empty-icon')
        emptyIcon.append(icon('idea'))
        empty.append(emptyIcon, element('h3', '', t('ideas.none')), element('p', '', t('ideas.noneHint')))
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
