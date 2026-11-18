import { t } from './i18n'
import { preference } from './navigation-preferences'
import { element, icon, link } from './ui'

const entries = [
  ['home', '#/', 'navigation.start', 'home'],
  ['writing', '#/writing', 'navigation.writing', 'book'],
  ['notes', '#/notes', 'navigation.notes', 'idea'],
  ['archive', '#/archive', 'archive.title', 'archive'],
  ['trash', '#/trash', 'trash.title', 'trash'],
  ['settings', '#/settings', 'settings.title', 'settings'],
] as const
type Destination = typeof entries[number][0]

export function mountSidebar() {
  const sidebar = document.querySelector<HTMLElement>('#app-sidebar')!
  const nav = document.querySelector<HTMLElement>('#app-nav')!
  const toggle = document.querySelector<HTMLButtonElement>('#sidebar-toggle')!
  const menu = document.querySelector<HTMLButtonElement>('#drawer-toggle')!
  const backdrop = document.querySelector<HTMLElement>('#drawer-backdrop')!
  const column = document.querySelector<HTMLElement>('.app-column')!
  const narrow = matchMedia('(max-width: 640px)')
  const preferenceState = preference('sidebar-collapsed', ['yes', 'no'] as const, 'no')
  const links = new Map<Destination, HTMLAnchorElement>()
  let inWork = false
  let collapsed = preferenceState.get() === 'yes'
  let drawer = false
  const trashDot = element('span', 'trash-dot')
  trashDot.id = 'trash-unread'
  trashDot.hidden = true
  trashDot.append(element('span', 'visually-hidden', t('trash.newItems')))

  for (const [id, path, key, glyph] of entries) {
    const label = t(key)
    const entry = link(path, '', 'sidebar-link')
    entry.id = id === 'settings' ? id : id + '-link'
    entry.setAttribute('aria-label', label)
    entry.title = label
    entry.append(icon(glyph), element('span', 'sidebar-label', label))
    if (id === 'trash') entry.append(trashDot)
    nav.append(entry)
    links.set(id, entry)
  }
  toggle.append(icon('sidebar'))
  menu.append(icon('menu'))

  function paint() {
    const compact = collapsed && !narrow.matches
    document.documentElement.classList.toggle('sidebar-collapsed', compact)
    sidebar.classList.toggle('drawer-open', drawer)
    sidebar.inert = narrow.matches && !drawer
    column.inert = drawer
    backdrop.hidden = !drawer
    menu.setAttribute('aria-expanded', String(drawer))
    menu.setAttribute('aria-label', t(drawer ? 'navigation.closeMenu' : 'navigation.openMenu'))
    toggle.setAttribute('aria-expanded', String(!compact))
    toggle.title = t(compact ? 'navigation.expand' : 'navigation.collapse')
    toggle.setAttribute('aria-label', toggle.title)
  }
  function closeDrawer(restoreFocus: boolean) {
    if (!drawer) return
    drawer = false
    paint()
    if (restoreFocus) menu.focus()
  }
  menu.onclick = () => {
    if (drawer) closeDrawer(true)
    else {
      drawer = true
      paint()
      nav.querySelector<HTMLElement>('[aria-current]')?.focus()
    }
  }
  toggle.onclick = () => {
    collapsed = !collapsed
    if (!inWork) preferenceState.set(collapsed ? 'yes' : 'no')
    paint()
  }
  nav.addEventListener('click', (event) => {
    if ((event.target as Element).closest('a') && !event.ctrlKey && !event.metaKey) closeDrawer(true)
  })
  backdrop.onclick = () => closeDrawer(true)
  window.addEventListener('keydown', (event) => {
    if (drawer && event.key === 'Escape') { event.preventDefault(); closeDrawer(true) }
    if (drawer && event.key === 'Tab') {
      if (document.activeElement === links.get('settings') && !event.shiftKey) { event.preventDefault(); menu.focus() }
      else if (document.activeElement === menu) { event.preventDefault(); links.get(event.shiftKey ? 'settings' : 'home')!.focus() }
      else if (document.activeElement === links.get('home') && event.shiftKey) { event.preventDefault(); menu.focus() }
    }
  })
  narrow.addEventListener('change', () => { drawer = false; paint() })
  paint()
  menu.disabled = false
  toggle.disabled = false
  return {
    active(id: Destination, detail = false) {
      if (detail !== inWork) {
        inWork = detail
        collapsed = inWork || preferenceState.get() === 'yes'
      }
      closeDrawer(false)
      for (const [key, entry] of links) {
        if (key === id) entry.setAttribute('aria-current', 'page')
        else entry.removeAttribute('aria-current')
      }
      paint()
    },
    trashLink: links.get('trash')!, trashDot, settingsEntry: links.get('settings')!,
  }
}
