import type { ShellMenuItem } from './popover'
import './shell.css'

export interface ToolbarItem {
  id: string
  node: HTMLElement
  /** Higher numbers stay on the bar longer; the lowest is the first to move into "⋯". */
  priority: number
  /** Items of one group share a divider, which hides with the last of them. */
  group?: string
  /** What the item becomes inside "⋯" once it no longer fits. Nothing means it is just dropped. */
  menu?: () => ShellMenuItem[]
}

/**
 * A single-row bar that never wraps or scrolls: when it runs out of room, items leave one by one
 * from the lowest priority and the caller lists them in its "⋯" menu instead.
 */
export function priorityToolbar(row: HTMLElement, onChange?: () => void) {
  const items: ToolbarItem[] = []
  const unavailable = new Set<string>()
  const collapsed = new Set<string>()
  const overflowed = new Set<string>()
  const dividers = new Map<string, HTMLElement>()
  let frame = 0
  let laying = false

  function fits() {
    return row.scrollWidth <= row.clientWidth + .5
  }

  function paintDividers() {
    for (const [group, divider] of dividers) {
      divider.hidden = !items.some((item) => item.group === group && !item.node.hidden)
    }
  }

  function layout() {
    frame = 0
    if (laying || !row.isConnected) return
    laying = true
    const before = [...overflowed].join()
    overflowed.clear()
    for (const item of items) {
      item.node.hidden = unavailable.has(item.id) || collapsed.has(item.id)
      if (collapsed.has(item.id) && !unavailable.has(item.id)) overflowed.add(item.id)
    }
    paintDividers()
    const queue = items.filter((item) => !item.node.hidden).sort((a, b) => a.priority - b.priority)
    while (!fits() && queue.length) {
      const item = queue.shift()!
      item.node.hidden = true
      overflowed.add(item.id)
      paintDividers()
    }
    laying = false
    if (before !== [...overflowed].join()) onChange?.()
  }

  const schedule = () => { if (!frame) frame = requestAnimationFrame(layout) }
  const observer = new ResizeObserver(schedule)
  observer.observe(row)

  return {
    add(item: ToolbarItem) {
      items.push(item)
      schedule()
      return item.node
    },
    divider(group: string, node: HTMLElement) {
      dividers.set(group, node)
      return node
    },
    /** Hides an item for reasons other than room (a mode change); it then never shows in "⋯". */
    setAvailable(id: string, available: boolean) {
      if (available) unavailable.delete(id)
      else unavailable.add(id)
      layout()
    },
    /** Folds items into "⋯" whatever the room, as when the formatting tools are tucked away. */
    setCollapsed(ids: string[], on: boolean) {
      for (const id of ids) { if (on) collapsed.add(id); else collapsed.delete(id) }
      layout()
    },
    /** Menu entries for the items that did not fit, in the order they sit on the bar. */
    overflowMenu(): ShellMenuItem[] {
      return items.filter((item) => overflowed.has(item.id) && item.menu).flatMap((item) => item.menu!())
    },
    isOverflowed: (id: string) => overflowed.has(id),
    layout,
    destroy() { observer.disconnect(); cancelAnimationFrame(frame) },
  }
}
