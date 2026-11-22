import { t } from '../i18n'
import { button, element } from '../ui'
import { canvasToast, cardDetails, inlineEditor } from './canvas-overlays'
import type { InlineEditor } from './canvas-overlays'
import {
  bendThrough, bindingDistance, bounds, center, clamp, contains, curveAt, curveTangent, distance, freeBend, nearestOnCurve,
  overlaps, pathData, placeBeside, rectDistance, selectedNodes, snapDistance, snapRect, storyEdgePaths, worldPoint,
} from './geometry'
import { zoomAt as zoomAtPoint } from './geometry'
import type { EdgePath, Guide } from './geometry'
import { defaultStoryColor, isEdgeEnd, isNodeEnd, maxZoom, minZoom, validStoryEdges } from './model'
import type { Point, Rect, StoryEdge, StoryEndpoint, StoryNode, StoryScene, StoryView } from './model'
import { parallelBends, sameRelation } from './selection'

export const storyTools = ['select', 'hand', 'card', 'arrow', 'text', 'group', 'image', 'eraser'] as const
export type StoryTool = typeof storyTools[number]

interface CanvasOptions {
  select: (selection: ReadonlySet<string>) => void
  /** Saves a new scene. Resolves false when the change could not be saved. */
  change: (scene: StoryScene, select?: string[]) => Promise<boolean>
  createCard: (rect: Rect, name: string) => void
  openCard: (id: string) => void
  remove: (ids: string[]) => void
  pickImage: (point: Point) => void
  toolChanged: (tool: StoryTool, locked: boolean) => void
  viewChanged: (view: StoryView) => void
  /** Called whenever the selection moves on screen, so floating panels can follow it. */
  layout: () => void
  /** False while the board cannot be edited (saving, or the work is gone). */
  editable: () => boolean
  snapping: () => boolean
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

type Corner = 'nw' | 'ne' | 'sw' | 'se'
type Target = { nodeId: string } | { edgeId: string; at: number }
type Drag =
  | { kind: 'pan'; start: Point; view: StoryView }
  | { kind: 'pinch'; view: StoryView; center: Point; distance: number }
  | { kind: 'box'; start: Point; base: Set<string> }
  | { kind: 'move'; start: Point; nodes: StoryNode[]; edges: StoryEdge[] }
  | { kind: 'size'; start: Point; node: StoryNode; corner: Corner }
  | { kind: 'arrow'; start: Point }
  | { kind: 'end'; start: Point; edge: StoryEdge; which: 'from' | 'to' }
  | { kind: 'bend'; start: Point; edge: StoryEdge }
  | { kind: 'draw'; start: Point; shape: 'card' | 'group' }
  | { kind: 'erase'; start: Point; ids: Set<string> }
  | { kind: 'tap'; start: Point }

const touchSlop = 9
const doubleTapDelay = 500
const draftId = 'story-draft-arrow'
const minSize = { card: { width: 96, height: 44 }, other: { width: 40, height: 32 } }
const cardSize = { width: 168, height: 60 }
const peekDelay = 350
const groupSize = { width: 320, height: 220 }
const textSize = { width: 180, height: 72 }

const zoomAt = (view: StoryView, point: Point, zoom: number) => zoomAtPoint(view, point, zoom, { min: minZoom, max: maxZoom })

export function storyCanvas(options: CanvasOptions) {
  const surface = element('div', 'story-canvas')
  surface.setAttribute('role', 'region')
  surface.setAttribute('aria-label', t('story.canvas'))
  surface.tabIndex = 0
  const world = element('div', 'story-world')
  const groups = element('div', 'story-group-layer')
  const edgesLayer = svg('svg', { class: 'story-edge-layer', width: 1, height: 1 })
  const masks = svg('defs')
  const edgeItems = svg('g')
  const guideLayer = svg('g', { class: 'story-guides' })
  edgesLayer.append(masks, edgeItems, guideLayer)
  const nodesLayer = element('div', 'story-node-layer')
  const controls = element('div', 'story-controls')
  const marquee = element('div', 'story-marquee')
  const hint = element('p', 'story-canvas-hint')
  marquee.hidden = true
  world.append(groups, edgesLayer, nodesLayer)
  surface.append(world, controls, marquee, hint)
  const toast = canvasToast(surface)
  const peek = element('div', 'story-peek')
  peek.setAttribute('role', 'tooltip')
  peek.hidden = true
  surface.append(peek)
  let peekTimer = 0
  let peeking = ''

  let scene: StoryScene = { nodes: [], edges: [], tags: [] }
  let view: StoryView = { x: 0, y: 0, zoom: 1 }
  let selection = new Set<string>()
  let tool: StoryTool = 'select'
  let locked = false
  const nodes = new Map<string, HTMLElement>()
  const edgeGroups = new Map<string, SVGGElement>()
  let paths = new Map<string, EdgePath | undefined>()
  const touches = new Map<number, Point>()
  const coarse = matchMedia('(any-pointer: coarse)')
  let drag: Drag | undefined
  let pointer: number | undefined
  let pointerType = 'mouse'
  let moved = false
  let space = false
  let ghost = new Map<string, Rect>()
  let drafts = new Map<string, StoryEdge>()
  let guides: Guide[] = []
  let bindTarget: Target | undefined
  let freeHold = false
  let zoomTimer = 0
  let usingNativeGesture = false
  let lastPointer: Point | undefined
  let lastEvent: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean } = { ctrlKey: false, metaKey: false, shiftKey: false }
  let scrollFrame = 0
  let previousFrame = 0
  let lastTap: { key: string; point: Point; time: number } | undefined
  let editor: (InlineEditor & { id?: string }) | undefined
  let flashTimer = 0
  let paintedZoom = 0
  let pressed: { node?: StoryNode; edgeId: string } = { edgeId: '' }
  let pressWorld: Point = { x: 0, y: 0 }
  const scrolled = { x: 0, y: 0 }

  const screen = (event: { clientX: number; clientY: number }): Point => {
    const box = surface.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }
  const atCenter = (): Point => ({ x: surface.clientWidth / 2, y: surface.clientHeight / 2 })
  const toScreen = (point: Point): Point => ({ x: point.x * view.zoom + view.x, y: point.y * view.zoom + view.y })
  const screenRect = (rect: Rect): Rect => ({ ...toScreen(rect), width: rect.width * view.zoom, height: rect.height * view.zoom })
  const rectOf = (node: StoryNode): Rect => ghost.get(node.id) ?? node
  const nodeById = (id: string) => scene.nodes.find((node) => node.id === id)
  const edgeById = (id: string) => drafts.get(id) ?? scene.edges.find((edge) => edge.id === id)
  const liveEdges = () => [...scene.edges.map((edge) => drafts.get(edge.id) ?? edge), ...(drafts.has(draftId) ? [drafts.get(draftId)!] : [])]
  const getNode = (target: Element | null) => {
    const id = target?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId
    return id ? nodeById(id) : undefined
  }
  const getEdgeId = (target: Element | null) => target?.closest('[data-edge-id]')?.getAttribute('data-edge-id') ?? ''
  const isControl = (target: Element | null) => target?.closest('.story-canvas-control')
  const snapOff = (event: { ctrlKey: boolean; metaKey: boolean }) => event.ctrlKey || event.metaKey
  const lineWidth = () => Math.max(2.5, 2.5 / view.zoom)
  const headLength = () => Math.max(14, 13 / view.zoom)
  const labelSize = () => Math.max(14, 12.5 / view.zoom)

