import { afterTransition, motionMs } from '../motion'
import './shell.css'

/**
 * Opens or closes a block by animating its height (and fading it), then leaves it at its natural
 * height or hidden. Calling it again mid-way reverses from where it is.
 */
export function setExpanded(region: HTMLElement, open: boolean, onDone?: () => void) {
  const state = open ? 'open' : 'closed'
  if (region.dataset.expand === state && region.hidden === !open) { onDone?.(); return }
  region.dataset.expand = state
  region.classList.add('shell-collapse')
  const finishPrevious = (region as HTMLElement & { finishExpand?: () => void }).finishExpand
  const from = region.hidden ? 0 : region.getBoundingClientRect().height
  if (finishPrevious) { (region as HTMLElement & { finishExpand?: () => void }).finishExpand = undefined; finishPrevious() }
  region.dataset.expand = state
  if (!motionMs('base')) {
    region.hidden = !open
    region.inert = !open
    region.style.removeProperty('height')
    region.style.removeProperty('opacity')
    onDone?.()
    return
  }
  region.hidden = false
  region.inert = !open
  region.style.overflow = 'hidden'
  region.style.height = 'auto'
  const to = open ? region.getBoundingClientRect().height : 0
  region.style.transition = 'none'
  region.style.height = `${from}px`
  region.style.opacity = open && !from ? '0' : region.style.opacity || '1'
  void region.offsetHeight
  region.style.removeProperty('transition')
  region.style.height = `${to}px`
  region.style.opacity = open ? '1' : '0'
  const finish = afterTransition(region, 'base', () => {
    ;(region as HTMLElement & { finishExpand?: () => void }).finishExpand = undefined
    if (region.dataset.expand !== state) return
    region.style.removeProperty('height')
    region.style.removeProperty('opacity')
    region.style.removeProperty('overflow')
    if (!open) region.hidden = true
    onDone?.()
  })
  ;(region as HTMLElement & { finishExpand?: () => void }).finishExpand = finish
}
