import { motionMs } from '../motion'
import { element } from '../ui'
import type { Rect } from './split-tree'
import './shell.css'

/** Something that can be dropped: what it is is up to the page that receives it. */
export type DragPayload = unknown

/** The page area that accepts drops, such as the editor's split view. */
export interface DropHost {
  /** The place a drop at this point would take, or nothing when the point is not a valid place. */
  zoneAt(x: number, y: number, payload: DragPayload): { key: string; rect: Rect } | undefined
  drop(payload: DragPayload, key: string): void
}

let host: DropHost | undefined
let active: { cancel: () => void } | undefined

/** Registers the area that accepts drops while the page is shown. */
export function setDropHost(next: DropHost, signal: AbortSignal) {
  host = next
  signal.addEventListener('abort', () => { if (host === next) host = undefined; active?.cancel() }, { once: true })
}

export const isOpenDragging = () => Boolean(active)

/**
 * Drags an entry's name out under the pointer. Over a valid place a translucent fill spreads from
 * the pointer to the area the new pane would take; releasing there opens it, releasing anywhere
 * else scatters the name away and nothing happens. Escape cancels.
 */
export function startOpenDrag(options: { label: string; payload: DragPayload; x: number; y: number; pointerId: number; onEnd?: (dropped: boolean) => void }) {
  active?.cancel()
  const ghost = element('div', 'open-ghost', options.label)
  ghost.setAttribute('aria-hidden', 'true')
  const preview = element('div', 'drop-preview')
  preview.setAttribute('aria-hidden', 'true')
  preview.hidden = true
  document.body.append(preview, ghost)
  document.documentElement.dataset.openDragging = ''
  const lifetime = new AbortController()
  const { signal } = lifetime
  let current: { key: string; rect: Rect } | undefined
  let x = options.x
  let y = options.y
  let spread: Animation | undefined

  function follow() {
    ghost.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 10)}px)`
  }

  function show(next: { key: string; rect: Rect } | undefined) {
    const same = next && current && next.key === current.key && Math.abs(next.rect.left - current.rect.left) < 1
      && Math.abs(next.rect.top - current.rect.top) < 1 && Math.abs(next.rect.width - current.rect.width) < 1
    current = next
    ghost.toggleAttribute('data-over', Boolean(next))
    if (same) return
    spread?.cancel()
    if (!next) { preview.hidden = true; return }
    const { rect } = next
    preview.hidden = false
    preview.dataset.zone = next.key
    Object.assign(preview.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    const duration = motionMs('base')
    if (!duration) return
    // The fill settles into the area from the pointer, using only transform and opacity.
    const cx = Math.max(0, Math.min(rect.width, x - rect.left))
    const cy = Math.max(0, Math.min(rect.height, y - rect.top))
    preview.style.transformOrigin = `${cx}px ${cy}px`
    spread = preview.animate([
      { transform: 'scale(.97)', opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], { duration, easing: getComputedStyle(document.documentElement).getPropertyValue('--ease-enter').trim() || 'ease-out' })
  }

  function update() {
    follow()
    show(host?.zoneAt(x, y, options.payload))
  }

  function finish(drop: boolean) {
    if (active !== session) return
    active = undefined
    lifetime.abort()
    delete document.documentElement.dataset.openDragging
    const target = drop ? current : undefined
    if (target && host) {
      host.drop(options.payload, target.key)
      ghost.remove()
      preview.dataset.state = 'leaving'
      const duration = motionMs('fast')
      if (duration) window.setTimeout(() => preview.remove(), duration)
      else preview.remove()
    } else {
      preview.remove()
      // Nowhere to go: the name fades where it was let go.
      const duration = motionMs('fast')
      if (!duration) ghost.remove()
      else {
        ghost.dataset.state = 'scatter'
        window.setTimeout(() => ghost.remove(), duration + 40)
      }
    }
    options.onEnd?.(Boolean(target))
  }

  window.addEventListener('pointermove', (event) => {
    if (event.pointerId !== options.pointerId) return
    event.preventDefault()
    x = event.clientX
    y = event.clientY
    update()
  }, { signal, capture: true })
  window.addEventListener('pointerup', (event) => { if (event.pointerId === options.pointerId) finish(true) }, { signal, capture: true })
  window.addEventListener('pointercancel', (event) => { if (event.pointerId === options.pointerId) finish(false) }, { signal, capture: true })
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    finish(false)
  }, { signal, capture: true })
  // While a finger drags, the page must not scroll under it.
  window.addEventListener('touchmove', (event) => event.preventDefault(), { signal, passive: false })
  window.addEventListener('blur', () => finish(false), { signal })
  const session = { cancel: () => finish(false) }
  active = session
  update()
  return session
}

const dragThreshold = 6
export const pressDelay = 380

/**
 * Makes an entry draggable into the page's drop area. A mouse drags once it moves a few pixels.
 * A finger first holds still for a moment: moving on then drags, lifting instead opens the entry's
 * menu (so a swipe still scrolls the list). A click that was not a drag works as usual.
 */
export function draggableEntry(node: HTMLElement, options: { label: () => string; payload: () => DragPayload; menu?: (point: { x: number; y: number }) => void; signal: AbortSignal }) {
  const { signal } = options
  let press: { x: number; y: number; id: number; type: string; timer: number; armed: boolean } | undefined
  let dragged = false
  const release = () => { if (press) window.clearTimeout(press.timer); press = undefined; node.classList.remove('entry-pressing') }
  const begin = (event: PointerEvent) => {
    release()
    dragged = true
    try { node.releasePointerCapture(event.pointerId) } catch { /* Not captured. */ }
    startOpenDrag({ label: options.label(), payload: options.payload(), x: event.clientX, y: event.clientY, pointerId: event.pointerId })
  }
  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || isOpenDragging()) return
    dragged = false
    press = { x: event.clientX, y: event.clientY, id: event.pointerId, type: event.pointerType, timer: 0, armed: false }
    if (event.pointerType !== 'mouse') {
      press.timer = window.setTimeout(() => {
        if (!press) return
        press.armed = true
        node.classList.add('entry-pressing')
        navigator.vibrate?.(8)
      }, pressDelay)
    }
  }, { signal })
  window.addEventListener('pointermove', (event) => {
    if (!press || event.pointerId !== press.id) return
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y)
    if (press.type !== 'mouse') {
      if (press.armed && moved > 8) begin(event)
      else if (!press.armed && moved > 8) release()
      return
    }
    if (moved > dragThreshold) begin(event)
  }, { signal })
  window.addEventListener('pointerup', (event) => {
    if (!press) return
    const held = press?.armed && event.pointerId === press.id
    release()
    if (held && options.menu) { dragged = true; options.menu({ x: event.clientX, y: event.clientY }) }
  }, { signal })
  window.addEventListener('pointercancel', release, { signal })
  node.addEventListener('dragstart', (event) => event.preventDefault(), { signal })
  // A drag ends with a click on the entry; it must not open it a second time.
  node.addEventListener('click', (event) => { if (dragged) { dragged = false; event.preventDefault(); event.stopImmediatePropagation() } }, { capture: true, signal })
  // A finger's long press opens the app's own menu, not the system's.
  node.addEventListener('contextmenu', (event) => { if (press && press.type !== 'mouse') event.preventDefault() }, { signal })
  // Touch scrolling must not start once the press is armed.
  node.addEventListener('touchmove', (event) => { if (press?.armed) event.preventDefault() }, { signal, passive: false })
}
