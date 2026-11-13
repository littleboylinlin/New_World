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

  // Keep the whole menu inside the window.
  const box = menu.getBoundingClientRect()
  let left: number
  let top: number
  if (at instanceof HTMLElement) {
    const anchor = at.getBoundingClientRect()
    left = anchor.right - box.width
    top = anchor.bottom + 6
    if (top + box.height > innerHeight - 8) top = anchor.top - box.height - 6
  } else {
    left = at.x
    top = at.y
    if (top + box.height > innerHeight - 8) top = at.y - box.height
  }
  menu.style.left = `${Math.max(8, Math.min(left, innerWidth - box.width - 8))}px`
  menu.style.top = `${Math.max(8, Math.min(top, innerHeight - box.height - 8))}px`

  const focus = (index: number) => buttons[(index + buttons.length) % buttons.length]?.focus()
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
  document.addEventListener('scroll', dismiss, true)

  function close(returnFocus = false) {
    if (current?.menu !== menu) return
    current = undefined
    menu.remove()
    opener?.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', outside, true)
    window.removeEventListener('blur', dismiss)
    window.removeEventListener('resize', dismiss)
    document.removeEventListener('scroll', dismiss, true)
    if (returnFocus) opener?.focus()
  }
  current = { menu, close }
  opener?.setAttribute('aria-expanded', 'true')
  focus(0)
}
