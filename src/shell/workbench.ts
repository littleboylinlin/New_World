import { t } from '../i18n'
import { afterTransition } from '../motion'
import { element } from '../ui'
import './shell.css'

export interface SidePanelOptions {
  label: string
  /** Width in pixels while the panel sits beside the main pane. */
  width: number
  minWidth?: number
  maxWidth?: number
  /** The main pane keeps at least this much room before the panel turns into a drawer. */
  inlineFrom: number
  resizable?: boolean
  onToggle?: (open: boolean, byUser: boolean) => void
  /** Whether the panel should come back when the window grows wide enough for it again. */
  openWhenInline?: () => boolean
  onResize?: (width: number) => void
}

export type PanelMode = 'inline' | 'overlay'

export interface SidePanel {
  element: HTMLElement
  body: HTMLElement
  isOpen: () => boolean
  mode: () => PanelMode
  setOpen: (open: boolean, byUser?: boolean, instant?: boolean) => void
  toggle: () => void
  width: () => number
}

/**
 * A page body made of an optional start panel, a main pane and an optional end panel. Panels sit
 * beside the main pane while there is room and become drawers over it on narrow screens. Each
 * region scrolls on its own; the workbench itself never does.
 */
export function createWorkbench(options: { start?: SidePanelOptions; end?: SidePanelOptions; signal: AbortSignal }) {
  const root = element('div', 'workbench')
  const main = element('div', 'workbench-main')
  const scrim = element('div', 'workbench-scrim')
  scrim.hidden = true
  scrim.dataset.state = 'closed'
  const panels: SidePanel[] = []

  function panel(side: 'start' | 'end', config: SidePanelOptions): SidePanel {
    const aside = element('aside', `workbench-panel workbench-${side}`)
    aside.setAttribute('aria-label', config.label)
    const body = element('div', 'workbench-panel-body')
    aside.append(body)
    let open = false
    let mode: PanelMode = 'inline'
    let width = clamp(config.width)
    let settle: (() => void) | undefined
    function clamp(value: number) {
      const max = Math.min(config.maxWidth ?? 560, Math.max(config.minWidth ?? 200, root.clientWidth * .5 || Infinity))
      return Math.round(Math.max(config.minWidth ?? 200, Math.min(max, value)))
    }
    function paint(animate: boolean) {
      aside.style.setProperty('--panel-width', `${width}px`)
      aside.dataset.mode = mode
      settle?.()
      if (open) {
        aside.hidden = false
        aside.inert = false
        if (animate) void aside.offsetWidth
        aside.dataset.state = 'open'
      } else {
        aside.dataset.state = 'closed'
        aside.inert = true
        settle = afterTransition(aside, 'base', () => { settle = undefined; if (!open) aside.hidden = true })
        if (!animate) settle()
      }
      paintScrim()
    }
    const api: SidePanel = {
      element: aside, body,
      isOpen: () => open,
      mode: () => mode,
      width: () => width,
      setOpen(next, byUser = false, instant = false) {
        if (next === open) return
        open = next
        if (open && mode === 'overlay') for (const other of panels) if (other !== api && other.mode() === 'overlay') other.setOpen(false)
        paint(!instant)
        config.onToggle?.(open, byUser)
        if (open && mode === 'overlay') requestAnimationFrame(() => {
          if (!open || mode !== 'overlay' || aside.contains(document.activeElement)) return
          const preferred = aside.querySelector<HTMLElement>('[aria-current="true"], [role="tab"][aria-selected="true"]')
          const target = preferred ?? aside.querySelector<HTMLElement>('button, [tabindex="0"]')
          target?.focus({ preventScroll: true })
        })
      },
      toggle() { api.setOpen(!open, true) },
    }
    ;(api as SidePanel & { relayout: (room: number) => void }).relayout = (room: number) => {
      const next: PanelMode = room >= config.inlineFrom ? 'inline' : 'overlay'
      width = clamp(width)
      if (next === mode) { aside.style.setProperty('--panel-width', `${width}px`); return }
      const wasOverlay = mode === 'overlay'
      mode = next
      // A drawer that would cover the text never opens by itself; it waits to be asked.
      if (mode === 'overlay' && open && !wasOverlay) { open = false; config.onToggle?.(false, false) }
      else if (mode === 'inline' && wasOverlay && !open && config.openWhenInline?.()) { open = true; config.onToggle?.(true, false) }
      paint(false)
    }

    if (config.resizable) {
      const handle = element('div', 'workbench-resizer')
      handle.setAttribute('role', 'separator')
      handle.setAttribute('aria-orientation', 'vertical')
      handle.setAttribute('aria-label', t('shell.resizePanel', [config.label]))
      handle.tabIndex = 0
      const update = (value: number, save: boolean) => {
        width = clamp(value)
        aside.style.setProperty('--panel-width', `${width}px`)
        handle.setAttribute('aria-valuenow', String(width))
        if (save) config.onResize?.(width)
      }
      handle.setAttribute('aria-valuemin', String(config.minWidth ?? 200))
      handle.setAttribute('aria-valuemax', String(config.maxWidth ?? 560))
      handle.setAttribute('aria-valuenow', String(width))
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || mode !== 'inline') return
        event.preventDefault()
        handle.setPointerCapture(event.pointerId)
        const startX = event.clientX
        const startWidth = width
        const rtl = getComputedStyle(root).direction === 'rtl'
        aside.dataset.resizing = ''
        const move = (next: PointerEvent) => {
          const delta = (next.clientX - startX) * (rtl ? -1 : 1)
          update(side === 'end' ? startWidth - delta : startWidth + delta, false)
        }
        const end = () => {
          delete aside.dataset.resizing
          handle.removeEventListener('pointermove', move)
          config.onResize?.(width)
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', end, { once: true })
        handle.addEventListener('pointercancel', end, { once: true })
      })
      handle.addEventListener('keydown', (event) => {
        const step = event.shiftKey ? 48 : 16
        const grow = side === 'end' ? 'ArrowLeft' : 'ArrowRight'
        const shrink = side === 'end' ? 'ArrowRight' : 'ArrowLeft'
        if (event.key === grow) update(width + step, true)
        else if (event.key === shrink) update(width - step, true)
        else return
        event.preventDefault()
      })
      handle.addEventListener('dblclick', () => update(config.width, true))
      aside.append(handle)
    }
    aside.hidden = true
    aside.inert = true
    aside.dataset.state = 'closed'
    panels.push(api)
    return api
  }

  function paintScrim() {
    const covering = panels.some((item) => item.isOpen() && item.mode() === 'overlay')
    if (covering) {
      scrim.hidden = false
      void scrim.offsetWidth
      scrim.dataset.state = 'open'
    } else if (scrim.dataset.state !== 'closed') {
      scrim.dataset.state = 'closed'
      afterTransition(scrim, 'base', () => { if (scrim.dataset.state === 'closed') scrim.hidden = true })
    }
  }

  const start = options.start ? panel('start', options.start) : undefined
  const end = options.end ? panel('end', options.end) : undefined
  root.append(...[start?.element, main, end?.element, scrim].filter((node): node is HTMLElement => Boolean(node)))
  scrim.addEventListener('click', () => { for (const item of panels) if (item.mode() === 'overlay') item.setOpen(false, true) })
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    const drawer = panels.find((item) => item.isOpen() && item.mode() === 'overlay' && item.element.contains(event.target as Node))
    if (!drawer) return
    event.preventDefault()
    drawer.setOpen(false, true)
  })

  function relayout() {
    const room = root.clientWidth
    if (!room) return
    for (const item of panels) (item as SidePanel & { relayout: (room: number) => void }).relayout(room)
  }
  const observer = new ResizeObserver(relayout)
  observer.observe(root)
  options.signal.addEventListener('abort', () => observer.disconnect(), { once: true })

  return { element: root, main, start, end, relayout }
}

