import { t } from './i18n'
import { storageError } from './library'
import type { TrashEntry } from './library'
import { restoreTrash } from './trash'
import { leave } from './motion'
import { button, element } from './ui'

export const trashKinds = { book: t('content.work'), original: t('content.source'), edition: t('content.edition'), chapter: t('content.chapters') } as const
type Restored = Awaited<ReturnType<typeof restoreTrash>>

let shown: HTMLElement | undefined
let timer: number | undefined

// A notice that gives way to a newer one goes at once. Otherwise it slides out.
function dismiss(replaced = false) {
  window.clearTimeout(timer)
  if (shown) {
    if (replaced) shown.remove()
    else leave(shown)
  }
  shown = undefined
}

function shortTitle(title: string) {
  const characters = Array.from(title)
  return characters.length > 24 ? `${characters.slice(0, 24).join('')}…` : title
}

// Offer one undo at a time. The item stays in the trash after the notice goes away.
export function offerUndo(entry: TrashEntry, restored?: (result: Restored) => void) {
  showUndo(t('undo.movedToTrash', [trashKinds[entry.kind], shortTitle(entry.title)]), async () => {
    const result = await restoreTrash(entry.id)
    restored?.(result)
  })
}

/** A short message in the same place, without an action. */
export function showNotice(text: string) {
  dismiss(true)
  const toast = element('div', 'undo-toast')
  toast.setAttribute('role', 'status')
  const close = button('', 'undo-close', 'close')
  close.setAttribute('aria-label', t('undo.dismissNotification'))
  toast.append(element('p', '', text), close)
  close.addEventListener('click', () => dismiss())
  document.body.append(toast)
  shown = toast
  timer = window.setTimeout(() => { if (shown === toast) dismiss() }, 6000)
}

/** Any other change that can be undone from the same notice. */
export function offerActionUndo(text: string, revert: () => Promise<unknown>) {
  showUndo(text, async () => { await revert() })
}

/** Archiving can be undone from the same notice as deleting. */
export function offerArchiveUndo(title: string, unarchive: () => Promise<unknown>) {
  showUndo(t('undo.archived', [shortTitle(title)]), async () => { await unarchive() })
}

function showUndo(text: string, revert: () => Promise<void>) {
  dismiss(true)
  const toast = element('div', 'undo-toast')
  toast.setAttribute('role', 'status')
  const message = element('p', '', text)
  const undo = button(t('editor.undo'), 'button button-small', 'undo')
  const close = button('', 'undo-close', 'close')
  close.setAttribute('aria-label', t('undo.dismissNotification'))
  toast.append(message, undo, close)
  close.addEventListener('click', () => dismiss())
  undo.addEventListener('click', async () => {
    undo.disabled = true
    window.clearTimeout(timer)
    try {
      await revert()
      if (shown === toast) dismiss()
    } catch (error) {
      message.textContent = storageError(error)
      undo.remove()
      timer = window.setTimeout(() => { if (shown === toast) dismiss() }, 8000)
    }
  })
  document.body.append(toast)
  shown = toast
  timer = window.setTimeout(() => { if (shown === toast) dismiss() }, 10_000)
}
