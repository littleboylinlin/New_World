import { element, icon } from './ui'

export interface MenuItem {
  label: string
  icon?: Parameters<typeof icon>[0]
  danger?: boolean
  action: () => void
}

let current: { menu: HTMLElement; close: (returnFocus?: boolean) => void } | undefined

/**
 * Opens a list of actions at a point (a right click) or under an element (a menu button).
 * Arrow keys move between items, Enter runs one, Escape or a click elsewhere closes it.
 */
export function openMenu(items: MenuItem[], at: { x: number; y: number } | HTMLElement, label: string, opener?: HTMLElement) {
  current?.close()
  const menu = element('div', 'popup-menu')
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', label)
  const buttons = items.map((item) => {
    const entry = element('button', item.danger ? 'popup-item popup-danger' : 'popup-item')
    entry.type = 'button'
    entry.setAttribute('role', 'menuitem')
    entry.tabIndex = -1
    if (item.icon) entry.append(icon(item.icon))
    entry.append(element('span', '', item.label))
    entry.addEventListener('click', () => {
      close(false)
      item.action()
    })
    menu.append(entry)
    return entry
  })
  document.body.append(menu)
  const anchored = at instanceof HTMLElement
  if (anchored) menu.classList.add('popup-anchored')

  // Every menu is fixed to the window: it never adds to the page's height or scrolls it. A menu
  // button's list drops below the button, or above it when there is more room there; a right-click
  // menu opens at the pointer and turns back at the window edges. When neither side fits the
  // whole list, it takes the larger side and scrolls inside.
  function place() {
    const edge = 8, gap = 8
    menu.style.maxHeight = 'none'
    const natural = menu.scrollHeight + 4
    const width = menu.getBoundingClientRect().width
    let left: number, top: number, up: boolean
    if (at instanceof HTMLElement) {
      const anchor = at.getBoundingClientRect()
      const below = innerHeight - anchor.bottom - gap - edge
      const above = anchor.top - gap - edge
      up = natural > below && above > below
      const room = Math.max(96, up ? above : below)
      const height = Math.min(natural, room)
      menu.style.maxHeight = `${Math.floor(room)}px`
      left = anchor.right - width
      top = up ? anchor.top - gap - height : anchor.bottom + gap
    } else {
      const room = innerHeight - 2 * edge
      const height = Math.min(natural, room)
      menu.style.maxHeight = `${Math.floor(room)}px`
      up = at.y + height > innerHeight - edge
      left = at.x + width > innerWidth - edge ? at.x - width : at.x
      top = up ? at.y - height : at.y
    }
    menu.style.left = `${Math.round(Math.max(edge, Math.min(left, innerWidth - width - edge)))}px`
    menu.style.top = `${Math.round(Math.max(edge, Math.min(top, innerHeight - edge - Math.min(natural, innerHeight - 2 * edge))))}px`
    menu.dataset.side = up ? 'top' : 'bottom'
  }
  place()

  const focus = (index: number) => buttons[(index + buttons.length) % buttons.length]?.focus({ preventScroll: true })
  menu.addEventListener('keydown', (event) => {
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') focus(index + 1)
    else if (event.key === 'ArrowUp') focus(index - 1)
    else if (event.key === 'Home') focus(0)
    else if (event.key === 'End') focus(buttons.length - 1)
    else if (event.key === 'Escape') close(true)
    else if (event.key === 'Tab') close(false)
    else return
    event.preventDefault()
    event.stopPropagation()
  })
  const outside = (event: Event) => { if (!menu.contains(event.target as Node)) close(false) }
  const dismiss = () => close(false)
  document.addEventListener('pointerdown', outside, true)
  // A menu button's list follows its button when the page under it scrolls or shifts, and closes
  // once the button has left the window. A right-click menu has nothing to follow and closes.
  const scrolled = (event: Event) => { if (!menu.contains(event.target as Node)) close(false) }
  let frame = 0
  let last = ''
  const follow = () => {
    if (!(at instanceof HTMLElement)) return
    frame = requestAnimationFrame(follow)
    const box = at.getBoundingClientRect()
    const key = `${box.left},${box.top},${box.right},${box.bottom},${innerWidth},${innerHeight}`
    if (key === last) return
    last = key
    if (!at.isConnected || box.bottom < 0 || box.top > innerHeight || !box.width) { close(false); return }
    place()
  }
  window.addEventListener('blur', dismiss)
  if (anchored) {
    last = (() => { const box = at.getBoundingClientRect(); return `${box.left},${box.top},${box.right},${box.bottom},${innerWidth},${innerHeight}` })()
    frame = requestAnimationFrame(follow)
  } else {
    window.addEventListener('resize', dismiss)
    document.addEventListener('scroll', scrolled, { capture: true, passive: true })
    window.addEventListener('wheel', scrolled, { passive: true })
    window.addEventListener('touchmove', scrolled, { passive: true })
  }

  function close(returnFocus = false) {
    if (current?.menu !== menu) return
    current = undefined
    menu.remove()
    opener?.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', outside, true)
    cancelAnimationFrame(frame)
    window.removeEventListener('blur', dismiss)
    window.removeEventListener('resize', dismiss)
    document.removeEventListener('scroll', scrolled, { capture: true })
    window.removeEventListener('wheel', scrolled)
    window.removeEventListener('touchmove', scrolled)
    if (returnFocus) opener?.focus()
  }
  current = { menu, close }
  opener?.setAttribute('aria-expanded', 'true')
  focus(0)
}
