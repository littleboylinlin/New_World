import { formDialog } from '../dialogs'
import { locale, t } from '../i18n'
import { storageError } from '../library'
import type { ChapterRevision } from '../library'
import { button, element } from '../ui'
import { showNotice } from '../undo'
import type { Edition } from './model'
import {
  defaultPruneKeepCount,
  getHistoryStorageStats,
  listChapterRevisions,
  pruneChapterRevisions,
  resolveRevisionPayload,
  restoreChapterRevision,
} from './revisions'

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

function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
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
  const statsRow = element('div', 'revision-storage-row')
  const statsText = element('span', 'revision-storage-summary')
  const pruneBtn = button(t('revisions.pruneOld'), 'button button-quiet button-small', 'trash')
  pruneBtn.hidden = true
  statsRow.append(statsText, pruneBtn)

  const capacityWarn = element('p', 'notice')
  capacityWarn.setAttribute('role', 'status')
  capacityWarn.hidden = true

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

  dialog.append(head, hint, statsRow, capacityWarn, errBox, body, controls)
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
  let previewTurn = 0
  const textCache = new Map<string, string>()

  async function refreshStats() {
    try {
      const stats = await getHistoryStorageStats(edition, chapterId)
      statsText.textContent = t('revisions.storageStats', [
        stats.chapterCount,
        stats.totalRevisions,
        formatStorageBytes(stats.totalStoredBytes),
      ])
      if (stats.warn) {
        capacityWarn.textContent = t('revisions.storageWarning', [stats.totalRevisions, formatStorageBytes(stats.totalStoredBytes)])
        capacityWarn.hidden = false
      } else {
        capacityWarn.hidden = true
      }
      pruneBtn.hidden = revisions.length <= 1
      pruneBtn.disabled = busy || revisions.length <= 1
    } catch {
      statsRow.hidden = true
    }
  }

  async function selectRevision(rev: ChapterRevision) {
    selectedId = rev.id
    for (const btn of list.querySelectorAll('button.revision-item')) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-rev-id') === rev.id))
    }
    previewMeta.textContent = `${formatRevisionTime(rev.createdAt)} · ${revisionSourceLabel(rev)} · ${t('revisions.words', [rev.words.toLocaleString()])} · ${rev.chapterTitle}`
    restoreBtn.disabled = busy
    const turn = ++previewTurn
    const cached = textCache.get(rev.id) ?? rev.plainText
    if (cached !== undefined) {
      textCache.set(rev.id, cached)
      previewText.textContent = cached.trim() || t('revisions.emptyChapterPreview')
      return
    }
    previewText.textContent = ''
    try {
      const resolved = await resolveRevisionPayload(rev)
      textCache.set(rev.id, resolved.plainText)
      if (turn === previewTurn && selectedId === rev.id) {
        previewText.textContent = resolved.plainText.trim() || t('revisions.emptyChapterPreview')
      }
    } catch (cause) {
      if (turn === previewTurn && selectedId === rev.id) {
        errBox.textContent = storageError(cause)
        errBox.hidden = false
      }
    }
  }

  async function renderList() {
    list.replaceChildren()
    if (!revisions.length) {
      list.append(element('li', 'dialog-help revision-empty', t('revisions.empty')))
      previewMeta.textContent = ''
      previewText.textContent = ''
      restoreBtn.disabled = true
      pruneBtn.hidden = true
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
      itemBtn.addEventListener('click', () => { void selectRevision(rev) })
      li.append(itemBtn)
      list.append(li)
    }
    const active = revisions.find((item) => item.id === selectedId) ?? revisions[0]
    if (active) await selectRevision(active)
  }

  async function reloadRevisions() {
    revisions = await listChapterRevisions(edition, chapterId)
    selectedId = revisions.find((item) => item.id === selectedId)?.id ?? revisions[0]?.id ?? null
    await Promise.all([renderList(), refreshStats()])
  }

  pruneBtn.addEventListener('click', () => {
    if (busy || revisions.length <= 1) return
    const keepCount = revisions.length > defaultPruneKeepCount ? defaultPruneKeepCount : 1
    const deleteCount = revisions.length - keepCount
    const keepLabel = keepCount === 1
      ? t('revisions.pruneKeepLabelOne')
      : t('revisions.pruneKeepLabelMany', [keepCount])
    const deleteLabel = deleteCount === 1
      ? t('revisions.pruneDeleteLabelOne')
      : t('revisions.pruneDeleteLabelMany', [deleteCount])
    formDialog(
      dialog,
      {
        title: t('revisions.pruneTitle'),
        action: t('revisions.pruneConfirm'),
        danger: true,
        description: t('revisions.pruneDescription', [keepLabel, deleteLabel]),
      },
      async () => {
        const result = await pruneChapterRevisions(edition, chapterId, keepCount)
        await reloadRevisions()
        const removedLabel = result.deleted === 1
          ? t('revisions.prunedRemovedOne')
          : t('revisions.prunedRemovedMany', [result.deleted])
        const keptLabel = result.remaining === 1
          ? t('revisions.prunedKeptOne')
          : t('revisions.prunedKeptMany', [result.remaining])
        showNotice(t('revisions.pruned', [removedLabel, keptLabel]))
      },
    )
  })

  restoreBtn.addEventListener('click', () => {
    if (busy || !selectedId) return
    const targetId = selectedId
    busy = true
    errBox.hidden = true
    restoreBtn.disabled = true
    cancelBtn.disabled = true
    pruneBtn.disabled = true
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
        pruneBtn.disabled = revisions.length <= 1
      }
    })()
  })

  dialog.showModal()

  try {
    await reloadRevisions()
  } catch (cause) {
    errBox.textContent = storageError(cause)
    errBox.hidden = false
  }
}
