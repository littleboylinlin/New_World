import { t } from '../i18n'
import { afterTransition, motionMs } from '../motion'
import { element } from '../ui'
import { computeLayout, fits, insertPane, isBranch, moveDivider, paneIds, removePane, sideAt, zoneRect } from './split-tree'
import type { Rect, SplitTree, Zone } from './split-tree'
import './shell.css'

export interface SplitViewOptions {
  label: string
  signal: AbortSignal
  /** Smallest pane, in pixels; a drop that would make any pane smaller is not offered. */
  minWidth: number
  minHeight: number
  /** After the user moved a divider, or panes came or went. */
  onLayoutChange?: (tree: SplitTree) => void
  onFocusChange?: (id: string) => void
  /** The view no longer has room for every pane (the window shrank), or has it again. */
  onRoomChange?: (enough: boolean) => void
}

/** How near the view's own edge (in pixels) a drop splits the whole view instead of one pane. */
const outerEdge = 28

/**
 * Panes laid out by a split tree. Panes are positioned absolutely from the tree, so adding,
 * removing or resizing never moves a pane's element in the document (an editor inside keeps its
 * state), and every change can glide with the shared motion tokens.
 */
export function createSplitView(options: SplitViewOptions) {
  const root = element('div', 'split-view')
  root.setAttribute('role', 'group')
  root.setAttribute('aria-label', options.label)
  const dividerLayer = element('div', 'split-dividers')
  root.append(dividerLayer)
  const panes = new Map<string, HTMLElement>()
  let tree: SplitTree | undefined
  let focused = ''
  let settle: (() => void) | undefined
  let roomy = true
  let dragging = false

  const size = () => ({ width: root.clientWidth, height: root.clientHeight })

  function paint(animate: boolean) {
    if (!tree) return
    const { width, height } = size()
    if (!width || !height) return
    const layout = computeLayout(tree, width, height)
    settle?.()
    if (animate && motionMs('slow')) {
      root.dataset.animating = ''
      settle = afterTransition(root, 'slow', () => { settle = undefined; delete root.dataset.animating })
    }
    for (const [id, node] of panes) {
      const rect = layout.panes.get(id)
      node.hidden = !rect
      if (!rect) continue
      // A pane shown for the first time starts at its place; only the panes already there glide.
      const fresh = !node.style.width
      if (fresh) node.style.transition = 'none'
      node.style.left = `${rect.left}px`
      node.style.top = `${rect.top}px`
      node.style.width = `${rect.width}px`
      node.style.height = `${rect.height}px`
      if (fresh) { void node.offsetWidth; node.style.removeProperty('transition') }
    }
    root.toggleAttribute('data-multi', layout.panes.size > 1)
    if (!dragging) paintDividers(layout.dividers)
    const enough = fits(tree, width, height, options.minWidth, options.minHeight)
    if (enough !== roomy) { roomy = enough; options.onRoomChange?.(enough) }
  }

  function paintDividers(dividers: ReturnType<typeof computeLayout>['dividers']) {
    dividerLayer.replaceChildren(...dividers.map((divider) => {
      const handle = element('div', `split-divider split-divider-${divider.dir}`)
      handle.setAttribute('role', 'separator')
      // A row's divider stands upright between panes side by side.
      handle.setAttribute('aria-orientation', divider.dir === 'row' ? 'vertical' : 'horizontal')
      handle.setAttribute('aria-label', t('split.resize'))
      handle.setAttribute('aria-valuemin', '0')
      handle.setAttribute('aria-valuemax', '100')
      handle.setAttribute('aria-valuenow', String(Math.round(divider.offset / divider.span * 100)))
      handle.tabIndex = 0
      handle.dataset.path = divider.path.join('.')
      handle.dataset.index = String(divider.index)
      const { rect } = divider
      if (divider.dir === 'row') {
        handle.style.left = `${rect.left}px`; handle.style.top = `${rect.top}px`; handle.style.height = `${rect.height}px`
      } else {
        handle.style.left = `${rect.left}px`; handle.style.top = `${rect.top}px`; handle.style.width = `${rect.width}px`
      }
      const move = (position: number, save: boolean) => {
        if (!tree) return
        tree = moveDivider(tree, divider.path, divider.index, position, divider.span, options.minWidth, options.minHeight)
        paint(false)
        const now = computeLayout(tree, size().width, size().height).dividers
          .find((other) => other.path.join('.') === divider.path.join('.') && other.index === divider.index)
        if (now) {
          divider.offset = now.offset
          handle.setAttribute('aria-valuenow', String(Math.round(now.offset / now.span * 100)))
          if (divider.dir === 'row') handle.style.left = `${now.rect.left}px`
          else handle.style.top = `${now.rect.top}px`
        }
        if (save) options.onLayoutChange?.(tree)
      }
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        handle.setPointerCapture(event.pointerId)
        dragging = true
        root.dataset.resizing = divider.dir
        const origin = (divider.dir === 'row' ? event.clientX : event.clientY) - divider.offset
        const follow = (next: PointerEvent) => move((divider.dir === 'row' ? next.clientX : next.clientY) - origin, false)
        const end = () => {
          dragging = false
          delete root.dataset.resizing
          handle.removeEventListener('pointermove', follow)
          if (tree) options.onLayoutChange?.(tree)
          paint(false)
        }
        handle.addEventListener('pointermove', follow)
        handle.addEventListener('pointerup', end, { once: true })
        handle.addEventListener('pointercancel', end, { once: true })
      })
      handle.addEventListener('keydown', (event) => {
        const step = event.shiftKey ? 48 : 16
        const back = divider.dir === 'row' ? 'ArrowLeft' : 'ArrowUp'
        const forward = divider.dir === 'row' ? 'ArrowRight' : 'ArrowDown'
        if (event.key === back) move(divider.offset - step, true)
        else if (event.key === forward) move(divider.offset + step, true)
        else return
        event.preventDefault()
        // The dividers were drawn again; keep the keyboard on the same one.
        dividerLayer.querySelector<HTMLElement>(`[data-path="${handle.dataset.path}"][data-index="${handle.dataset.index}"]`)?.focus({ preventScroll: true })
      })
      handle.addEventListener('dblclick', () => move(divider.span / 2, true))
      return handle
    }))
  }

  function setFocused(id: string) {
    if (!panes.has(id) || id === focused) return
    focused = id
    for (const [key, node] of panes) node.toggleAttribute('data-focused', key === id)
    options.onFocusChange?.(id)
  }

  const paneOf = (target: EventTarget | null) => {
    if (!(target instanceof Node)) return undefined
    for (const [id, node] of panes) if (node.contains(target)) return id
  }
  root.addEventListener('pointerdown', (event) => { const id = paneOf(event.target); if (id) setFocused(id) }, { capture: true, signal: options.signal })
  root.addEventListener('focusin', (event) => { const id = paneOf(event.target); if (id) setFocused(id) }, { signal: options.signal })

  const observer = new ResizeObserver(() => paint(false))
  observer.observe(root)
  options.signal.addEventListener('abort', () => { observer.disconnect(); settle?.() }, { once: true })

  function toClient(rect: Rect): Rect {
    const box = root.getBoundingClientRect()
    return { left: box.left + rect.left, top: box.top + rect.top, width: rect.width, height: rect.height }
  }

  return {
    element: root,
    tree: () => tree,
    panes: () => tree ? paneIds(tree) : [],
    focused: () => focused,
    hasRoom: () => roomy,
    focus: setFocused,
    /** Registers a pane's element; it shows once the tree names it. */
    attach(id: string, node: HTMLElement) {
      node.classList.add('split-pane')
      node.dataset.pane = id
      panes.set(id, node)
      if (node.parentElement !== root) root.insertBefore(node, dividerLayer)
    },
    /** Lets go of a pane's element without removing it, for a pane that moves elsewhere. */
    detach(id: string) {
      const node = panes.get(id)
      if (!node) return
      panes.delete(id)
      node.classList.remove('split-pane')
      node.removeAttribute('data-focused')
      for (const key of ['left', 'top', 'width', 'height']) node.style.removeProperty(key)
      node.hidden = false
    },
    setTree(next: SplitTree, animate = false) {
      tree = next
      for (const [id, node] of panes) if (!paneIds(next).includes(id)) node.hidden = true
      if (!panes.has(focused) || !paneIds(next).includes(focused)) {
        const first = paneIds(next)[0]
        focused = ''
        if (first) setFocused(first)
      }
      paint(animate)
    },
    /** Whether the pane fits in the zone without any pane getting smaller than the minimum. */
    canInsert(zone: Zone) {
      if (!tree) return false
      const { width, height } = size()
      return fits(insertPane(tree, '\u0000probe', zone), width, height, options.minWidth, options.minHeight)
    },
    /** The valid zone under a point (in client coordinates), with the rectangle it would take. */
    zoneAt(x: number, y: number): { zone: Zone; rect: Rect } | undefined {
      if (!tree) return undefined
      const box = root.getBoundingClientRect()
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) return undefined
      const { width, height } = size()
      const local = { x: x - box.left, y: y - box.top }
      let zone: Zone | undefined
      if (isBranch(tree)) {
        // Along the view's own edges a drop spans the whole width or height.
        const edges: [Zone['side'], number][] = [['left', local.x], ['right', width - local.x], ['top', local.y], ['bottom', height - local.y]]
        const near = edges.filter(([, distance]) => distance <= outerEdge).sort((a, b) => a[1] - b[1])[0]
        if (near) zone = { target: null, side: near[0] }
      }
      if (!zone) {
        const layout = computeLayout(tree, width, height)
        for (const [id, rect] of layout.panes) {
          if (local.x >= rect.left && local.x <= rect.left + rect.width && local.y >= rect.top && local.y <= rect.top + rect.height) {
            zone = { target: id, side: sideAt(rect, local.x, local.y) }
            break
          }
        }
      }
      if (!zone || !this.canInsert(zone)) return undefined
      return { zone, rect: toClient(zoneRect(tree, zone, width, height)) }
    },
    insert(id: string, zone: Zone, animate = true) {
      if (!tree) return
      tree = insertPane(tree, id, zone)
      paint(animate)
      setFocused(id)
      options.onLayoutChange?.(tree)
    },
    remove(id: string, animate = true) {
      if (!tree) return
      const next = removePane(tree, id)
      if (!next) return
      tree = next
      panes.get(id)?.setAttribute('hidden', '')
      if (focused === id) { focused = ''; setFocused(paneIds(next)[0]) }
      paint(animate)
      options.onLayoutChange?.(tree)
    },
    /** A pane's rectangle in client coordinates. */
    rectOf(id: string) {
      const node = panes.get(id)
      return node && !node.hidden ? node.getBoundingClientRect() : undefined
    },
    relayout: () => paint(false),
  }
}

export type SplitView = ReturnType<typeof createSplitView>
