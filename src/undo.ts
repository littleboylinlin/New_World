import { t } from './i18n'
import { storageError } from './library'
import type { TrashEntry } from './library'
import { restoreTrash } from './trash'
import { leave } from './motion'
import { button, element } from './ui'

export const trashKinds = { book: t('content.work'), original: t('content.source'), edition: t('content.edition'), chapter: t('content.chapters'), idea: t('ideas.title'), storyCard: t('story.card') } as const
type Restored = Awaited<ReturnType<typeof restoreTrash>>

let shown: HTMLElement | undefined
let timer: number | undefined
let stopWatching: (() => void) | undefined

// A notice that gives way to a newer one goes at once. Otherwise it slides out.
function dismiss(replaced = false) {
  window.clearTimeout(timer)
  stopWatching?.()
  stopWatching = undefined
  // A notice still sliding out (taken away by a click) goes at once too, so only one is ever on screen.
  if (replaced) for (const old of document.querySelectorAll('.undo-toast.leaving')) old.remove()
  if (shown) {
    if (replaced) shown.remove()
    else leave(shown)
  }
  shown = undefined
}

/** Takes the notice away now, as a click anywhere would (a click inside a web page, for one). */
export function dismissNotice() {
  if (shown && !shown.querySelector('.undo-toast-action')) dismiss()
}

const modifierKeys = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn'])

/**
 * Notices never stand in the way. A plain one goes with the next click or key anywhere else, and
 * that click or key still does what it does. One with an undo stays its time, so the next click
 * does not take the chance to undo away, and waits while the pointer rests on it. Either way it
 * keeps clear of web pages, which are drawn by the system above everything else.
 */
function present(toast: HTMLElement, duration: number, keepUntilTimeout: boolean) {
  document.body.append(toast)
  shown = toast
  const watch = new AbortController()
  const { signal } = watch
  let remaining = duration
  let started = Date.now()
  const run = () => {
    started = Date.now()
    window.clearTimeout(timer)
    timer = window.setTimeout(() => { if (shown === toast) dismiss() }, remaining)
  }
  const pause = () => { window.clearTimeout(timer); remaining = Math.max(1500, remaining - (Date.now() - started)) }
  run()
  if (keepUntilTimeout) {
    toast.addEventListener('pointerenter', pause, { signal })
    toast.addEventListener('pointerleave', run, { signal })
    toast.addEventListener('focusin', pause, { signal })
    toast.addEventListener('focusout', (event) => { if (!toast.contains(event.relatedTarget as Node)) run() }, { signal })
  }
  // Armed after this turn, so the click or key that brought the notice up does not take it away.
  const arm = window.setTimeout(() => {
    if (keepUntilTimeout || signal.aborted) return
    const away = (event: Event) => { if (shown === toast && !toast.contains(event.target as Node)) dismiss() }
    document.addEventListener('pointerdown', away, { capture: true, passive: true, signal })
    document.addEventListener('keydown', (event) => { if (!modifierKeys.has(event.key)) away(event) }, { capture: true, signal })
  })
  const avoid = keepClearOfWebPages(toast)
  let frame = requestAnimationFrame(function follow() { avoid(); frame = requestAnimationFrame(follow) })
  stopWatching = () => { window.clearTimeout(arm); watch.abort(); cancelAnimationFrame(frame) }
}

/**
 * Moves a notice sideways off any web page in its row, or up to the top of the window when the row
 * has no room. Returns a step to run whenever the layout may have changed.
 */
function keepClearOfWebPages(toast: HTMLElement) {
  // From the stylesheet, not the box: the notice is still sliding in when this is first read.
  const gap = parseFloat(getComputedStyle(toast).bottom) || 58
  let placed = ''
  return () => {
    const pages = [...document.querySelectorAll<HTMLElement>('.web-stage')]
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
    const width = toast.offsetWidth
    const height = toast.offsetHeight
    const bottom = innerHeight - gap
    const top = bottom - height
    const blocked = pages.filter((rect) => rect.top < bottom && rect.bottom > top).map((rect) => [rect.left - 8, rect.right + 8])
    const free = (left: number) => left >= 16 && left + width <= innerWidth - 16 && blocked.every(([from, to]) => left + width <= from || left >= to)
    let next = 'bottom'
    const centred = (innerWidth - width) / 2
    if (blocked.length && !free(centred)) {
      // The free stretch nearest the middle that fits the notice, else the top of the window.
      const edges = [16, ...blocked.map(([, to]) => to)].map((left) => Math.max(16, left))
      const ends = [...blocked.map(([from]) => from - width), innerWidth - 16 - width]
      const options = [...edges, ...ends].filter(free).sort((a, b) => Math.abs(a - centred) - Math.abs(b - centred))
      next = options.length ? `left:${Math.round(options[0] + width / 2)}` : 'top'
    }
    if (next === placed) return
    placed = next
    toast.classList.toggle('undo-toast-top', next === 'top')
    if (next.startsWith('left:')) toast.style.left = `${next.slice(5)}px`
    else toast.style.removeProperty('left')
  }
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
  present(toast, 6000, false)
}

/** Any other change that can be undone from the same notice. */
export function offerActionUndo(text: string, revert: () => Promise<unknown>) {
  showUndo(text, async () => { await revert() })
}

/** Archiving can be undone from the same notice as deleting. */
export function offerArchiveUndo(title: string, unarchive: () => Promise<unknown>, detail = '') {
  showUndo(t('undo.archived', [shortTitle(title)])+(detail?' '+detail:''), async () => { await unarchive() })
}

function showUndo(text: string, revert: () => Promise<void>) {
  dismiss(true)
  const toast = element('div', 'undo-toast')
  toast.setAttribute('role', 'status')
  const message = element('p', '', text)
  const undo = button(t('editor.undo'), 'button button-small undo-toast-action', 'undo')
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
  present(toast, 10_000, true)
}
