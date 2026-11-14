import { locale, t } from '../i18n'
import { storageError } from '../library'
import type { ChapterRevision } from '../library'
import { button, element } from '../ui'
import { showNotice } from '../undo'
import type { Edition } from './model'
import { listChapterRevisions, restoreChapterRevision } from './revisions'

export interface RevisionsDialogOptions {
  root: HTMLElement
  edition: Edition
  chapterId: string
  chapterTitle: string
  onBeforeRestore: () => Promise<boolean>
  onRestored: () => Promise<void>
}

function formatRevisionTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function revisionSourceLabel(rev: ChapterRevision): string {
  if (rev.source === 'user-restore') return t('revisions.sourceRestore')
  return rev.clientName ? t('revisions.sourceAi', [rev.clientName]) : t('revisions.sourceAiGeneric')
}

export async function showRevisionsDialog(options: RevisionsDialogOptions): Promise<void> {
  const { edition, chapterId, chapterTitle, onBeforeRestore, onRestored } = options
  const dialog = element('dialog', 'manage-dialog revision-dialog') as HTMLDialogElement
  const titleId = `revision-dialog-title-${crypto.randomUUID()}`
  dialog.setAttribute('aria-labelledby', titleId)

  const head = element('div', 'modal-head')
  const heading = element('h2', '', t('revisions.dialogTitle', [chapterTitle]))
  heading.id = titleId
  const closeIcon = button(t('common.close'), 'close')
  closeIcon.setAttribute('aria-label', t('common.close'))
  head.append(heading, closeIcon)

  const hint = element('p', 'dialog-help', t('revisions.hint'))
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

  let revisions: ChapterRevision[] = []
  let selectedId: string | null = null
  let busy = false

  function selectRevision(rev: ChapterRevision) {
    selectedId = rev.id
    for (const btn of list.querySelectorAll('button.revision-item')) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-rev-id') === rev.id))
    }
    previewMeta.textContent = `${formatRevisionTime(rev.createdAt)} · ${revisionSourceLabel(rev)} · ${t('revisions.words', [rev.words.toLocaleString()])} · ${rev.chapterTitle}`
    previewText.textContent = rev.plainText.trim() || t('revisions.emptyChapterPreview')
    restoreBtn.disabled = busy
  }

  function renderList() {
    list.replaceChildren()
    if (!revisions.length) {
      list.append(element('li', 'dialog-help revision-empty', t('revisions.empty')))
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
        element('span', 'settings-badge', revisionSourceLabel(rev)),
      )
      const subRow = element('span', 'revision-item-meta', `${t('revisions.words', [rev.words.toLocaleString()])} · ${rev.chapterTitle}`)
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
        const flushed = await onBeforeRestore()
        if (!flushed) {
          throw new Error(t('editor.resolveUnsavedChangesFirst'))
        }
        await restoreChapterRevision(edition, chapterId, targetId)
        await onRestored()
        close()
        showNotice(t('revisions.restored'))
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
    revisions = await listChapterRevisions(edition, chapterId)
    if (revisions.length) selectedId = revisions[0].id
    renderList()
  } catch (cause) {
    errBox.textContent = storageError(cause)
    errBox.hidden = false
  }
}
