import { bounds, curveTangent, selectedNodes, storyEdgePaths } from './geometry'
import type { EdgePath } from './geometry'
import { isEdgeEnd, isNodeEnd } from './model'
import type { Rect, StoryEdge, StoryNode, StoryScene } from './model'

/** Resolves a CSS colour, including color-mix(), to something a 2D canvas understands. */
function resolve(color: string) {
  const probe = document.createElement('span')
  probe.style.color = color
  probe.style.display = 'none'
  document.body.append(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  return value
}

function wrap(context: CanvasRenderingContext2D, text: string, width: number, lines: number) {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const char of paragraph) {
      if (context.measureText(line + char).width > width && line) {
        out.push(line)
        line = char
        if (out.length >= lines) break
      } else line += char
    }
    if (out.length >= lines) break
    out.push(line)
    if (out.length >= lines) break
  }
  if (out.length >= lines && text.length > out.join('').length) out[lines - 1] = out[lines - 1].slice(0, -1) + '…'
  return out.slice(0, lines)
}

function rounded(context: CanvasRenderingContext2D, rect: Rect, radius: number) {
  context.beginPath()
  context.roundRect(rect.x, rect.y, rect.width, rect.height, radius)
}

function loadImage(src: string) {
  const image = new Image()
  image.src = src
  return image.decode().then(() => image, () => undefined)
}

/** The part of the board to export: the selection with arrows between its objects, or everything. */
export function exportedScene(scene: StoryScene, selection?: ReadonlySet<string>) {
  if (!selection?.size) return { nodes: scene.nodes, edges: scene.edges }
  const nodes = selectedNodes(scene.nodes, selection)
  const ids = new Set(nodes.map(({ id }) => id))
  const edges = scene.edges.filter((edge) => selection.has(edge.id)
    || [edge.from, edge.to].every((end) => isNodeEnd(end) ? ids.has(end.nodeId) : !isEdgeEnd(end) || selection.has(end.edgeId)))
  return { nodes, edges }
}

