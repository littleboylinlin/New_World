import { t } from '../i18n'
import { afterTransition } from '../motion'
import { element, icon } from '../ui'
import type { IconName } from '../ui'
import './shell.css'

/** The part of the window that is really visible (a phone keyboard shrinks it). */
export function visibleArea() {
  const view = window.visualViewport
  const left = view?.offsetLeft ?? 0
  const top = view?.offsetTop ?? 0
  const width = view?.width ?? innerWidth
  const height = view?.height ?? innerHeight
  return { left, top, right: left + width, bottom: top + height, width, height }
}

export interface PopoverOptions {
  anchor: HTMLElement
  label: string
  role?: 'menu' | 'dialog' | 'group'
  className?: string
  /** On narrow screens the layer spans the width under the anchor instead of hugging it. */
  sheetOnNarrow?: boolean
  onClose?: () => void
}

const gap = 6
const edge = 8
const open = new Set<{ close: (focus?: boolean) => void; layer: HTMLElement }>()

/** Closes every anchored layer, for example before a dialog opens. */
export function closeAllPopovers() {
  for (const entry of [...open]) entry.close(false)
}

/**
 * A layer anchored to a control: it drops below (or above when there is no room), stays inside
 * the visible area, fades and scales in and out, and closes on Escape or a press elsewhere.
 */
export function createPopover(options: PopoverOptions) {
  const layer = element('div', `shell-layer ${options.className ?? ''}`.trim())
  layer.setAttribute('role', options.role ?? 'dialog')
  layer.setAttribute('aria-label', options.label)
  layer.dataset.state = 'closed'
  layer.tabIndex = -1
  const body = element('div', 'shell-layer-body')
  layer.append(body)
  let isOpen = false
  let finish: (() => void) | undefined
  let frame = 0
  let lifetime: AbortController | undefined
  let anchorNode = options.anchor
  const entry = { close, layer }

  function place() {
    frame = 0
    if (!isOpen) return
    const area = visibleArea()
    const anchor = anchorNode.getBoundingClientRect()
    const sheet = options.sheetOnNarrow && area.width < 560
    layer.classList.toggle('shell-layer-sheet', Boolean(sheet))
    layer.style.maxWidth = `${Math.max(1, area.width - 2 * edge)}px`
    if (sheet) layer.style.width = `${Math.max(1, area.width - 2 * edge)}px`
    else layer.style.removeProperty('width')
    const below = area.bottom - anchor.bottom - gap - edge
    const above = anchor.top - area.top - gap - edge
    layer.style.maxHeight = 'none'
    const natural = layer.scrollHeight
    const up = natural > below && above > below
    const room = Math.max(80, up ? above : below)
    layer.style.maxHeight = `${Math.floor(room)}px`
    const box = layer.getBoundingClientRect()
    const height = Math.min(natural, room)
    const left = sheet ? area.left + edge
      : Math.max(area.left + edge, Math.min(anchor.right - box.width, area.right - edge - box.width))
    const top = up ? anchor.top - gap - height : anchor.bottom + gap
    layer.style.left = `${Math.round(left)}px`
    layer.style.top = `${Math.round(Math.max(area.top + edge, top))}px`
    layer.dataset.side = up ? 'top' : 'bottom'
    const originX = Math.max(0, Math.min(box.width, anchor.left + anchor.width / 2 - left))
    layer.style.transformOrigin = `${Math.round(originX)}px ${up ? '100%' : '0'}`
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place) }

  function show(focus = true, from?: HTMLElement) {
    if (isOpen) return
    anchorNode = from ?? options.anchor
    closeAllPopovers()
    finish?.()
    isOpen = true
    open.add(entry)
    lifetime = new AbortController()
    const { signal } = lifetime
    document.body.append(layer)
    layer.dataset.state = 'closed'
    place()
    void layer.offsetWidth
    layer.dataset.state = 'open'
    anchorNode.setAttribute('aria-expanded', 'true')
    document.addEventListener('pointerdown', (event) => {
      const target = event.target as Node
      if (!layer.contains(target) && !anchorNode.contains(target)) close(false)
    }, { capture: true, signal })
    layer.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }, { signal })
    window.addEventListener('resize', schedule, { signal })
    window.visualViewport?.addEventListener('resize', schedule, { signal })
    window.visualViewport?.addEventListener('scroll', schedule, { signal })
    document.addEventListener('scroll', (event) => {
      if (!layer.contains(event.target as Node)) schedule()
    }, { capture: true, passive: true, signal })
    const resized = new ResizeObserver(schedule)
    resized.observe(layer)
    signal.addEventListener('abort', () => resized.disconnect(), { once: true })
    if (focus) {
      const first = layer.querySelector<HTMLElement>('[data-autofocus], [role^="menuitem"]:not([disabled]), input, select, button:not([disabled])')
      ;(first ?? layer).focus({ preventScroll: true })
    }
  }

  function close(returnFocus = false) {
    if (!isOpen) return
    isOpen = false
    open.delete(entry)
    lifetime?.abort()
    cancelAnimationFrame(frame)
    frame = 0
    anchorNode.setAttribute('aria-expanded', 'false')
    const back = anchorNode.isConnected && !anchorNode.hidden ? anchorNode : options.anchor
    if (returnFocus || layer.contains(document.activeElement)) back.focus({ preventScroll: true })
    layer.dataset.state = 'closing'
    finish = afterTransition(layer, 'fast', () => {
      finish = undefined
      if (!isOpen) { layer.remove(); layer.dataset.state = 'closed' }
    })
    options.onClose?.()
  }

  options.anchor.setAttribute('aria-expanded', 'false')
  options.anchor.setAttribute('aria-haspopup', options.role === 'menu' ? 'menu' : options.role === 'group' ? 'true' : 'dialog')

  return {
    layer, body,
    open: show, close,
    toggle(focus = true) { if (isOpen) close(true); else show(focus) },
    isOpen: () => isOpen,
    reposition: schedule,
  }
}