export interface TabDefinition {
  id: string
  label: string
  panel: HTMLElement
}

/**
 * A row of tabs over swappable panels. New tabs can be added at any time, which is how later
 * features (such as side-by-side reading) join the side panel.
 */
// Tab ids are unique across the page: one set of tabs can sit inside another's panel.
let tabSerial = 0

export function createTabs(label: string, onSelect: (id: string) => void) {
  const root = element('div', 'shell-tabs')
  const list = element('div', 'shell-tablist')
  list.setAttribute('role', 'tablist')
  list.setAttribute('aria-label', label)
  const indicator = element('span', 'shell-tab-indicator')
  indicator.setAttribute('aria-hidden', 'true')
  list.append(indicator)
  const stage = element('div', 'shell-tab-stage')
  root.append(list, stage)
  const tabs = new Map<string, { button: HTMLButtonElement; panel: HTMLElement; count: HTMLElement }>()
  let selected = ''

  function paintIndicator() {
    const current = tabs.get(selected)?.button
    if (!current || !current.offsetWidth) { indicator.style.opacity = '0'; return }
    indicator.style.opacity = '1'
    // A 1px bar stretched to the tab, so moving between tabs only ever animates transform.
    indicator.style.transform = `translateX(${current.offsetLeft}px) scaleX(${current.offsetWidth})`
  }
  new ResizeObserver(paintIndicator).observe(list)

  function select(id: string, focus = false) {
    const next = tabs.get(id)
    if (!next || next.button.disabled) return false
    const previous = tabs.get(selected)
    const order = [...tabs.keys()]
    const forward = order.indexOf(id) >= order.indexOf(selected)
    selected = id
    for (const [key, tab] of tabs) {
      const on = key === id
      tab.button.setAttribute('aria-selected', String(on))
      tab.button.tabIndex = on ? 0 : -1
      tab.panel.hidden = !on
    }
    if (previous && previous.panel !== next.panel) next.panel.dataset.enter = forward ? 'forward' : 'back'
    void next.panel.offsetWidth
    delete next.panel.dataset.enter
    paintIndicator()
    if (focus) next.button.focus()
    onSelect(id)
    return true
  }

  list.addEventListener('keydown', (event) => {
    const enabled = [...tabs.values()].filter((tab) => !tab.button.disabled && !tab.button.hidden).map((tab) => tab.button)
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement)
    let target: HTMLButtonElement | undefined
    if (event.key === 'ArrowRight') target = enabled[(index + 1) % enabled.length]
    else if (event.key === 'ArrowLeft') target = enabled[(index - 1 + enabled.length) % enabled.length]
    else if (event.key === 'Home') target = enabled[0]
    else if (event.key === 'End') target = enabled[enabled.length - 1]
    if (!target) return
    event.preventDefault()
    select(target.dataset.tab!, true)
  })

  return {
    element: root,
    add(definition: TabDefinition) {
      const id = `shell-tab-${++tabSerial}`
      // The tab panel wraps the content, so the content keeps its own role and name.
      const content = definition.panel
      const wrapper = element('div')
      wrapper.append(content)
      definition = { ...definition, panel: wrapper }
      const tab = element('button', 'shell-tab')
      tab.type = 'button'
      tab.id = id
      tab.dataset.tab = definition.id
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', 'false')
      tab.tabIndex = -1
      const count = element('span', 'trash-count shell-tab-count')
      tab.append(element('span', '', definition.label), count)
      definition.panel.setAttribute('role', 'tabpanel')
      definition.panel.setAttribute('aria-labelledby', id)
      definition.panel.classList.add('shell-tab-panel')
      definition.panel.hidden = true
      tab.addEventListener('click', () => select(definition.id))
      list.append(tab)
      stage.append(definition.panel)
      tabs.set(definition.id, { button: tab, panel: definition.panel, count })
      if (!selected) select(definition.id)
      return tab
    },
    select,
    selected: () => selected,
    setDisabled(id: string, disabled: boolean, title = '') {
      const tab = tabs.get(id)
      if (!tab) return
      tab.button.disabled = disabled
      tab.button.title = title
      if (disabled && selected === id) {
        const fallback = [...tabs.entries()].find(([, other]) => !other.button.disabled)
        if (fallback) select(fallback[0])
      }
    },
    setCount(id: string, value: string) {
      const tab = tabs.get(id)
      if (tab) tab.count.textContent = value
    },
    refresh: paintIndicator,
  }
}
