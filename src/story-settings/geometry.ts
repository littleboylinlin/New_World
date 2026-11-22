// Pure geometry: no runtime imports, so it also runs in the unit tests.
// The arrow binding distance and gap and the point snapping with alignment guides are adapted
// from Excalidraw (MIT License, Copyright (c) 2020 Excalidraw); see ./Excalidraw-MIT.txt.
import type { EdgeEndpoint, NodeEndpoint, Point, Rect, StoryEdge, StoryEndpoint, StoryNode, StoryScene, StoryView } from './model'

const isNodeEnd = (end: StoryEndpoint): end is NodeEndpoint => 'nodeId' in end
const isEdgeEnd = (end: StoryEndpoint): end is EdgeEndpoint => 'edgeId' in end

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
export const pointAt = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
export const worldPoint = (point: Point, view: StoryView): Point => ({ x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom })
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
export const center = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })

/** Zooms about a screen point, keeping the canvas point under it in place. */
export function zoomAt(view: StoryView, point: Point, zoom: number, limits: { min: number; max: number }): StoryView {
  zoom = clamp(zoom, limits.min, limits.max)
  const origin = worldPoint(point, view)
  return { zoom, x: point.x - origin.x * zoom, y: point.y - origin.y * zoom }
}

export function bounds(rects: readonly Rect[]): Rect | undefined {
  if (!rects.length) return
  let { x, y, width, height } = rects[0]
  let right = x + width
  let bottom = y + height
  for (const rect of rects) {
    x = Math.min(x, rect.x)
    y = Math.min(y, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  return { x, y, width: right - x, height: bottom - y }
}

export function contains(outer: Rect, inner: Rect) {
  return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width
    && outer.y + outer.height >= inner.y + inner.height
}

export function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

export function selectedNodes(nodes: StoryNode[], selected: ReadonlySet<string>) {
  const groups = nodes.filter((node) => selected.has(node.id) && node.kind === 'group')
  return nodes.filter((node) => selected.has(node.id) || groups.some((group) => contains(group, node)))
}

/** Distance from a point to a rectangle, 0 inside it. */
export function rectDistance(rect: Rect, point: Point) {
  const dx = Math.max(rect.x - point.x, 0, point.x - rect.x - rect.width)
  const dy = Math.max(rect.y - point.y, 0, point.y - rect.y - rect.height)
  return Math.hypot(dx, dy)
}

/**
 * Where the ray from the middle of a rectangle towards a point leaves the rectangle grown by `gap`.
 * Used to glue an arrow end to the outline of a card, whatever its size or position.
 */
export function borderPoint(rect: Rect, toward: Point, gap: number): Point {
  const mid = center(rect)
  let dx = toward.x - mid.x, dy = toward.y - mid.y
  if (!dx && !dy) dx = 1
  const halfW = rect.width / 2 + gap, halfH = rect.height / 2 + gap
  const scale = Math.min(dx ? halfW / Math.abs(dx) : Infinity, dy ? halfH / Math.abs(dy) : Infinity)
  return { x: mid.x + dx * scale, y: mid.y + dy * scale }
}

/** A quadratic curve; `mid` is the point at t = .5 and the handle the user drags to bend it. */
export interface EdgePath { from: Point; to: Point; control: Point; mid: Point }

export function curveAt({ from, to, control }: EdgePath, t: number): Point {
  const u = 1 - t
  return { x: u * u * from.x + 2 * u * t * control.x + t * t * to.x, y: u * u * from.y + 2 * u * t * control.y + t * t * to.y }
}

/** The curve's direction at t, as a unit vector. */
export function curveTangent({ from, to, control }: EdgePath, t: number): Point {
  const x = 2 * (1 - t) * (control.x - from.x) + 2 * t * (to.x - control.x)
  const y = 2 * (1 - t) * (control.y - from.y) + 2 * t * (to.y - control.y)
  const length = Math.hypot(x, y) || 1
  return { x: x / length, y: y / length }
}

export function nearestOnCurve(path: EdgePath, point: Point) {
  let best = { t: 0, distance: Infinity }
  const steps = 48
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const gap = distance(curveAt(path, t), point)
    if (gap < best.distance) best = { t, distance: gap }
  }
  // Refine between the neighbouring samples.
  let low = Math.max(0, best.t - 1 / steps), high = Math.min(1, best.t + 1 / steps)
  for (let i = 0; i < 18; i++) {
    const a = low + (high - low) / 3, b = high - (high - low) / 3
    if (distance(curveAt(path, a), point) < distance(curveAt(path, b), point)) high = b
    else low = a
  }
  const t = (low + high) / 2
  return { t, point: curveAt(path, t), distance: distance(curveAt(path, t), point) }
}

/** A curve through `from` and `to` whose middle sits `bend` away from the straight line. */
export function bentPath(from: Point, to: Point, bend: number): EdgePath {
  const length = distance(from, to) || 1
  const normal = { x: -(to.y - from.y) / length, y: (to.x - from.x) / length }
  const mid = { x: (from.x + to.x) / 2 + normal.x * bend, y: (from.y + to.y) / 2 + normal.y * bend }
  return { from, to, mid, control: { x: 2 * mid.x - (from.x + to.x) / 2, y: 2 * mid.y - (from.y + to.y) / 2 } }
}

/** The signed bend that puts the curve's middle at `point`. */
export function bendThrough(from: Point, to: Point, point: Point) {
  const length = distance(from, to) || 1
  return ((point.x - (from.x + to.x) / 2) * -(to.y - from.y) + (point.y - (from.y + to.y) / 2) * (to.x - from.x)) / length
}

// Glued arrow ends keep this much air from the outline (after Excalidraw's BASE_BINDING_GAP).
export const bindingGap = 5

/**
 * Resolves every arrow to a curve. Ends glued to a node sit on its outline, facing the other end, so
 * they follow the node when it moves or resizes. Ends glued to another arrow wait for that arrow.
 */
export function storyEdgePaths(scene: StoryScene, rect: (node: StoryNode) => Rect = (node) => node) {
  const nodes = new Map(scene.nodes.map((node) => [node.id, rect(node)]))
  const edges = new Map(scene.edges.map((edge) => [edge.id, edge]))
  const resolved = new Map<string, EdgePath | undefined>()
  const pending = new Set<string>()
  function anchor(end: StoryEndpoint): Point | undefined {
    if (isNodeEnd(end)) { const box = nodes.get(end.nodeId); return box && center(box) }
    if (isEdgeEnd(end)) { const path = edgeOf(end.edgeId); return path && curveAt(path, end.at) }
    return end
  }
  function edgeOf(id: string): EdgePath | undefined {
    if (resolved.has(id)) return resolved.get(id)
    const edge = edges.get(id)
    if (!edge || pending.has(id)) return
    pending.add(id)
    const path = resolve(edge)
    pending.delete(id)
    resolved.set(id, path)
    return path
  }
  function resolve(edge: StoryEdge) {
    const a = anchor(edge.from), b = anchor(edge.to)
    if (!a || !b) return
    const rough = bentPath(a, b, edge.bend)
    const glue = (end: StoryEndpoint, point: Point) => {
      const box = isNodeEnd(end) ? nodes.get(end.nodeId) : undefined
      return box ? borderPoint(box, rough.control, bindingGap) : point
    }
    return bentPath(glue(edge.from, a), glue(edge.to, b), edge.bend)
  }
  for (const edge of scene.edges) edgeOf(edge.id)
  return resolved
}

/** The SVG path data of a curve, optionally shortened at either end to leave room for an arrowhead. */
export function pathData(path: EdgePath, trimStart = 0, trimEnd = 0) {
  const start = trimStart ? moveAlong(path.from, path.control, trimStart) : path.from
  const end = trimEnd ? moveAlong(path.to, path.control, trimEnd) : path.to
  const r = (value: number) => Math.round(value * 100) / 100
  return `M ${r(start.x)} ${r(start.y)} Q ${r(path.control.x)} ${r(path.control.y)} ${r(end.x)} ${r(end.y)}`
}

function moveAlong(point: Point, toward: Point, amount: number): Point {
  const length = distance(point, toward)
  if (!length) return point
  const step = Math.min(amount, length * .5) / length
  return { x: point.x + (toward.x - point.x) * step, y: point.y + (toward.y - point.y) * step }
}

/** Offsets the next parallel arrow between two nodes so arrows never lie on top of each other. */
export function freeBend(used: readonly number[], spacing = 48) {
  for (let step = 0; ; step++) {
    for (const sign of step ? [1, -1] : [1]) {
      const bend = sign * step * spacing
      if (used.every((other) => Math.abs(other - bend) > spacing / 2)) return bend
    }
  }
}

export interface Guide { axis: 'x' | 'y'; at: number; from: number; to: number }

const xs = (rect: Rect) => [rect.x, rect.x + rect.width / 2, rect.x + rect.width]
const ys = (rect: Rect) => [rect.y, rect.y + rect.height / 2, rect.y + rect.height]

/**
 * Aligns a moving box with the edges and middles of other boxes. Like Excalidraw's point snapping,
 * it first finds the nearest snap within `threshold` on each axis, then lists the guides at the
 * snapped position so lines never jitter.
 */
export function snapRect(moving: Rect, others: readonly Rect[], threshold: number) {
  let dx = 0, dy = 0, bestX = threshold, bestY = threshold
  for (const other of others) {
    for (const a of xs(moving)) for (const b of xs(other)) if (Math.abs(b - a) <= bestX) { bestX = Math.abs(b - a); dx = b - a }
    for (const a of ys(moving)) for (const b of ys(other)) if (Math.abs(b - a) <= bestY) { bestY = Math.abs(b - a); dy = b - a }
  }
  const snapped = { ...moving, x: moving.x + dx, y: moving.y + dy }
  const guides: Guide[] = []
  for (const other of others) {
    for (const a of xs(snapped)) for (const b of xs(other)) if (Math.abs(a - b) < .5) {
      guides.push({ axis: 'x', at: b, from: Math.min(snapped.y, other.y), to: Math.max(snapped.y + snapped.height, other.y + other.height) })
    }
    for (const a of ys(snapped)) for (const b of ys(other)) if (Math.abs(a - b) < .5) {
      guides.push({ axis: 'y', at: b, from: Math.min(snapped.x, other.x), to: Math.max(snapped.x + snapped.width, other.x + other.width) })
    }
  }
  return { dx, dy, guides }
}

/** Snap distance in canvas units for a zoom level (Excalidraw's SNAP_DISTANCE / zoom). */
export const snapDistance = (zoom: number) => 8 / zoom

/**
 * How far outside an object's outline an arrow end still binds to it, in canvas units. Follows
 * Excalidraw's maxBindingDistance: 15 screen pixels, growing when zoomed out, at most 30.
 * Touch input gets a wider margin for a finger.
 */
export function bindingDistance(zoom: number, coarse = false) {
  const base = coarse ? 24 : 15
  return clamp(base / (Math.min(zoom, 1) * 1.5), base, base * 2) / zoom
}

/** Places a box of `size` beside `target` inside `area`, on the first side with room, without overlap. */
export function placeBeside(target: Rect, size: { width: number; height: number }, area: Rect, gap: number, order: ('top' | 'bottom' | 'left' | 'right')[]) {
  const fits = (rect: Rect) => rect.x >= area.x && rect.y >= area.y && rect.x + rect.width <= area.x + area.width && rect.y + rect.height <= area.y + area.height
  const fit = (rect: Rect): Rect => ({
    ...rect,
    x: clamp(rect.x, area.x, Math.max(area.x, area.x + area.width - rect.width)),
    y: clamp(rect.y, area.y, Math.max(area.y, area.y + area.height - rect.height)),
  })
  const mid = center(target)
  const options: Record<string, Rect> = {
    top: { x: mid.x - size.width / 2, y: target.y - gap - size.height, ...size },
    bottom: { x: mid.x - size.width / 2, y: target.y + target.height + gap, ...size },
    left: { x: target.x - gap - size.width, y: mid.y - size.height / 2, ...size },
    right: { x: target.x + target.width + gap, y: mid.y - size.height / 2, ...size },
  }
  for (const side of order) {
    const rect = fit(options[side])
    if (!overlaps(rect, target) && (fits(options[side]) || fits(rect))) return { rect, side }
  }
  return { rect: fit(options[order[0]]), side: order[0] }
}
