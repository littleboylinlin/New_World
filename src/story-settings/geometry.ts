import { maxZoom, minZoom } from './model'
import type { NodeEndpoint, Point, Rect, StoryEdge, StoryNode, StoryScene, StoryView } from './model'

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
export const pointAt = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
export const worldPoint = (point: Point, view: StoryView): Point => ({ x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom })

export function zoomAt(view: StoryView, point: Point, zoom: number): StoryView {
  zoom = clamp(zoom, minZoom, maxZoom)
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

export function selectedNodes(nodes: StoryNode[], selected: ReadonlySet<string>) {
  const groups = nodes.filter((node) => selected.has(node.id) && node.kind === 'group')
  return nodes.filter((node) => selected.has(node.id) || groups.some((group) => contains(group, node)))
}

export function port(node: Rect, side: NodeEndpoint['side']): Point {
  switch (side) {
    case 'left': return { x: node.x, y: node.y + node.height / 2 }
    case 'right': return { x: node.x + node.width, y: node.y + node.height / 2 }
    case 'top': return { x: node.x + node.width / 2, y: node.y }
    case 'bottom': return { x: node.x + node.width / 2, y: node.y + node.height }
  }
}

export function nearestPort(node: Rect, point: Point) {
  const sides = ['left', 'right', 'top', 'bottom'] as const
  const distance = (side: NodeEndpoint['side']) => {
    const end = port(node, side)
    return Math.hypot(end.x - point.x, end.y - point.y)
  }
  return sides.reduce((best, side) => distance(side) < distance(best) ? side : best)
}

export interface Segment { from: Point; to: Point }

export function visibleLineCenter({ from, to }: Segment, width: number, height: number) {
  let start = 0, end = 1
  for (const [a, b, limit] of [[from.x, to.x, width], [from.y, to.y, height]]) {
    if (a === b) {
      if (a < 0 || a > limit) return
      continue
    }
    const first = -a / (b - a), last = (limit - a) / (b - a)
    start = Math.max(start, Math.min(first, last))
    end = Math.min(end, Math.max(first, last))
  }
  if (start <= end) return pointAt(from, to, (start + end) / 2)
}

export function fractionOf({ from, to }: Segment, point: Point) {
  const dx = to.x - from.x, dy = to.y - from.y
  return clamp(((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy || 1), 0, 1)
}

/** Resolve line-to-line anchors after both endpoints of the target line have been located. */
export function storySegments(scene: StoryScene, rect: (node: StoryNode) => Rect = (node) => node) {
  const nodes = new Map(scene.nodes.map((node) => [node.id, rect(node)]))
  const edges = new Map(scene.edges.map((edge) => [edge.id, edge]))
  const resolved = new Map<string, Segment | undefined>()
  const nodePort = (endpoint: NodeEndpoint) => {
    const node = nodes.get(endpoint.nodeId)
    return node && port(node, endpoint.side)
  }
  function resolve(edge: StoryEdge, target?: Segment) {
    const from = nodePort(edge.from)
    const to = 'nodeId' in edge.to ? nodePort(edge.to) : target && pointAt(target.from, target.to, edge.to.at)
    return from && to ? { from, to } : undefined
  }
  for (const edge of scene.edges) {
    const chain: StoryEdge[] = []
    let next: StoryEdge | undefined = edge
    // The model rejects line cycles before loading a scene.
    while (next && !resolved.has(next.id)) {
      chain.push(next)
      next = 'edgeId' in next.to ? edges.get(next.to.edgeId) : undefined
    }
    let target = next && resolved.get(next.id)
    for (const item of chain.reverse()) {
      target = resolve(item, target)
      resolved.set(item.id, target)
    }
  }
  return resolved
}
