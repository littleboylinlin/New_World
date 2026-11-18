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

// Children of a list rise one after another the first time it is shown.
export function stagger(list: HTMLElement) {
  list.classList.add('stagger')
  Array.from(list.children).forEach((item, index) => (item as HTMLElement).style.setProperty('--order', String(Math.min(index, 10))))
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
  const done = () => element.remove()
  element.addEventListener('animationend', done, { once: true })
  window.setTimeout(done, 400)
}
