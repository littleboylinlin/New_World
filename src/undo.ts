import { storageError } from './library'
import type { TrashEntry } from './library'
import { restoreTrash } from './trash'
import { button, element } from './ui'

export const trashKinds = { book: '作品', original: '原文', edition: '编辑版本', chapter: '章节' } as const
type Restored = Awaited<ReturnType<typeof restoreTrash>>

let shown: HTMLElement | undefined
let timer: number | undefined

function dismiss() {
  window.clearTimeout(timer)
  shown?.remove()
  shown = undefined
}

function shortTitle(title: string) {
  const characters = Array.from(title)
  return characters.length > 24 ? `${characters.slice(0, 24).join('')}…` : title
}

// Offer one undo at a time. The item stays in the trash after the notice goes away.
export function offerUndo(entry: TrashEntry, restored?: (result: Restored) => void) {
  dismiss()
  const toast = element('div', 'undo-toast')
  toast.setAttribute('role', 'status')
  const message = element('p', '', `已将${trashKinds[entry.kind]}「${shortTitle(entry.title)}」移入回收站`)
  const undo = button('撤销', 'button button-small', 'undo')
  const close = button('', 'undo-close', 'close')
  close.setAttribute('aria-label', '关闭提示')
  toast.append(message, undo, close)
  close.addEventListener('click', dismiss)
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
