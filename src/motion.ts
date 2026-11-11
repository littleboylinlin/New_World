import './motion.css'

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

// Deeper pages enter from the right and going back enters from the left.
function depth(hash: string) {
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean).length
}

function shelfOf(hash: string) {
  return hash.match(/^#\/(original|reference)\/?$/)?.[1]
}

// Between the home page and a shelf, the library name flies from its card to the page heading or back.
function libraryName(view: HTMLElement, library: string) {
  return view.querySelector<HTMLElement>(`.shelf-${library} .card-copy h2, .shelf-page .page-heading h1`)
}

function fly(from: DOMRect, target: HTMLElement) {
  const to = target.getBoundingClientRect()
  if (!to.height || from.bottom < 0 || from.top > innerHeight) return
  // The travelling name is drawn by CSS from an attribute, so the page text stays single.
  const ghost = document.createElement('span')
  ghost.className = 'name-ghost'
  ghost.setAttribute('aria-hidden', 'true')
  ghost.dataset.text = target.textContent ?? ''
  const style = getComputedStyle(target)
  Object.assign(ghost.style, {
    left: `${to.left}px`, top: `${to.top}px`, font: style.font, letterSpacing: style.letterSpacing, color: style.color,
  })
  document.body.append(ghost)
  target.classList.add('name-landing')
  const scale = from.height / to.height
  const flight = ghost.animate([
    { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${scale})` },
    { transform: 'none' },
  ], { duration: 380, easing: 'cubic-bezier(.2, .75, .25, 1)' })
  const land = () => {
    ghost.remove()
    target.classList.remove('name-landing')
  }
  flight.finished.then(land, land)
}

let travelling = false

// Swap the page at once, then let the new page animate in. Nothing waits on the animation.
export function changeView(view: HTMLElement, from: string, to: string, render: () => void) {
  const direction = depth(to) > depth(from) ? 'forward' : depth(to) < depth(from) ? 'back' : 'level'
  const library = depth(from) === 0 ? shelfOf(to) : depth(to) === 0 ? shelfOf(from) : undefined
  const start = !reducedMotion.matches && library ? libraryName(view, library)?.getBoundingClientRect() : undefined
  delete view.dataset.enter
  travelling = !!start
  try {
    render()
  } finally {
    travelling = false
  }
  if (reducedMotion.matches) return
  // The landing place is measured before the page starts to move.
  const target = start && library ? libraryName(view, library) : null
  if (start && target) fly(start, target)
  view.dataset.enter = direction
}

// Children of a list rise one after another the first time it is shown.
export function stagger(list: HTMLElement) {
  // A list that arrives while a name is travelling comes in with the page instead.
  if (travelling) return list
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
