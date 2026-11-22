import { bounds, selectedNodes } from './geometry'
import { isStoryScene } from './model'
import type { Point, StoryEdge, StoryScene, StoryWork } from './model'

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
  let changed = true
  while (changed) {
    changed = false
    for (const edge of scene.edges) {
      if (!edges.has(edge.id) && ids.has(edge.from.nodeId) && ('nodeId' in edge.to ? ids.has(edge.to.nodeId) : edges.has(edge.to.edgeId))) {
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
  const box = bounds(source.nodes)
  const offset = box ? { x: center.x - box.x - box.width / 2 + 20, y: center.y - box.y - box.height / 2 + 20 } : { x: 0, y: 0 }
  const nodes = source.nodes.map((node) => {
    const next = { ...node, id: mapping.get(node.id)!, x: node.x + offset.x, y: node.y + offset.y }
    if (next.kind === 'card') {
      next.tagIds = next.tagIds.map((id) => mapping.get(id)!)
      if (!same) { next.chapters = []; next.states = [] }
    }
    return next
  })
  const liveNodes = new Set([...existing.nodes, ...nodes].map(({ id }) => id))
  const edges: StoryEdge[] = source.edges.map((edge) => ({
    ...edge, id: mapping.get(edge.id)!,
    from: { ...edge.from, nodeId: mapping.get(edge.from.nodeId) ?? edge.from.nodeId },
    to: 'nodeId' in edge.to
      ? { ...edge.to, nodeId: mapping.get(edge.to.nodeId) ?? edge.to.nodeId }
      : { ...edge.to, edgeId: mapping.get(edge.to.edgeId) ?? edge.to.edgeId },
  }))
  const allowedNodes = same ? liveNodes : new Set(nodes.map(({ id }) => id))
  const originalEdges = same ? new Set(existing.edges.map(({ id }) => id)) : new Set<string>()
  const missing = new Set(edges.filter((edge) => !allowedNodes.has(edge.from.nodeId) ||
    ('nodeId' in edge.to && !allowedNodes.has(edge.to.nodeId))).map(({ id }) => id))
  const edgeIds = new Set(edges.map(({ id }) => id))
  for (const edge of edges) {
    if ('edgeId' in edge.to && !edgeIds.has(edge.to.edgeId) && !originalEdges.has(edge.to.edgeId)) missing.add(edge.id)
  }
  const imported = remainingStoryEdges(edges, missing, new Set())
  return { nodes, edges: imported, tags }
}

export function remainingStoryEdges(edges: StoryEdge[], removed: Set<string>, nodes: ReadonlySet<string>) {
  const dependents = new Map<string, string[]>()
  for (const edge of edges) {
    if (nodes.has(edge.from.nodeId) || ('nodeId' in edge.to && nodes.has(edge.to.nodeId))) removed.add(edge.id)
    if ('edgeId' in edge.to) {
      const list = dependents.get(edge.to.edgeId) ?? []
      list.push(edge.id)
      dependents.set(edge.to.edgeId, list)
    }
  }
  for (const id of removed) for (const dependent of dependents.get(id) ?? []) removed.add(dependent)
  return edges.filter((edge) => !removed.has(edge.id))
}
