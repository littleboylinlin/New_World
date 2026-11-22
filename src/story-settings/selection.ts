import { bounds, selectedNodes } from './geometry'
import { isEdgeEnd, isNodeEnd, isStoryScene } from './model'
import type { Point, StoryEdge, StoryEndpoint, StoryScene, StoryWork } from './model'

interface Clip {
  format: 'new-world-story-canvas'
  library: string
  bookId: string
  scene: StoryScene
}

export function copyStorySelection(work: StoryWork, scene: StoryScene, selection: ReadonlySet<string>) {
  const nodes = selectedNodes(scene.nodes, selection)
  const ids = new Set(nodes.map(({ id }) => id))
  const edges = new Set(scene.edges.filter((edge) => selection.has(edge.id)).map((edge) => edge.id))
  // Arrows between copied objects come along; an arrow glued to a copied arrow too.
  const inside = (end: StoryEndpoint) => isNodeEnd(end) ? ids.has(end.nodeId) : isEdgeEnd(end) ? edges.has(end.edgeId) : true
  let changed = true
  while (changed) {
    changed = false
    for (const edge of scene.edges) {
      if (!edges.has(edge.id) && inside(edge.from) && inside(edge.to) && (ids.size || edges.size)
        && [edge.from, edge.to].some((end) => !('x' in end))) {
        edges.add(edge.id)
        changed = true
      }
    }
  }
  if (!nodes.length && !edges.size) return ''
  const tags = new Set(nodes.flatMap((node) => node.kind === 'card' ? node.tagIds : []))
  const clip: Clip = {
    format: 'new-world-story-canvas', ...work,
    scene: { nodes, edges: scene.edges.filter(({ id }) => edges.has(id)), tags: scene.tags.filter(({ id }) => tags.has(id)) },
  }
  return JSON.stringify(clip)
}

export function pasteStorySelection(value: string, work: StoryWork, existing: StoryScene, center: Point) {
  let clip: Clip
  try { clip = JSON.parse(value) } catch { return }
  if (clip?.format !== 'new-world-story-canvas' || !isStoryScene(clip.scene)) return
  const same = clip.library === work.library && clip.bookId === work.bookId
  const source = clip.scene
  const mapping = new Map<string, string>([...source.nodes, ...source.edges].map(({ id }) => [id, crypto.randomUUID()]))
  const tags = [...existing.tags]
  for (const tag of source.tags) {
    const match = tags.find((target) => (same && target.id === tag.id) || (target.name === tag.name && target.color === tag.color))
    const id = match?.id ?? crypto.randomUUID()
    mapping.set(tag.id, id)
    if (!match) tags.push({ ...tag, id })
  }
  const box = bounds([...source.nodes, ...source.edges.flatMap((edge) => [edge.from, edge.to].flatMap((end) => 'x' in end ? [{ ...end, width: 0, height: 0 }] : []))])
  const offset = box ? { x: center.x - box.x - box.width / 2 + 20, y: center.y - box.y - box.height / 2 + 20 } : { x: 20, y: 20 }
  const nodes = source.nodes.map((node) => {
    const next = { ...node, id: mapping.get(node.id)!, x: node.x + offset.x, y: node.y + offset.y }
    if (next.kind === 'card') {
      next.tagIds = next.tagIds.map((id) => mapping.get(id)!)
      if (!same) { next.chapters = []; next.states = [] }
    }
    return next
  })
  const liveNodes = new Set([...existing.nodes, ...nodes].map(({ id }) => id))
  const remap = (end: StoryEndpoint): StoryEndpoint => isNodeEnd(end) ? { nodeId: mapping.get(end.nodeId) ?? end.nodeId }
    : isEdgeEnd(end) ? { ...end, edgeId: mapping.get(end.edgeId) ?? end.edgeId } : { x: end.x + offset.x, y: end.y + offset.y }
  const edges: StoryEdge[] = source.edges.map((edge) => ({ ...edge, id: mapping.get(edge.id)!, from: remap(edge.from), to: remap(edge.to) }))
  const allowedNodes = same ? liveNodes : new Set(nodes.map(({ id }) => id))
  const originalEdges = same ? new Set(existing.edges.map(({ id }) => id)) : new Set<string>()
  const edgeIds = new Set(edges.map(({ id }) => id))
  const missing = new Set(edges.filter((edge) => [edge.from, edge.to].some((end) =>
    (isNodeEnd(end) && !allowedNodes.has(end.nodeId)) || (isEdgeEnd(end) && !edgeIds.has(end.edgeId) && !originalEdges.has(end.edgeId)))).map(({ id }) => id))
  const imported = remainingStoryEdges(edges, missing, new Set())
  return { nodes, edges: imported, tags }
}

export function remainingStoryEdges(edges: StoryEdge[], removed: Set<string>, nodes: ReadonlySet<string>) {
  const dependents = new Map<string, string[]>()
  for (const edge of edges) {
    for (const end of [edge.from, edge.to]) {
      if (isNodeEnd(end) && nodes.has(end.nodeId)) removed.add(edge.id)
      if (isEdgeEnd(end)) {
        const list = dependents.get(end.edgeId) ?? []
        list.push(edge.id)
        dependents.set(end.edgeId, list)
      }
    }
  }
  for (const id of removed) for (const dependent of dependents.get(id) ?? []) removed.add(dependent)
  return edges.filter((edge) => !removed.has(edge.id))
}

/** The bends of arrows already joining two nodes, seen in the from → to orientation. */
export function parallelBends(edges: readonly StoryEdge[], from: string, to: string, except?: string) {
  return edges.flatMap((edge) => {
    if (edge.id === except || !isNodeEnd(edge.from) || !isNodeEnd(edge.to)) return []
    if (edge.from.nodeId === from && edge.to.nodeId === to) return [edge.bend]
    if (edge.from.nodeId === to && edge.to.nodeId === from) return [-edge.bend]
    return []
  })
}

/** An arrow already pointing from one node to the other. */
export function sameRelation(edges: readonly StoryEdge[], from: string, to: string, except?: string) {
  return edges.find((edge) => edge.id !== except && isNodeEnd(edge.from) && isNodeEnd(edge.to)
    && edge.from.nodeId === from && edge.to.nodeId === to)
}
