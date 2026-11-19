// The arrangement of a split view as a tree: each leaf is a pane, each branch lays its children
// out in a row (side by side) or a column (one above another) with fractional sizes. Kept free of
// the DOM so the rules (where a pane goes, what a removal does, what still fits) are easy to check.

export type Side = 'left' | 'right' | 'top' | 'bottom'
export type Direction = 'row' | 'column'
export type SplitTree = { pane: string } | { dir: Direction; sizes: number[]; children: SplitTree[] }
export type Branch = Extract<SplitTree, { dir: Direction }>

/** Where a new pane goes: beside one pane, or (target null) along an outer edge of the whole view. */
export interface Zone { target: string | null; side: Side }

export interface Rect { left: number; top: number; width: number; height: number }

export interface Divider {
  /** Child indexes from the root down to the branch the divider belongs to. */
  path: number[]
  /** The divider sits after this child of that branch. */
  index: number
  dir: Direction
  rect: Rect
  /** The space the two neighbouring children share, along the branch's direction. */
  span: number
  /** How far the divider sits from the start of that shared space. */
  offset: number
}

export const isBranch = (tree: SplitTree): tree is Branch => 'dir' in tree

export function paneIds(tree: SplitTree): string[] {
  return isBranch(tree) ? tree.children.flatMap(paneIds) : [tree.pane]
}

const directionOf = (side: Side): Direction => side === 'left' || side === 'right' ? 'row' : 'column'
const before = (side: Side) => side === 'left' || side === 'top'

function normalize(sizes: number[]) {
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1
  return sizes.map((size) => size / total)
}

/** Joins branches that ended up inside a branch of the same direction, keeping every pane's share. */
function flatten(tree: SplitTree): SplitTree {
  if (!isBranch(tree)) return tree
  const children: SplitTree[] = []
  const sizes: number[] = []
  tree.children.forEach((raw, index) => {
    const child = flatten(raw)
    if (isBranch(child) && child.dir === tree.dir) {
      child.children.forEach((inner, i) => { children.push(inner); sizes.push(child.sizes[i] * tree.sizes[index]) })
    } else { children.push(child); sizes.push(tree.sizes[index]) }
  })
  if (children.length === 1) return children[0]
  return { dir: tree.dir, sizes: normalize(sizes), children }
}

/** The tree with a new pane put in the zone: the target's space is halved between the two. */
export function insertPane(tree: SplitTree, id: string, zone: Zone): SplitTree {
  const dir = directionOf(zone.side)
  const leaf: SplitTree = { pane: id }
  if (zone.target === null) {
    return flatten({ dir, sizes: [.5, .5], children: before(zone.side) ? [leaf, tree] : [tree, leaf] })
  }
  const target = zone.target
  function visit(node: SplitTree): SplitTree {
    if (!isBranch(node)) {
      if (node.pane !== target) return node
      return { dir, sizes: [.5, .5], children: before(zone.side) ? [leaf, node] : [node, leaf] }
    }
    return { dir: node.dir, sizes: [...node.sizes], children: node.children.map(visit) }
  }
  return flatten(visit(tree))
}

/** The tree without the pane; its space goes to the neighbours. Undefined when nothing is left. */
export function removePane(tree: SplitTree, id: string): SplitTree | undefined {
  function visit(node: SplitTree): SplitTree | undefined {
    if (!isBranch(node)) return node.pane === id ? undefined : node
    const children: SplitTree[] = []
    const sizes: number[] = []
    node.children.forEach((child, index) => {
      const kept = visit(child)
      if (kept) { children.push(kept); sizes.push(node.sizes[index]) }
    })
    if (!children.length) return undefined
    return { dir: node.dir, sizes: normalize(sizes), children }
  }
  const result = visit(tree)
  return result && flatten(result)
}

