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
  dismiss(true)
  const toast = element('div', 'undo-toast')
  toast.setAttribute('role', 'status')
  const message = element('p', '', t('undo.movedToTrash', [trashKinds[entry.kind], shortTitle(entry.title)]))
  const undo = button(t('editor.undo'), 'button button-small', 'undo')
  const close = button('', 'undo-close', 'close')
  close.setAttribute('aria-label', t('undo.dismissNotification'))
  toast.append(message, undo, close)
  close.addEventListener('click', () => dismiss())
  undo.addEventListener('click', async () => {
    undo.disabled = true
    window.clearTimeout(timer)
    try {
      const result = await restoreTrash(entry.id)
      if (shown === toast) dismiss()
      restored?.(result)
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