  // ——— Painting ———

  function paintView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
    const cell = 24 * view.zoom
    surface.style.backgroundSize = `${cell}px ${cell}px`
    surface.style.backgroundPosition = `${view.x % cell}px ${view.y % cell}px`
    surface.style.setProperty('--story-inverse-zoom', String(1 / view.zoom))
    surface.style.setProperty('--story-zoom', String(view.zoom))
    surface.dataset.zoom = String(view.zoom)
    surface.toggleAttribute('data-far', view.zoom < .55)
    if (paintedZoom !== view.zoom) paintEdges()
    paintControls()
  }

  function setView(next: StoryView) {
    lastTap = undefined
    hidePeek()
    view = { zoom: next.zoom, x: clamp(next.x, -100_000_000, 100_000_000), y: clamp(next.y, -100_000_000, 100_000_000) }
    paintView()
  }

  function saveView() {
    clearTimeout(zoomTimer)
    zoomTimer = 0
    options.viewChanged(view)
  }

  function queueView() {
    clearTimeout(zoomTimer)
    zoomTimer = window.setTimeout(saveView, 140)
  }

  let measure: CanvasRenderingContext2D | null | undefined
  function textWidth(text: string, size: number) {
    measure ??= document.createElement('canvas').getContext('2d')
    if (!measure) return text.length * size
    measure.font = `750 ${size}px ${getComputedStyle(surface).fontFamily}`
    return measure.measureText(text).width
  }

  function arrowHead(tip: Point, direction: Point, length: number) {
    const base = { x: tip.x - direction.x * length, y: tip.y - direction.y * length }
    const half = length * .45
    const normal = { x: -direction.y * half, y: direction.x * half }
    return `M ${tip.x} ${tip.y} L ${base.x + normal.x} ${base.y + normal.y} L ${base.x - normal.x} ${base.y - normal.y} Z`
  }

  function paintEdges() {
    paintedZoom = view.zoom
    paths = storyEdgePaths({ ...scene, edges: liveEdges() }, rectOf)
    edgeGroups.clear()
    const width = lineWidth(), head = headLength(), size = labelSize()
    const hit = (coarse.matches ? 30 : 16) / view.zoom
    const items: SVGElement[] = []
    const maskItems: SVGElement[] = []
    const editing = editor?.id
    for (const edge of liveEdges()) {
      const path = paths.get(edge.id)
      if (!path) continue
      const group = svg('g', { 'data-edge-id': edge.id, class: 'story-edge' })
      group.classList.toggle('selected', selection.has(edge.id))
      group.classList.toggle('story-edge-draft', edge.id === draftId)
      edgeGroups.set(edge.id, group)
      const forward = edge.direction === 'forward' || edge.direction === 'both'
      const back = edge.direction === 'back' || edge.direction === 'both'
      const d = pathData(path, back ? head * .7 : 0, forward ? head * .7 : 0)
      group.append(svg('path', { d: pathData(path), class: 'story-hit', 'stroke-width': hit, fill: 'none' }))
      group.append(svg('path', { d: pathData(path), class: 'story-halo', 'stroke-width': width + 7 / view.zoom, fill: 'none' }))
      const showLabel = Boolean(edge.name) || editing === edge.id
      const line = svg('path', {
        d, class: 'story-line', stroke: edge.color, 'stroke-width': width, fill: 'none', 'stroke-linecap': 'round',
        'stroke-dasharray': edge.stroke === 'dash' ? `${width * 3.2} ${width * 2.4}` : edge.stroke === 'dot' ? `.01 ${width * 2.3}` : 'none',
      })
      if (showLabel) {
        // Break the line where its name sits.
        const labelWidth = editing === edge.id && editor ? editor.form.offsetWidth / view.zoom : textWidth(edge.name, size) + size * .8
        const labelHeight = editing === edge.id && editor ? editor.form.offsetHeight / view.zoom : size * 1.5
        const box = bounds([path.from, path.to, path.control].map((point) => ({ ...point, width: 0, height: 0 })))!
        const pad = width * 4 + head
        const id = `story-mask-${edge.id}`
        const mask = svg('mask', { id, maskUnits: 'userSpaceOnUse', x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 })
        mask.append(svg('rect', { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2, fill: 'white' }))
        mask.append(svg('rect', { x: path.mid.x - labelWidth / 2, y: path.mid.y - labelHeight / 2, width: labelWidth, height: labelHeight, rx: 4, fill: 'black' }))
        maskItems.push(mask)
        line.setAttribute('mask', `url(#${id})`)
      }
      group.append(line)
      if (forward) group.append(svg('path', { d: arrowHead(path.to, curveTangent(path, 1), head), class: 'story-head', fill: edge.color, stroke: edge.color, 'stroke-width': width * .6, 'stroke-linejoin': 'round' }))
      if (back) {
        const tangent = curveTangent(path, 0)
        group.append(svg('path', { d: arrowHead(path.from, { x: -tangent.x, y: -tangent.y }, head), class: 'story-head', fill: edge.color, stroke: edge.color, 'stroke-width': width * .6, 'stroke-linejoin': 'round' }))
      }
      if (edge.name && editing !== edge.id) {
        const label = svg('text', { x: path.mid.x, y: path.mid.y, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'story-edge-label', 'font-size': size })
        label.textContent = edge.name
        group.append(label)
      }
      items.push(group)
    }
    masks.replaceChildren(...maskItems)
    edgeItems.replaceChildren(...items)
    guideLayer.replaceChildren(...guides.map((guide) => guide.axis === 'x'
      ? svg('line', { x1: guide.at, x2: guide.at, y1: guide.from, y2: guide.to, 'stroke-width': 1 / view.zoom })
      : svg('line', { y1: guide.at, y2: guide.at, x1: guide.from, x2: guide.to, 'stroke-width': 1 / view.zoom })))
    paintBindTarget()
  }

  function paintBindTarget() {
    for (const node of nodesLayer.querySelectorAll('.story-bind-target')) node.classList.remove('story-bind-target')
    for (const node of groups.querySelectorAll('.story-bind-target')) node.classList.remove('story-bind-target')
    if (!bindTarget) return
    if ('nodeId' in bindTarget) nodes.get(bindTarget.nodeId)?.classList.add('story-bind-target')
    else edgeGroups.get(bindTarget.edgeId)?.classList.add('story-bind-target')
  }

  function paintGeometry() {
    for (const node of scene.nodes) {
      const rect = rectOf(node)
      const block = nodes.get(node.id)!
      block.style.transform = `translate(${rect.x}px, ${rect.y}px)`
      block.style.width = `${rect.width}px`
      block.style.height = `${rect.height}px`
      block.setAttribute('aria-pressed', String(selection.has(node.id)))
    }
    paintEdges()
    paintControls()
  }

  /** The selection's bounding box on screen, nodes and arrows together. */
  function selectionRect(ids: Iterable<string> = selection): Rect | undefined {
    const rects: Rect[] = []
    for (const id of ids) {
      const node = nodeById(id)
      if (node) { rects.push(screenRect(rectOf(node))); continue }
      const path = paths.get(id)
      if (path) {
        const points = [path.from, path.to, curveAt(path, .25), path.mid, curveAt(path, .75)].map(toScreen)
        rects.push(bounds(points.map((point) => ({ ...point, width: 0, height: 0 })))!)
      }
    }
    return bounds(rects)
  }

  function handle(className: string, label: string, data: Record<string, string>, point: Point) {
    const item = button('', `story-canvas-handle ${className}`)
    item.tabIndex = -1
    item.setAttribute('aria-label', label)
    for (const [key, value] of Object.entries(data)) item.dataset[key] = value
    item.style.left = `${point.x}px`
    item.style.top = `${point.y}px`
    return item
  }

  function paintControls() {
    const items: HTMLElement[] = []
    const active = drag && moved && drag.kind !== 'pan' && drag.kind !== 'pinch'
    const box = selectionRect()
    if (box && tool !== 'eraser' && !(drag?.kind === 'arrow')) {
      const ids = [...selection]
      const single = ids.length === 1 ? ids[0] : undefined
      const node = single ? nodeById(single) : undefined
      const edge = single && !node ? edgeById(single) : undefined
      if (!edge || ids.length > 1) {
        const frame = element('div', 'story-selection-frame')
        const pad = 5
        Object.assign(frame.style, { left: `${box.x - pad}px`, top: `${box.y - pad}px`, width: `${box.width + pad * 2}px`, height: `${box.height + pad * 2}px` })
        items.push(frame)
      }
      if (node && !active && !editor) {
        const rect = screenRect(rectOf(node))
        const pad = 5
        const corners: Record<Corner, Point> = {
          nw: { x: rect.x - pad, y: rect.y - pad }, ne: { x: rect.x + rect.width + pad, y: rect.y - pad },
          sw: { x: rect.x - pad, y: rect.y + rect.height + pad }, se: { x: rect.x + rect.width + pad, y: rect.y + rect.height + pad },
        }
        for (const corner of Object.keys(corners) as Corner[]) items.push(handle('story-resize', t('story.resize'), { corner }, corners[corner]))
        if (node.kind !== 'group' && tool === 'select') {
          const gap = 16
          const mid = center(rect)
          const ports: Record<string, Point> = {
            top: { x: mid.x, y: rect.y - gap }, right: { x: rect.x + rect.width + gap, y: mid.y },
            bottom: { x: mid.x, y: rect.y + rect.height + gap }, left: { x: rect.x - gap, y: mid.y },
          }
          for (const [port, point] of Object.entries(ports)) items.push(handle('story-port', t('story.connect'), { port }, point))
        }
      }
      if (edge && !(active && drag?.kind !== 'end' && drag?.kind !== 'bend') && !editor) {
        const path = paths.get(edge.id)
        if (path) {
          items.push(handle('story-end-handle', t('story.moveStart'), { end: 'from' }, toScreen(path.from)))
          items.push(handle('story-end-handle', t('story.moveEnd'), { end: 'to' }, toScreen(path.to)))
          items.push(handle('story-bend-handle', t('story.bendEdge'), { bend: 'true' }, toScreen(path.mid)))
        }
      }
    }
    controls.replaceChildren(...items)
    if (!active) options.layout()
  }

  function buildNode(node: StoryNode) {
    const block = element('div', `story-node story-node-${node.kind}`)
    block.dataset.nodeId = node.id
    block.setAttribute('role', 'button')
    block.tabIndex = -1
    const name = node.kind === 'text' ? node.text.trim().split('\n')[0] || t('story.text') : node.name || t(`story.${node.kind}`)
    block.setAttribute('aria-label', name)
    if (node.kind === 'card') {
      const tag = scene.tags.find((item) => item.id === node.tagIds[0])
      const band = element('span', 'story-card-band')
      if (tag) {
        block.style.setProperty('--tag-color', tag.color)
        band.title = node.tagIds.map((id) => scene.tags.find((item) => item.id === id)?.name).filter(Boolean).join(t('story.nameSeparator'))
      } else block.classList.add('story-untagged')
      block.append(band, element('strong', 'story-node-title', node.name))
      // Details stay out of the way: hover the card (or select it on a touch screen) to read them.
      if (node.aliases.length || node.body.trim() || node.fields.length) block.dataset.details = 'true'
    } else if (node.kind === 'image') {
      const img = element('img')
      img.src = node.src
      img.alt = node.name
      img.draggable = false
      block.append(img)
    } else if (node.kind === 'group') block.append(element('strong', 'story-group-title', name))
    else block.append(element('p', 'story-text-copy', node.text))
    return block
  }

  function select(ids: Iterable<string>) {
    selection = new Set(ids)
    options.select(selection)
    for (const [id, node] of nodes) node.setAttribute('aria-pressed', String(selection.has(id)))
    for (const [id, group] of edgeGroups) group.classList.toggle('selected', selection.has(id))
    paintControls()
  }

  function setScene(next: StoryScene) {
    hidePeek()
    editor?.close()
    editor = undefined
    cancelDrag()
    scene = next
    nodes.clear()
    groups.replaceChildren()
    nodesLayer.replaceChildren()
    for (const node of scene.nodes) {
      const block = buildNode(node)
      nodes.set(node.id, block)
      ;(node.kind === 'group' ? groups : nodesLayer).append(block)
    }
    const ids = new Set([...scene.nodes, ...scene.edges].map(({ id }) => id))
    selection = new Set([...selection].filter((id) => ids.has(id)))
    options.select(selection)
    paintGeometry()
    hint.hidden = Boolean(scene.nodes.length || scene.edges.length)
  }

  // ——— Tools ———

  function setTool(next: StoryTool, lock = locked && next === tool) {
    if (next === 'image') {
      options.pickImage(worldPoint(atCenter(), view))
      return
    }
    tool = next
    locked = lock && next !== 'select' && next !== 'hand'
    surface.dataset.tool = tool
    if (['card', 'arrow', 'text', 'group'].includes(tool)) select([])
    options.toolChanged(tool, locked)
    paintControls()
  }

  function finishTool() {
    if (!locked) setTool('select')
  }

  // ——— Binding (after Excalidraw: bind inside an object or within a small margin of its outline) ———

  /** Arrows that hang on `id`, directly or through other arrows. */
  function dependents(id: string) {
    const found = new Set<string>([id])
    let grew = true
    while (grew) {
      grew = false
      for (const edge of scene.edges) {
        if (found.has(edge.id)) continue
        if ([edge.from, edge.to].some((end) => isEdgeEnd(end) && found.has(end.edgeId))) { found.add(edge.id); grew = true }
      }
    }
    return found
  }

  function targetAt(point: Point, exclude: { node?: string; edges?: Set<string> } = {}): Target | undefined {
    const reach = bindingDistance(view.zoom, pointerType === 'touch')
    let best: { target: Target; gap: number } | undefined
    for (let index = scene.nodes.length - 1; index >= 0; index--) {
      const node = scene.nodes[index]
      if (node.kind === 'group' || node.id === exclude.node) continue
      const gap = rectDistance(rectOf(node), point)
      if (gap === 0) return { nodeId: node.id }
      if (gap <= reach && (!best || gap < best.gap)) best = { target: { nodeId: node.id }, gap }
    }
    for (const edge of scene.edges) {
      if (exclude.edges?.has(edge.id)) continue
      const path = paths.get(edge.id)
      if (!path) continue
      const near = nearestOnCurve(path, point)
      if (near.distance <= reach * .75 && (!best || near.distance < best.gap)) best = { target: { edgeId: edge.id, at: Math.round(near.t * 1000) / 1000 }, gap: near.distance }
    }
    return best?.target
  }

  function endFor(point: Point, target: Target | undefined): StoryEndpoint {
    return target ?? { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 }
  }

  // ——— Gestures ———

  function cancelDrag() {
    drag = undefined
    pointer = undefined
    moved = false
    ghost.clear()
    drafts.clear()
    guides = []
    bindTarget = undefined
    touches.clear()
    stopScroll()
    marquee.hidden = true
    marquee.classList.remove('story-draw-preview')
    for (const node of surface.querySelectorAll('.story-erasing')) node.classList.remove('story-erasing')
    delete surface.dataset.gesture
  }

  function cancelGesture() {
    const box = drag?.kind === 'box' ? drag.base : undefined
    if (drag?.kind === 'pan' || drag?.kind === 'pinch') saveView()
    lastTap = undefined
    cancelDrag()
    if (box) select(box)
    paintGeometry()
  }

  function pinchPoints() {
    const [first, second] = [...touches.values()]
    return { center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }, distance: Math.max(1, distance(first, second)) }
  }

  function startPinch() {
    const box = drag?.kind === 'box' ? drag.base : undefined
    const fingers = new Map(touches)
    cancelDrag()
    for (const [id, point] of fingers) touches.set(id, point)
    if (box) select(box)
    lastTap = undefined
    drag = { kind: 'pinch', view, ...pinchPoints() }
    moved = true
    surface.dataset.gesture = 'pinch'
    paintGeometry()
  }

  function beginArrow(start: Point, from: StoryEndpoint) {
    drafts.set(draftId, {
      id: draftId, from, to: { ...worldPoint(start, view) }, name: '', direction: 'forward', stroke: 'solid', color: defaultStoryColor, bend: 0,
    })
    drag = { kind: 'arrow', start }
    select([])
  }

  surface.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Element) || ![0, 1].includes(event.button)) return
    if (isControl(event.target) && !(event.pointerType === 'touch' && touches.size)) return
    const start = screen(event)
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, start)
      if (touches.size === 2) {
        surface.setPointerCapture(event.pointerId)
        event.preventDefault()
        startPinch()
        return
      }
      if (touches.size > 2) return
    }
    if (pointer !== undefined) return
    if (editor) return
    toast.hide()
    const target = event.target
    const point = worldPoint(start, view)
    pointerType = event.pointerType
    lastEvent = event
    moved = false
    pointer = event.pointerId
    pressWorld = point
    scrolled.x = scrolled.y = 0
    // Capture on the viewport so gestures can cross objects or the board's edge.
    surface.setPointerCapture(pointer)
    surface.focus({ preventScroll: true })
    const node = getNode(target)
    const edgeId = getEdgeId(target)
    const corner = target.closest<HTMLElement>('[data-corner]')?.dataset.corner as Corner | undefined
    const port = target.closest('[data-port]')
    const end = target.closest<HTMLElement>('[data-end]')?.dataset.end as 'from' | 'to' | undefined
    const bend = target.closest('[data-bend]')
    const editable = options.editable()
    const [only] = selection.size === 1 ? selection : []
    // A press on an arrow's own handle still counts as a press on that arrow for taps and double taps.
    pressed = { node, edgeId: edgeId || (end || bend ? only ?? '' : '') }

    if (space || tool === 'hand' || event.button === 1) drag = { kind: 'pan', view, start }
    else if (!editable) drag = event.pointerType === 'touch' ? { kind: 'pan', view, start } : { kind: 'tap', start }
    else if (corner && nodeById(only)) drag = { kind: 'size', start, node: nodeById(only)!, corner }
    else if (end && edgeById(only)) drag = { kind: 'end', start, edge: edgeById(only)!, which: end }
    else if (bend && edgeById(only)) drag = { kind: 'bend', start, edge: edgeById(only)! }
    else if (port && nodeById(only)) beginArrow(start, { nodeId: only })
    else if (tool === 'arrow') {
      const from = snapOff(event) ? undefined : targetAt(point)
      beginArrow(start, from && 'nodeId' in from ? from : endFor(point, undefined))
    } else if (tool === 'card' || tool === 'group') drag = { kind: 'draw', start, shape: tool }
    else if (tool === 'text') drag = { kind: 'tap', start }
    else if (tool === 'eraser') {
      drag = { kind: 'erase', start, ids: new Set() }
      eraseAt(start)
    } else if (node || edgeId) {
      const id = node?.id ?? edgeId
      if (event.shiftKey) {
        const next = new Set(selection)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        select(next)
      } else if (!selection.has(id)) select([id])
      const chosen = selectedNodes(scene.nodes, selection)
      const loose = scene.edges.filter((edge) => selection.has(edge.id) && [edge.from, edge.to].some((end) => 'x' in end))
      drag = { kind: 'move', start, nodes: chosen, edges: loose }
    } else {
      const base = event.shiftKey ? new Set(selection) : new Set<string>()
      if (!event.shiftKey) select([])
      drag = { kind: 'box', start, base }
    }
    surface.dataset.gesture = drag?.kind ?? ''
    paintGeometry()
    event.preventDefault()
  })

  function eraseAt(at: Point) {
    if (drag?.kind !== 'erase') return
    const box = surface.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + at.x, box.top + at.y)
    const node = getNode(hit)
    const id = node?.id ?? getEdgeId(hit)
    if (!id || drag.ids.has(id)) return
    drag.ids.add(id)
    ;(nodes.get(id) ?? edgeGroups.get(id))?.classList.add('story-erasing')
  }

  function dragTo(point: Point) {
    if (!drag || drag.kind === 'pinch' || drag.kind === 'tap') return
    const dx = point.x - drag.start.x, dy = point.y - drag.start.y
    const at = worldPoint(point, view)
    const free = snapOff(lastEvent)
    if (drag.kind === 'pan') {
      setView({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy })
      return
    }
    if (drag.kind === 'move') {
      // Measured on the board, so auto-scroll since the press counts as movement too.
      let mx = at.x - pressWorld.x, my = at.y - pressWorld.y
      guides = []
      const box = bounds(drag.nodes)
      if (box && options.snapping() && !free) {
        const moving = new Set(drag.nodes.map(({ id }) => id))
        const visible = worldPoint({ x: 0, y: 0 }, view)
        const area = { ...visible, width: surface.clientWidth / view.zoom, height: surface.clientHeight / view.zoom }
        const others = scene.nodes.filter((node) => !moving.has(node.id) && overlaps(node, area))
        const snap = snapRect({ ...box, x: box.x + mx, y: box.y + my }, others, snapDistance(view.zoom))
        mx += snap.dx
        my += snap.dy
        guides = snap.guides
      }
      mx = Math.round(mx)
      my = Math.round(my)
      for (const node of drag.nodes) ghost.set(node.id, { ...node, x: node.x + mx, y: node.y + my })
      for (const edge of drag.edges) {
        const shift = (end: StoryEndpoint) => 'x' in end ? { x: end.x + mx, y: end.y + my } : end
        drafts.set(edge.id, { ...edge, from: shift(edge.from), to: shift(edge.to) })
      }
      paintGeometry()
    } else if (drag.kind === 'size') {
      const node = drag.node
      const min = node.kind === 'card' ? minSize.card : minSize.other
      let left = node.x, top = node.y, right = node.x + node.width, bottom = node.y + node.height
      const px = at.x - pressWorld.x, py = at.y - pressWorld.y
      if (drag.corner.includes('w')) left = Math.min(left + px, right - min.width)
      else right = Math.max(right + px, left + min.width)
      if (drag.corner.includes('n')) top = Math.min(top + py, bottom - min.height)
      else bottom = Math.max(bottom + py, top + min.height)
      ghost.set(node.id, { ...node, x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) })
      paintGeometry()
    } else if (drag.kind === 'arrow') {
      const draft = drafts.get(draftId)!
      const fromNode = isNodeEnd(draft.from) ? draft.from.nodeId : undefined
      bindTarget = free ? undefined : targetAt(at, { node: fromNode })
      drafts.set(draftId, { ...draft, to: endFor(at, bindTarget) })
      paintEdges()
    } else if (drag.kind === 'end') {
      const edge = drafts.get(drag.edge.id) ?? drag.edge
      const other = drag.which === 'from' ? edge.to : edge.from
      bindTarget = free ? undefined : targetAt(at, { node: isNodeEnd(other) ? other.nodeId : undefined, edges: dependents(edge.id) })
      drafts.set(edge.id, { ...edge, [drag.which]: endFor(at, bindTarget) })
      paintEdges()
      paintControls()
    } else if (drag.kind === 'bend') {
      const path = paths.get(drag.edge.id)
      if (!path) return
      let bend = bendThrough(path.from, path.to, at)
      if (Math.abs(bend) < 10 / view.zoom) bend = 0
      drafts.set(drag.edge.id, { ...(drafts.get(drag.edge.id) ?? drag.edge), bend: Math.round(bend) })
      paintEdges()
      paintControls()
    } else if (drag.kind === 'erase') {
      eraseAt(point)
    } else {
      const origin = toScreen(pressWorld)
      const left = Math.min(origin.x, point.x), top = Math.min(origin.y, point.y)
      const width = Math.abs(point.x - origin.x), height = Math.abs(point.y - origin.y)
      marquee.hidden = false
      marquee.classList.toggle('story-draw-preview', drag.kind === 'draw')
      Object.assign(marquee.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` })
      if (drag.kind === 'box') {
        const box = { ...worldPoint({ x: left, y: top }, view), width: width / view.zoom, height: height / view.zoom }
        const inside = (point: Point) => contains(box, { ...point, width: 0, height: 0 })
        select([...drag.base, ...scene.nodes.filter((node) => contains(box, node)).map((node) => node.id),
          ...scene.edges.filter((edge) => { const path = paths.get(edge.id); return path && inside(path.from) && inside(path.to) && inside(path.mid) }).map((edge) => edge.id)])
      }
    }
    if (!scrollFrame) scrollFrame = requestAnimationFrame(autoScroll)
  }


  surface.addEventListener('pointermove', (event) => {
    const point = screen(event)
    if (touches.has(event.pointerId)) touches.set(event.pointerId, point)
    if (!drag) return
    if (drag.kind === 'pinch') {
      if (touches.size < 2) return
      const current = pinchPoints()
      const zoomed = zoomAt(drag.view, drag.center, drag.view.zoom * current.distance / drag.distance)
      setView({ ...zoomed, x: zoomed.x + current.center.x - drag.center.x, y: zoomed.y + current.center.y - drag.center.y })
      queueView()
      return
    }
    if (event.pointerId !== pointer) return
    lastEvent = event
    if (!moved && distance(point, drag.start) < (event.pointerType === 'touch' ? touchSlop : 3)) return
    if (!moved) { moved = true; lastTap = undefined }
    lastPointer = point
    dragTo(point)
  })

  // Scroll the board while a drag rests near its edge.
  function autoScroll(time: number) {
    scrollFrame = 0
    if (!drag || !lastPointer || !moved || drag.kind === 'pan' || drag.kind === 'pinch' || drag.kind === 'tap') { previousFrame = 0; return }
    const axis = (value: number, span: number) => {
      const margin = Math.min(46, span / 4)
      if (!margin) return 0
      return clamp((margin - value) / margin, 0, 1) - clamp((value - span + margin) / margin, 0, 1)
    }
    const speed = { x: axis(lastPointer.x, surface.clientWidth), y: axis(lastPointer.y, surface.clientHeight) }
    if (!speed.x && !speed.y) { previousFrame = 0; return }
    const step = .85 * (previousFrame ? Math.min(32, time - previousFrame) : 16)
    previousFrame = time
    setView({ ...view, x: view.x + speed.x * step, y: view.y + speed.y * step })
    scrolled.x += speed.x * step
    scrolled.y += speed.y * step
    dragTo(lastPointer)
    scrollFrame = requestAnimationFrame(autoScroll)
  }

  function stopScroll() {
    if (scrollFrame) cancelAnimationFrame(scrollFrame)
    scrollFrame = previousFrame = 0
    lastPointer = undefined
    if (scrolled.x || scrolled.y) saveView()
    scrolled.x = scrolled.y = 0
  }

  surface.addEventListener('pointerup', (event) => {
    const touch = touches.delete(event.pointerId)
    if (drag?.kind === 'pinch' && touch) {
      saveView()
      if (!touches.size) cancelDrag()
      else if (touches.size === 1) {
        const [[id, start]] = [...touches]
        pointer = id
        drag = { kind: 'pan', view, start }
        moved = true
      }
      return
    }
    if (event.pointerId !== pointer) return
    const completed = drag
    const didMove = moved
    const point = screen(event)
    const at = worldPoint(point, view)
    const adjusted = new Map(ghost)
    const changed = new Map(drafts)
    if (!didMove && !completed) return
    if (completed?.kind === 'erase') {
      const ids = [...completed.ids]
      cancelDrag()
      paintGeometry()
      if (ids.length) options.remove(ids)
      return
    }
    // Keep the moved objects drawn where they were dropped until the saved scene arrives.
    drag = undefined
    pointer = undefined
    moved = false
    guides = []
    bindTarget = undefined
    stopScroll()
    marquee.hidden = true
    marquee.classList.remove('story-draw-preview')
    delete surface.dataset.gesture
    touches.clear()
    if (!completed) return
    const settle = (saved: Promise<boolean>) => { void saved.then((ok) => { if (!ok) { ghost.clear(); drafts.clear(); paintGeometry() } }) }
    switch (completed.kind) {
      case 'pan': if (didMove) saveView(); else tap(point, event); break
      case 'tap': if (!didMove) tap(point, event); break
      case 'box': if (!didMove) tap(point, event); else paintControls(); break
      case 'move': case 'size':
        if (!didMove) { ghost.clear(); paintGeometry(); tap(point, event); break }
        settle(options.change({
          ...scene,
          nodes: scene.nodes.map((node) => adjusted.has(node.id) ? { ...node, ...adjusted.get(node.id)! } : node),
          edges: scene.edges.map((edge) => changed.get(edge.id) ?? edge),
        }))
        break
      case 'bend':
        if (!didMove) { drafts.clear(); paintGeometry(); tap(point, event); break }
        if (didMove && changed.has(completed.edge.id)) settle(options.change({ ...scene, edges: scene.edges.map((edge) => changed.get(edge.id) ?? edge) }))
        else { drafts.clear(); paintGeometry() }
        break
      case 'end': {
        const edge = changed.get(completed.edge.id)
        if (!didMove || !edge) { drafts.clear(); paintGeometry(); if (!didMove) tap(point, event); break }
        finishEnd(edge)
        break
      }
      case 'arrow': {
        const draft = changed.get(draftId)
        drafts.clear()
        if (!draft || !didMove || distance(point, completed.start) < 12) { paintGeometry(); break }
        finishArrow({ ...draft, id: crypto.randomUUID() })
        break
      }
      case 'draw': {
        const origin = pressWorld
        const shape = completed.shape
        const size = shape === 'card' ? cardSize : groupSize
        const small = !didMove || Math.abs(at.x - origin.x) * view.zoom < 16 || Math.abs(at.y - origin.y) * view.zoom < 16
        const rect = small ? { x: Math.round(origin.x - size.width / 2), y: Math.round(origin.y - size.height / 2), ...size } : {
          x: Math.round(Math.min(origin.x, at.x)), y: Math.round(Math.min(origin.y, at.y)),
          width: Math.round(Math.max(Math.abs(at.x - origin.x), minSize.card.width)), height: Math.round(Math.max(Math.abs(at.y - origin.y), minSize.card.height)),
        }
        paintGeometry()
        if (shape === 'card') newCard(rect)
        else {
          const id = crypto.randomUUID()
          void options.change({ ...scene, nodes: [{ ...rect, id, kind: 'group', name: t('story.group') }, ...scene.nodes] }, [id])
          finishTool()
        }
        break
      }
    }
  })

  function finishArrow(edge: StoryEdge, force = false) {
    const { from, to } = edge
    if (isNodeEnd(from) && isNodeEnd(to)) {
      const existing = sameRelation(scene.edges, from.nodeId, to.nodeId)
      if (existing && !force) {
        paintGeometry()
        select([existing.id])
        flash(existing.id)
        toast.show(t('story.relationExists'), { action: { label: t('story.createAnyway'), run: () => finishArrow(edge, true) } })
        finishTool()
        return
      }
      edge = { ...edge, bend: freeBend(parallelBends(scene.edges, from.nodeId, to.nodeId)) }
    }
    const edges = [...scene.edges, edge]
    if (!validStoryEdges(edges)) { paintGeometry(); return }
    void options.change({ ...scene, edges }, [edge.id]).then((saved) => { if (saved) flash(edge.id) })
    finishTool()
  }

  function finishEnd(edge: StoryEdge, force = false) {
    const { from, to } = edge
    if (isNodeEnd(from) && isNodeEnd(to)) {
      const existing = sameRelation(scene.edges, from.nodeId, to.nodeId, edge.id)
      if (existing && !force) {
        drafts.clear()
        paintGeometry()
        toast.show(t('story.relationExists'), { action: { label: t('story.createAnyway'), run: () => finishEnd(edge, true) } })
        return
      }
      const used = parallelBends(scene.edges, from.nodeId, to.nodeId, edge.id)
      if (used.some((bend) => Math.abs(bend - edge.bend) < 24)) edge = { ...edge, bend: freeBend(used) }
    }
    const edges = scene.edges.map((item) => item.id === edge.id ? edge : item)
    if (!validStoryEdges(edges)) { drafts.clear(); paintGeometry(); return }
    void options.change({ ...scene, edges }, [edge.id]).then((saved) => { if (!saved) { drafts.clear(); paintGeometry() } })
  }

  function flash(id: string) {
    clearTimeout(flashTimer)
    for (const group of edgeItems.querySelectorAll('.story-edge-new')) group.classList.remove('story-edge-new')
    requestAnimationFrame(() => edgeGroups.get(id)?.classList.add('story-edge-new'))
    flashTimer = window.setTimeout(() => edgeGroups.get(id)?.classList.remove('story-edge-new'), 600)
  }

  function tap(point: Point, event: PointerEvent) {
    const { node, edgeId } = pressed
    const at = worldPoint(point, view)
    if (tool === 'text' && options.editable()) {
      if (node?.kind === 'text') editText(node)
      else newText(at)
      return
    }
    if (tool !== 'select') return
    const key = node?.id ?? edgeId ?? 'blank'
    const time = performance.now()
    const previous = lastTap
    const tolerance = event.pointerType === 'touch' ? 28 : 6
    if (previous && previous.key === (key || 'blank') && time - previous.time <= doubleTapDelay && distance(previous.point, point) <= tolerance) {
      lastTap = undefined
      doubleTap(node, edgeId, at)
      return
    }
    lastTap = { key: key || 'blank', point, time }
    if (!node && !edgeId && tool === 'select' && !event.shiftKey) select([])
  }

  function doubleTap(node: StoryNode | undefined, edgeId: string, at: Point) {
    if (!options.editable()) return
    if (node?.kind === 'card' || node?.kind === 'group') rename(node)
    else if (node?.kind === 'text') editText(node)
    else if (edgeId) editLabel(edgeId)
    else if (!node) newCard({ x: Math.round(at.x - cardSize.width / 2), y: Math.round(at.y - cardSize.height / 2), ...cardSize })
  }

  function cancelPointer(event: PointerEvent) {
    touches.delete(event.pointerId)
    if (event.pointerId === pointer || drag?.kind === 'pinch') cancelGesture()
  }
  surface.addEventListener('pointercancel', cancelPointer)
  surface.addEventListener('lostpointercapture', (event) => { if (event.pointerId === pointer) cancelGesture() })
  surface.addEventListener('contextmenu', (event) => event.preventDefault())

  // ——— Details on hover ———

  function hidePeek() {
    clearTimeout(peekTimer)
    peeking = ''
    peek.hidden = true
  }

  function showPeek(id: string) {
    const node = nodeById(id)
    if (node?.kind !== 'card' || drag || editor) return
    const details = cardDetails(node, scene.tags)
    if (!details) return
    peek.replaceChildren(element('strong', 'story-peek-title', node.name), details)
    peek.hidden = false
    const area = { x: 8, y: 8, width: surface.clientWidth - 16, height: surface.clientHeight - 16 }
    const { rect } = placeBeside(screenRect(rectOf(node)), { width: peek.offsetWidth, height: peek.offsetHeight }, area, 10, ['right', 'left', 'bottom', 'top'])
    peek.style.left = `${rect.x}px`
    peek.style.top = `${rect.y}px`
  }

  surface.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse' || drag || editor) return
    const id = event.target instanceof Element ? event.target.closest<HTMLElement>('.story-node-card')?.dataset.nodeId ?? '' : ''
    if (id === peeking) return
    hidePeek()
    peeking = id
    if (id) peekTimer = window.setTimeout(() => showPeek(id), peekDelay)
  })
  surface.addEventListener('pointerleave', hidePeek)
  surface.addEventListener('pointerdown', hidePeek, { capture: true })
  surface.addEventListener('wheel', hidePeek, { capture: true, passive: true })

  // ——— Inline editing ———

  function openEditor(id: string | undefined, settings: Parameters<typeof inlineEditor>[1]) {
    editor?.close()
    const current = inlineEditor(surface, {
      ...settings,
      commit: (value) => { if (editor === current) editor = undefined; settings.commit(value); paintGeometry() },
      cancel: () => { if (editor === current) editor = undefined; settings.cancel(); paintGeometry() },
    }) as InlineEditor & { id?: string }
    current.id = id
    editor = current
    paintGeometry()
    return current
  }

  const fieldSize = () => Math.max(16, 15 * view.zoom)

  function newCard(rect: Rect) {
    if (!options.editable()) return
    const box = screenRect(rect)
    select([])
    openEditor(undefined, {
      rect: box, value: '', label: t('story.name'), className: 'story-new-card', fontSize: fieldSize(),
      commit: (value) => { const name = value.trim(); if (name) options.createCard(rect, name.slice(0, 255)) },
      cancel: () => {},
    }).field.setAttribute('placeholder', t('story.cardNameHint'))
    finishTool()
  }

  function rename(node: Extract<StoryNode, { kind: 'card' | 'group' }>) {
    const rect = screenRect(node)
    const height = Math.max(40, fieldSize() * 2.1)
    openEditor(node.id, {
      rect: { x: rect.x, y: rect.y, width: Math.max(rect.width, 140), height }, value: node.name, label: t('story.name'),
      className: 'story-rename', fontSize: fieldSize(),
      commit: (value) => {
        const name = value.trim().slice(0, 255)
        const current = nodeById(node.id)
        if (!current || (!name && current.kind === 'card') || name === (current.kind === 'card' || current.kind === 'group' ? current.name : '')) return
        void options.change({ ...scene, nodes: scene.nodes.map((item) => item.id === node.id ? { ...item, name } as StoryNode : item) }, [node.id])
      },
      cancel: () => {},
    })
  }

  function editText(node: Extract<StoryNode, { kind: 'text' }>) {
    openEditor(node.id, {
      rect: screenRect(node), value: node.text, label: t('story.text'), className: 'story-text-editor', multiline: true, fontSize: fieldSize(),
      commit: (value) => {
        const current = nodeById(node.id)
        if (!current || current.kind !== 'text' || value === current.text) return
        if (!value.trim()) options.remove([node.id])
        else void options.change({ ...scene, nodes: scene.nodes.map((item) => item.id === node.id ? { ...current, text: value } : item) }, [node.id])
      },
      cancel: () => {},
    })
  }

  function newText(at: Point) {
    const rect = { x: Math.round(at.x), y: Math.round(at.y - textSize.height / 2), ...textSize }
    openEditor(undefined, {
      rect: screenRect(rect), value: '', label: t('story.text'), className: 'story-text-editor', multiline: true, fontSize: fieldSize(),
      commit: (value) => {
        if (!value.trim()) return
        const id = crypto.randomUUID()
        void options.change({ ...scene, nodes: [...scene.nodes, { ...rect, id, kind: 'text', text: value }] }, [id])
      },
      cancel: () => {},
    })
    finishTool()
  }

  /** Puts the name field on the arrow's middle, nudged off any card it would cover. */
  function labelRect(edge: StoryEdge, width: number, height: number) {
    const path = paths.get(edge.id)!
    const mid = toScreen(path.mid)
    const ends = [edge.from, edge.to].flatMap((end) => {
      const node = isNodeEnd(end) ? nodeById(end.nodeId) : undefined
      return node ? [screenRect(rectOf(node))] : []
    })
    const tangent = curveTangent(path, .5)
    const normal = { x: -tangent.y, y: tangent.x }
    for (const step of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      const offset = step * (height / 2 + 6)
      const rect = { x: mid.x + normal.x * offset - width / 2, y: mid.y + normal.y * offset - height / 2, width, height }
      if (!ends.some((end) => overlaps(end, rect))) return rect
    }
    return { x: mid.x - width / 2, y: mid.y - height / 2, width, height }
  }

  function editLabel(id: string) {
    const edge = scene.edges.find((item) => item.id === id)
    if (!edge || !paths.get(id) || !options.editable()) return
    select([id])
    const width = clamp(textWidth(edge.name || '', fieldSize()) + 48, 120, 260), height = Math.max(36, fieldSize() * 2)
    const current = openEditor(id, {
      rect: labelRect(edge, width, height), value: edge.name, label: t('story.relationName'), className: 'story-label-editor', fontSize: fieldSize(),
      commit: (value) => {
        const name = value.trim()
        const latest = scene.edges.find((item) => item.id === id)
        if (!latest || name === latest.name) return
        void options.change({ ...scene, edges: scene.edges.map((item) => item.id === id ? { ...item, name } : item) }, [id])
      },
      cancel: () => {},
    })
    current.field.addEventListener('input', () => {
      const next = clamp(textWidth(current.field.value, fieldSize()) + 48, 120, 260)
      current.place(labelRect(edge, next, height))
      paintEdges()
    })
  }

  // ——— Keyboard on the board ———

  // Space + drag pans from anywhere in the window except while typing.
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || editor || document.querySelector('dialog[open]')) return
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return
    event.preventDefault()
    if (event.repeat) return
    space = true
    surface.classList.add('story-panning')
  })
  window.addEventListener('keyup', (event) => {
    if (event.code !== 'Space') return
    space = false
    surface.classList.remove('story-panning')
  })
  window.addEventListener('blur', () => {
    space = false
    surface.classList.remove('story-panning')
    if (pointer !== undefined) cancelGesture()
  })

  // Wheel and two-finger trackpad swipes pan; Ctrl/⌘ + wheel and trackpad pinches zoom at the pointer.
  surface.addEventListener('wheel', (event) => {
    if (event.target instanceof Element && isControl(event.target)) return
    event.preventDefault()
    if (usingNativeGesture || drag || editor) return
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientHeight : 1
    if (event.ctrlKey || event.metaKey) {
      setView(zoomAt(view, screen(event), view.zoom * Math.exp(-event.deltaY * scale * (Math.abs(event.deltaY * scale) < 50 ? .01 : .0018))))
    } else if (event.shiftKey && !event.deltaX) setView({ ...view, x: view.x - event.deltaY * scale })
    else setView({ ...view, x: view.x - event.deltaX * scale, y: view.y - event.deltaY * scale })
    queueView()
  }, { passive: false })

  // Safari exposes trackpad pinch as a gesture event.
  let gestureView = view
  surface.addEventListener('gesturestart', (event) => {
    event.preventDefault()
    if (touches.size) return
    usingNativeGesture = true
    gestureView = view
  })
  surface.addEventListener('gesturechange', (event) => {
    event.preventDefault()
    if (!usingNativeGesture || touches.size) return
    const gesture = event as MouseEvent & { scale: number }
    setView(zoomAt(gestureView, screen(gesture), gestureView.zoom * gesture.scale))
    queueView()
  })
  surface.addEventListener('gestureend', (event) => {
    event.preventDefault()
    if (!usingNativeGesture) return
    usingNativeGesture = false
    saveView()
  })
  window.addEventListener('pagehide', () => { if (zoomTimer) saveView() })

  function contentBounds() {
    const points = [...paths.values()].flatMap((path) => path ? [path.from, path.to, path.mid] : [])
    return bounds([...scene.nodes, ...points.map((point) => ({ ...point, width: 0, height: 0 }))])
  }

  function fit(rect = contentBounds()) {
    if (!rect) setView({ x: 0, y: 0, zoom: 1 })
    else {
      const mid = atCenter()
      const zoom = clamp(Math.min((surface.clientWidth - 120) / Math.max(rect.width, 1), (surface.clientHeight - 180) / Math.max(rect.height, 1)), .15, 1.15)
      setView({ zoom, x: mid.x - (rect.x + rect.width / 2) * zoom, y: mid.y - (rect.y + rect.height / 2) * zoom })
    }
    saveView()
  }

  function updatePointerAppearance() {
    hint.textContent = t(coarse.matches ? 'story.emptyTouchCanvas' : 'story.emptyCanvas')
    paintedZoom = 0
    paintView()
  }
  coarse.addEventListener('change', updatePointerAppearance)
  new ResizeObserver(() => paintControls()).observe(surface)
  surface.dataset.tool = tool
  updatePointerAppearance()

  return {
    surface, setScene, select, fit, selectionRect, screenRect, toast,
    center: () => worldPoint(atCenter(), view),
    view: () => view,
    tool: () => tool,
    locked: () => locked,
    showView: setView,
    setTool(next: StoryTool, lock?: boolean) { setTool(next, lock ?? false) },
    toggleLock() { setTool(tool, !locked) },
    zoom(factor: number) { setView(zoomAt(view, atCenter(), view.zoom * factor)); saveView() },
    resetZoom() { setView(zoomAt(view, atCenter(), 1)); saveView() },
    /** Pans by a screen offset, e.g. to bring the selection out from under a panel. */
    panBy(dx: number, dy: number) { setView({ ...view, x: view.x + dx, y: view.y + dy }); saveView() },
    editing: () => Boolean(editor),
    rename(id: string) { const node = nodeById(id); if (node?.kind === 'card' || node?.kind === 'group') rename(node) },
    editText(id: string) { const node = nodeById(id); if (node?.kind === 'text') editText(node) },
    editLabel,
    flash,
    newCardAt(point?: Point) { const at = point ?? worldPoint(atCenter(), view); newCard({ x: Math.round(at.x - cardSize.width / 2), y: Math.round(at.y - cardSize.height / 2), ...cardSize }) },
    /** Escape: stop the current gesture or edit, then leave the drawing tool, then clear the selection. */
    dismiss() {
      if (editor) { editor.close(); editor = undefined; paintGeometry(); return true }
      if (drag) { cancelGesture(); return true }
      if (toast.message()) { toast.hide(); return true }
      if (tool !== 'select') { setTool('select'); return true }
      return false
    },
    contentBounds,
  }
}
