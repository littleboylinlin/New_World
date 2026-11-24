import { afterTransition, motionMs } from '../motion'
import './shell.css'

type Expanding = HTMLElement & { finishExpand?: () => void }

/**
 * Opens or closes a block. The room it takes changes at once, so nothing animates its height;
 * opening fades the contents down into place and closing fades them out before hiding the block.
 * Calling it again mid-way cuts the running fade short and starts the new one from where it is.
 */
export function setExpanded(region: HTMLElement, open: boolean, onDone?: () => void) {
  const node = region as Expanding
  const state = open ? 'open' : 'closed'
  if (node.dataset.expand === state && node.hidden === !open) { onDone?.(); return }
  const finishPrevious = node.finishExpand
  node.finishExpand = undefined
  node.dataset.expand = state
  node.classList.add('shell-collapse')
  finishPrevious?.()
  const clear = () => { node.style.removeProperty('opacity'); node.style.removeProperty('transform') }
  if (!motionMs('base')) {
    node.hidden = !open
    node.inert = !open
    clear()
    onDone?.()
    return
  }
  node.inert = !open
  if (open) {
    const appearing = node.hidden
    node.hidden = false
    if (appearing) {
      node.style.transition = 'none'
      node.style.opacity = '0'
      node.style.transform = 'translateY(calc(var(--motion-shift) * -1))'
      void node.offsetHeight
      node.style.removeProperty('transition')
    }
    node.style.opacity = '1'
    node.style.transform = 'none'
  } else {
    node.style.opacity = '0'
    node.style.transform = 'translateY(calc(var(--motion-shift) * -1))'
  }
  node.finishExpand = afterTransition(node, open ? 'base' : 'fast', () => {
    node.finishExpand = undefined
    if (node.dataset.expand !== state) return
    clear()
    if (!open) node.hidden = true
    onDone?.()
  })
}