/** Every pane's rectangle and every divider, for a view of the given size. */
export function computeLayout(tree: SplitTree, width: number, height: number) {
  const panes = new Map<string, Rect>()
  const dividers: Divider[] = []
  function visit(node: SplitTree, rect: Rect, path: number[]) {
    if (!isBranch(node)) { panes.set(node.pane, rect); return }
    const row = node.dir === 'row'
    const total = row ? rect.width : rect.height
    let offset = 0
    node.children.forEach((child, index) => {
      const start = Math.round(offset)
      offset += node.sizes[index] * total
      const end = index === node.children.length - 1 ? total : Math.round(offset)
      const part: Rect = row
        ? { left: rect.left + start, top: rect.top, width: end - start, height: rect.height }
        : { left: rect.left, top: rect.top + start, width: rect.width, height: end - start }
      visit(child, part, [...path, index])
      if (index < node.children.length - 1) {
        const span = (node.sizes[index] + node.sizes[index + 1]) * total
        dividers.push({
          path, index, dir: node.dir, span, offset: node.sizes[index] * total,
          rect: row ? { left: rect.left + end, top: rect.top, width: 0, height: rect.height } : { left: rect.left, top: rect.top + end, width: rect.width, height: 0 },
        })
      }
    })
  }
  visit(tree, { left: 0, top: 0, width, height }, [])
  return { panes, dividers }
}

/** Whether every pane keeps at least the minimum size. */
export function fits(tree: SplitTree, width: number, height: number, minWidth: number, minHeight: number) {
  for (const rect of computeLayout(tree, width, height).panes.values()) {
    if (rect.width < minWidth - .5 || rect.height < minHeight - .5) return false
  }
  return true
}

function branchAt(tree: SplitTree, path: number[]) {
  let node = tree
  for (const index of path) { if (!isBranch(node)) return undefined; node = node.children[index] }
  return isBranch(node) ? node : undefined
}

/** The smallest share a child may have so that each pane inside it keeps the minimum size. */
function least(node: SplitTree, dir: Direction, min: number): number {
  if (!isBranch(node)) return min
  if (node.dir === dir) return node.children.reduce((sum, child) => sum + least(child, dir, min), 0)
  return Math.max(...node.children.map((child) => least(child, dir, min)))
}

/**
 * Moves the divider after child `index` of the branch at `path` to `position` pixels from the start
 * of the two children it separates. Each side keeps room for its panes' minimum size.
 */
export function moveDivider(tree: SplitTree, path: number[], index: number, position: number, span: number, minWidth: number, minHeight: number): SplitTree {
  const copy = structuredClone(tree) as SplitTree
  const branch = branchAt(copy, path)
  if (!branch || index < 0 || index >= branch.children.length - 1 || span <= 0) return tree
  const min = branch.dir === 'row' ? minWidth : minHeight
  const share = branch.sizes[index] + branch.sizes[index + 1]
  const low = least(branch.children[index], branch.dir, min)
  const high = span - least(branch.children[index + 1], branch.dir, min)
  if (high < low) return tree
  const at = Math.max(low, Math.min(high, position))
  branch.sizes[index] = share * at / span
  branch.sizes[index + 1] = share - branch.sizes[index]
  return copy
}

/** Reads a stored tree, or nothing when it is malformed. */
export function readTree(raw: unknown, depth = 0): SplitTree | undefined {
  if (!raw || typeof raw !== 'object' || depth > 8) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.pane === 'string' && value.pane) return { pane: value.pane }
  if ((value.dir !== 'row' && value.dir !== 'column') || !Array.isArray(value.children) || !Array.isArray(value.sizes)) return undefined
  if (value.children.length < 2 || value.children.length !== value.sizes.length) return undefined
  const sizes = value.sizes.map(Number)
  if (sizes.some((size) => !Number.isFinite(size) || size <= 0)) return undefined
  const children = value.children.map((child) => readTree(child, depth + 1))
  if (children.some((child) => !child)) return undefined
  const tree: SplitTree = { dir: value.dir, sizes: normalize(sizes), children: children as SplitTree[] }
  const ids = paneIds(tree)
  return new Set(ids).size === ids.length ? flatten(tree) : undefined
}

/** Picks the zone under a point of a pane: the side whose edge is nearest, measured in proportion. */
export function sideAt(rect: Rect, x: number, y: number): Side {
  const fx = (x - rect.left) / Math.max(1, rect.width)
  const fy = (y - rect.top) / Math.max(1, rect.height)
  const distances: [Side, number][] = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]]
  return distances.sort((a, b) => a[1] - b[1])[0][0]
}

/** The rectangle a new pane would get in the zone (before the minimum sizes are checked). */
export function zoneRect(tree: SplitTree, zone: Zone, width: number, height: number, probe = '\u0000probe') {
  return computeLayout(insertPane(tree, probe, zone), width, height).panes.get(probe)!
}
