import './motion.css'

export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

// Deeper pages enter from the right and going back enters from the left.
function depth(hash: string) {
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean).length
}

// Swap synchronously so an interrupted animation never leaves the previous page or title on screen.
export function changeView(view: HTMLElement, from: string, to: string, render: () => void) {
  delete view.dataset.enter
  render()
  if (reducedMotion.matches) return
  view.dataset.enter = depth(to) > depth(from) ? 'forward' : depth(to) < depth(from) ? 'back' : 'level'
}

// Children of a list rise one after another the first time it is shown. Only the first six take part;
// the stylesheet shows the rest at once, so a long list never makes anyone wait.
export function stagger(list: HTMLElement) {
  list.classList.add('stagger')
  Array.from(list.children).slice(0, 6).forEach((item, index) => (item as HTMLElement).style.setProperty('--order', String(index)))
  return list
}

// Play a short pop on an element whose value just changed.
export function pop(element: HTMLElement) {
  element.classList.remove('pop')
  void element.offsetWidth
  element.classList.add('pop')
}

// Let an element animate out before it is removed.
export function leave(element: HTMLElement) {
  if (reducedMotion.matches || !element.isConnected) {
    element.remove()
    return
  }
  element.classList.add('leaving')
  element.setAttribute('aria-hidden', 'true')
  element.inert = true
  const done = () => element.remove()
  element.addEventListener('animationend', done, { once: true })
  window.setTimeout(done, motionMs('fast') + 60)
}

export type MotionToken = 'instant' | 'fast' | 'base' | 'slow'

/** Reads one of the shared duration tokens in milliseconds; zero when motion is reduced. */
export function motionMs(token: MotionToken = 'base') {
  if (reducedMotion.matches) return 0
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--motion-${token}`).trim()
  const number = Number.parseFloat(value)
  if (!Number.isFinite(number)) return 0
  return value.endsWith('ms') ? number : number * 1000
}

/**
 * Plays a CSS transition driven by a data-state attribute, and calls `done` once it ends.
 * Falls back to a timer so an interrupted or skipped transition never leaves the element stuck.
 */
export function afterTransition(node: HTMLElement, token: MotionToken, done: () => void) {
  const wait = motionMs(token)
  let finished = false
  let timer = 0
  const finish = () => {
    if (finished) return
    finished = true
    node.removeEventListener('transitionend', onEnd)
    window.clearTimeout(timer)
    done()
  }
  const onEnd = (event: TransitionEvent) => { if (event.target === node) finish() }
  if (!wait) { finish(); return finish }
  node.addEventListener('transitionend', onEnd)
  timer = window.setTimeout(finish, wait + 60)
  return finish
}