export interface ShellMenuItem {
  label: string
  icon?: IconName
  /** A short text drawn at the end of the row, such as a count or a shortcut. */
  hint?: string
  checked?: boolean
  /** Items of one radio set show a dot instead of a tick. */
  radio?: boolean
  disabled?: boolean
  danger?: boolean
  separator?: boolean
  action?: () => void
  children?: () => ShellMenuItem[]
}

/**
 * A menu button's list. Items with children open a second level inside the same layer, so long
 * menus stay usable on a phone. Arrow keys move, Enter or Space runs, Right opens a level, Left
 * or Escape goes back.
 */
export function menuButton(anchor: HTMLElement, label: string, items: () => ShellMenuItem[], className = '') {
  const popover = createPopover({ anchor, label, role: 'menu', className: `shell-menu ${className}`.trim(), sheetOnNarrow: false })
  const stack: { title: string; items: () => ShellMenuItem[] }[] = []

  function render(direction: 'none' | 'forward' | 'back' = 'none') {
    const level = stack[stack.length - 1]
    const list = element('div', 'shell-menu-level')
    if (direction !== 'none') list.dataset.enter = direction
    if (stack.length > 1) {
      const back = element('button', 'shell-menu-item shell-menu-back')
      back.type = 'button'
      back.setAttribute('role', 'menuitem')
      back.tabIndex = -1
      back.append(icon('back'), element('span', 'shell-menu-label', level.title))
      back.setAttribute('aria-label', t('shell.back'))
      back.addEventListener('click', () => { stack.pop(); render('back'); focusFirst() })
      list.append(back)
    }
    for (const item of level.items()) {
      if (item.separator) { list.append(element('div', 'shell-menu-separator')); continue }
      const entry = element('button', `shell-menu-item${item.danger ? ' shell-menu-danger' : ''}`)
      entry.type = 'button'
      entry.tabIndex = -1
      const checkable = item.checked !== undefined
      entry.setAttribute('role', checkable ? item.radio ? 'menuitemradio' : 'menuitemcheckbox' : 'menuitem')
      if (checkable) entry.setAttribute('aria-checked', String(item.checked))
      if (item.disabled) entry.disabled = true
      const mark = element('span', 'shell-menu-mark')
      if (item.icon) mark.append(icon(item.icon))
      else if (checkable && item.checked) mark.append(icon('check'))
      entry.append(mark, element('span', 'shell-menu-label', item.label))
      if (item.hint) entry.append(element('span', 'shell-menu-hint', item.hint))
      if (item.children) {
        entry.setAttribute('aria-haspopup', 'menu')
        entry.append(element('span', 'shell-menu-more', '›'))
        entry.addEventListener('click', () => { stack.push({ title: item.label, items: item.children! }); render('forward'); focusFirst() })
      } else {
        entry.addEventListener('click', () => {
          popover.close(true)
          item.action?.()
        })
      }
      list.append(entry)
    }
    popover.body.replaceChildren(list)
    popover.reposition()
  }

  function buttons() {
    return [...popover.body.querySelectorAll<HTMLButtonElement>('.shell-menu-item:not(:disabled)')]
  }
  function focusFirst() {
    const first = buttons().find((node) => !node.classList.contains('shell-menu-back')) ?? buttons()[0]
    first?.focus({ preventScroll: true })
  }

  popover.layer.addEventListener('keydown', (event) => {
    const list = buttons()
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    const move = (to: number) => list[(to + list.length) % list.length]?.focus({ preventScroll: true })
    if (event.key === 'ArrowDown') move(index + 1)
    else if (event.key === 'ArrowUp') move(index - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(list.length - 1)
    else if (event.key === 'ArrowRight' && (document.activeElement as HTMLElement)?.getAttribute('aria-haspopup')) (document.activeElement as HTMLElement).click()
    else if ((event.key === 'ArrowLeft' || event.key === 'Escape') && stack.length > 1) { stack.pop(); render('back'); focusFirst() }
    else if (event.key === 'Tab') popover.close(false)
    else return
    event.preventDefault()
    event.stopPropagation()
  })

  anchor.addEventListener('mousedown', (event) => event.preventDefault())
  anchor.addEventListener('click', () => {
    if (popover.isOpen()) { popover.close(true); return }
    stack.length = 0
    stack.push({ title: label, items })
    render()
    popover.open(false)
    focusFirst()
  })
  anchor.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' || popover.isOpen()) return
    event.preventDefault()
    anchor.click()
  })
  return popover
}
