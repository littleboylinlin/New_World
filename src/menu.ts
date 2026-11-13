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

  const box = menu.getBoundingClientRect()
  if (at instanceof HTMLElement) {
    // A menu button's list always drops down, lined up with the button's right edge. It sits in the
    // page, so it scrolls with it; when it would run past the bottom, the page scrolls to show it.
    const anchor = at.getBoundingClientRect()
    menu.classList.add('popup-anchored')
    const left = Math.max(8, Math.min(anchor.right - box.width, innerWidth - box.width - 8))
    menu.style.left = `${left + scrollX}px`
    menu.style.top = `${anchor.bottom + 8 + scrollY}px`
    const overflow = anchor.bottom + 8 + box.height + 12 - innerHeight
    if (overflow > 0) {
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches
      window.scrollBy({ top: overflow, behavior: smooth ? 'smooth' : 'instant' })
    }
  } else {
    // A right-click menu opens at the pointer and turns back at the window edges, like the system's.
    const left = at.x + box.width > innerWidth - 8 ? at.x - box.width : at.x
    const top = at.y + box.height > innerHeight - 8 ? at.y - box.height : at.y
    menu.style.left = `${Math.max(8, Math.min(left, innerWidth - box.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(top, innerHeight - box.height - 8))}px`
  }

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
  window.addEventListener('blur', dismiss)
  window.addEventListener('resize', dismiss)
  // Close when the reader scrolls the page, but not when the page scrolls itself to show something.
  window.addEventListener('wheel', dismiss, { passive: true })
  window.addEventListener('touchmove', dismiss, { passive: true })

  function close(returnFocus = false) {
    if (current?.menu !== menu) return
    current = undefined
    menu.remove()
    opener?.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', outside, true)
    window.removeEventListener('blur', dismiss)
    window.removeEventListener('resize', dismiss)
    window.removeEventListener('wheel', dismiss)
    window.removeEventListener('touchmove', dismiss)
    if (returnFocus) opener?.focus()
  }
  current = { menu, close }
  opener?.setAttribute('aria-expanded', 'true')
  focus(0)
}