/** Draws the board, or the selected part of it, to a PNG in the current theme's colours. */
export async function storyImage(scene: StoryScene, selection?: ReadonlySet<string>, font = 'system-ui, sans-serif') {
  const part = exportedScene(scene, selection)
  const paths = storyEdgePaths(scene)
  const visible = part.edges.flatMap((edge) => { const path = paths.get(edge.id); return path ? [{ edge, path }] : [] })
  const box = bounds([...part.nodes, ...visible.flatMap(({ path }) => [path.from, path.to, path.mid].map((point) => ({ ...point, width: 0, height: 0 })))])
  if (!box) return
  const pad = 40
  const area = { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 }
  const scale = Math.min(2, 16_000 / Math.max(area.width, area.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(area.width * scale)
  canvas.height = Math.ceil(area.height * scale)
  const context = canvas.getContext('2d')!
  context.scale(scale, scale)
  context.translate(-area.x, -area.y)
  const color = {
    surface: resolve('var(--surface)'), card: resolve('var(--surface-card)'), ink: resolve('var(--ink)'), muted: resolve('var(--muted)'),
    line: resolve('var(--surface-line-strong)'), text: resolve('color-mix(in srgb, var(--yellow) 13%, var(--surface-card))'),
    group: resolve('color-mix(in srgb, var(--blue) 6%, var(--surface))'), groupLine: resolve('color-mix(in srgb, var(--blue) 55%, var(--surface-line-strong))'),
  }
  context.fillStyle = color.surface
  context.fillRect(area.x, area.y, area.width, area.height)
  const images = new Map(await Promise.all(part.nodes.flatMap((node) => node.kind === 'image' ? [loadImage(node.src).then((image) => [node.id, image] as const)] : [])))

  const drawNode = (node: StoryNode) => {
    context.save()
    context.lineWidth = 1.5
    if (node.kind === 'group') {
      rounded(context, node, 10)
      context.fillStyle = color.group
      context.strokeStyle = color.groupLine
      context.fill()
      context.stroke()
      context.fillStyle = color.ink
      context.font = `600 14px ${font}`
      context.fillText(wrap(context, node.name, node.width - 24, 1)[0] ?? '', node.x + 12, node.y + 22)
    } else if (node.kind === 'image') {
      const image = images.get(node.id)
      if (image) {
        const ratio = Math.min(node.width / image.naturalWidth, node.height / image.naturalHeight)
        const width = image.naturalWidth * ratio, height = image.naturalHeight * ratio
        context.drawImage(image, node.x + (node.width - width) / 2, node.y + (node.height - height) / 2, width, height)
      }
    } else if (node.kind === 'text') {
      rounded(context, node, 10)
      context.fillStyle = color.text
      context.fill()
      context.fillStyle = color.ink
      context.font = `14px ${font}`
      wrap(context, node.text, node.width - 24, Math.max(1, Math.floor((node.height - 16) / 20))).forEach((line, index) => context.fillText(line, node.x + 12, node.y + 26 + index * 20))
    } else {
      rounded(context, node, 10)
      context.fillStyle = color.card
      context.strokeStyle = color.line
      context.fill()
      context.stroke()
      const tag = scene.tags.find(({ id }) => id === node.tagIds[0])
      if (tag) {
        context.save()
        rounded(context, node, 10)
        context.clip()
        context.fillStyle = tag.color
        context.fillRect(node.x, node.y, node.width, 6)
        context.restore()
      }
      context.fillStyle = color.ink
      context.font = `700 17px ${font}`
      context.fillText(wrap(context, node.name, node.width - 28, 1)[0] ?? '', node.x + 14, node.y + 34)
      let top = node.y + 56
      context.fillStyle = color.muted
      if (node.aliases.length) {
        context.font = `12px ${font}`
        context.fillText(wrap(context, node.aliases.join('、'), node.width - 28, 1)[0] ?? '', node.x + 14, top)
        top += 20
      }
      context.font = `13px ${font}`
      const rows = Math.max(0, Math.floor((node.y + node.height - top) / 19))
      wrap(context, node.body.trim(), node.width - 28, Math.min(2, rows)).forEach((line, index) => context.fillText(line, node.x + 14, top + index * 19))
    }
    context.restore()
  }

  const drawEdge = (edge: StoryEdge, path: EdgePath) => {
    context.save()
    context.strokeStyle = context.fillStyle = edge.color
    context.lineWidth = 2.5
    context.lineCap = 'round'
    context.setLineDash(edge.stroke === 'dash' ? [8, 6] : edge.stroke === 'dot' ? [.01, 6] : [])
    context.beginPath()
    context.moveTo(path.from.x, path.from.y)
    context.quadraticCurveTo(path.control.x, path.control.y, path.to.x, path.to.y)
    context.stroke()
    context.setLineDash([])
    const head = (tip: { x: number; y: number }, direction: { x: number; y: number }) => {
      const base = { x: tip.x - direction.x * 14, y: tip.y - direction.y * 14 }
      context.beginPath()
      context.moveTo(tip.x, tip.y)
      context.lineTo(base.x - direction.y * 6.3, base.y + direction.x * 6.3)
      context.lineTo(base.x + direction.y * 6.3, base.y - direction.x * 6.3)
      context.closePath()
      context.fill()
    }
    if (edge.direction === 'forward' || edge.direction === 'both') head(path.to, curveTangent(path, 1))
    if (edge.direction === 'back' || edge.direction === 'both') { const t = curveTangent(path, 0); head(path.from, { x: -t.x, y: -t.y }) }
    if (edge.name) {
      context.font = `700 14px ${font}`
      const width = context.measureText(edge.name).width + 12
      context.fillStyle = color.surface
      context.fillRect(path.mid.x - width / 2, path.mid.y - 11, width, 22)
      context.fillStyle = color.ink
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(edge.name, path.mid.x, path.mid.y)
    }
    context.restore()
  }

  for (const node of part.nodes) if (node.kind === 'group') drawNode(node)
  for (const { edge, path } of visible) drawEdge(edge, path)
  for (const node of part.nodes) if (node.kind !== 'group') drawNode(node)
  return new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'))
}
