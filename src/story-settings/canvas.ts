import { t } from '../i18n'
import { button, element } from '../ui'
import { bounds, clamp, contains, fractionOf, nearestPort, pointAt, port, selectedNodes, storySegments, worldPoint, zoomAt } from './geometry'
import type { Segment } from './geometry'
import { defaultStoryColor, storySides } from './model'
import type { EdgeEndpoint, NodeEndpoint, Point, Rect, StoryEdge, StoryNode, StoryScene, StorySide, StoryView } from './model'

interface CanvasOptions {
  select: (selection: ReadonlySet<string>) => void
  edit: (id: string) => void
  create: (point: Point) => void
  startLabelEdit: () => boolean
  change: (scene: StoryScene, select?: string) => void
  viewChanged: (view: StoryView) => void
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}
function line({ from, to }: Segment, attrs: Record<string, string | number>) {
  return svg('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, ...attrs })
}
function arrow(from: Point, to: Point, color: string) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  return svg('path', {
    d: `M ${to.x} ${to.y} l ${-11 * Math.cos(angle - .38)} ${-11 * Math.sin(angle - .38)} L ${to.x - 11 * Math.cos(angle + .38)} ${to.y - 11 * Math.sin(angle + .38)} Z`,
    fill: color,
  })
}

type Drag =
  | { kind: 'pan'; start: Point; view: StoryView }
  | { kind: 'pinch'; view: StoryView; center: Point; distance: number }
  | { kind: 'box'; start: Point; base: Set<string> }
  | { kind: 'move'; start: Point; nodes: StoryNode[] }
  | { kind: 'size'; start: Point; node: StoryNode }
  | { kind: 'edge'; from: NodeEndpoint }

export function storyCanvas(options: CanvasOptions) {
  const surface = element('div', 'story-canvas')
  surface.setAttribute('role', 'region')
  surface.setAttribute('aria-label', t('story.canvas'))
  surface.tabIndex = 0
  const world = element('div', 'story-world')
  const groups = element('div', 'story-group-layer')
  const edgesLayer = svg('svg', { class: 'story-edge-layer', width: 1, height: 1 })
  const nodesLayer = element('div', 'story-node-layer')
  const marquee = element('div', 'story-marquee')
  const hint = element('p', 'story-canvas-hint', t('story.emptyCanvas'))
  marquee.hidden = true
  world.append(groups, edgesLayer, nodesLayer)
  surface.append(world, marquee, hint)

  let scene: StoryScene = { nodes: [], edges: [], tags: [] }
  let view: StoryView = { x: 0, y: 0, zoom: 1 }
  let selection = new Set<string>()
  const nodes = new Map<string, HTMLElement>()
  const touches = new Map<number, Point>()
  let drag: Drag | undefined
  let pointer: number | undefined
  let moved = false
  let space = false
  let hand = false
  let ghost = new Map<string, Rect>()
  let end: Point | undefined
  let zoomTimer = 0
  let usingNativeGesture = false
  let labelInput: HTMLInputElement | undefined

  const screen = (event: { clientX: number; clientY: number }): Point => {
    const box = surface.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }
  const atCenter = (): Point => ({ x: surface.clientWidth / 2, y: surface.clientHeight / 2 })
  const center = () => worldPoint(atCenter(), view)
  const getNode = (target: Element | null) => {
    const id = target?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId
    return scene.nodes.find((item) => item.id === id)
  }
  const getEdgeId = (target: Element | null) => target?.closest('[data-edge-id]')?.getAttribute('data-edge-id') ?? ''
  const additive = (event: PointerEvent) => event.shiftKey || event.metaKey || event.ctrlKey

  function paintView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
    const cell = 24 * view.zoom
    surface.style.backgroundSize = `${cell}px ${cell}px`
    surface.style.backgroundPosition = `${view.x % cell}px ${view.y % cell}px`
    surface.dataset.zoom = String(view.zoom)
  }

  function setView(next: StoryView) {
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

  function paintEdges() {
    const segments = storySegments(scene, (node) => ghost.get(node.id) ?? node)
    const items: SVGElement[] = []
    for (const edge of scene.edges) {
      const segment = segments.get(edge.id)
      if (!segment) continue
      const group = svg('g', { 'data-edge-id': edge.id, class: selection.has(edge.id) ? 'story-edge selected' : 'story-edge' })
      const color = edge.color
      group.append(line(segment, { class: 'story-hit', stroke: 'transparent', 'stroke-width': 16 / view.zoom }))
      group.append(line(segment, { class: 'story-line', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round',
        'stroke-dasharray': edge.stroke === 'dash' ? '9 6' : edge.stroke === 'dot' ? '1 5' : 'none' }))
      const { from, to } = segment
      if (edge.direction === 'forward' || edge.direction === 'both') group.append(arrow(from, to, color))
      if (edge.direction === 'back' || edge.direction === 'both') group.append(arrow(to, from, color))
      const mid = pointAt(from, to, .5)
      const label = svg('text', {
        x: mid.x, y: mid.y - 7, 'text-anchor': 'middle',
        class: edge.name ? 'story-edge-label' : 'story-edge-label story-empty-edge-label',
      })
      label.textContent = edge.name || t('story.relationName')
      group.append(label)
      items.push(group)
    }
    if (drag?.kind === 'edge' && end) {
      const source = scene.nodes.find((node) => node.id === (drag as Extract<Drag, { kind: 'edge' }>).from.nodeId)
      if (source) items.push(line({ from: port(source, drag.from.side), to: end }, { stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-dasharray': '7 4' }))
    }
    edgesLayer.replaceChildren(...items)
  }

  function paintGeometry() {
    for (const node of scene.nodes) {
      const rect = ghost.get(node.id) ?? node
      const block = nodes.get(node.id)!
      block.style.transform = `translate(${rect.x}px, ${rect.y}px)`
      block.style.width = `${rect.width}px`
      block.style.height = `${rect.height}px`
      block.setAttribute('aria-pressed', String(selection.has(node.id)))
    }
    paintEdges()
  }

  function buildNode(node: StoryNode) {
    const block = element('div', `story-node story-node-${node.kind}`)
    block.dataset.nodeId = node.id
    block.setAttribute('role', 'button')
    block.tabIndex = 0
    const name = node.kind === 'text' ? node.text.trim().split('\n')[0] || t('story.text') : node.name || t(`story.${node.kind}`)
    block.setAttribute('aria-label', name)
    if (node.kind === 'card') {
      const title = element('strong', 'story-node-title', node.name)
      const tags = element('div', 'story-node-tags')
      for (const id of node.tagIds) {
        const tag = scene.tags.find((tag) => tag.id === id)
        if (!tag) continue
        const chip = element('span', 'story-chip', tag.name)
        chip.style.setProperty('--tag-color', tag.color)
        tags.append(chip)
      }
      const preview = element('p', 'story-node-preview', node.body || node.fields.map((field) => [field.key, field.value].filter(Boolean).join(' · ')).join('\n'))
      block.append(title, tags, preview)
    } else if (node.kind === 'image') {
      const img = element('img')
      img.src = node.src
      img.alt = node.name
      img.draggable = false
      block.append(img)
    } else if (node.kind === 'group') block.append(element('strong', 'story-group-title', name))
    else block.append(element('p', 'story-text-copy', node.text))
    if (node.kind !== 'group') for (const side of storySides) {
      const anchor = button('', `story-port story-port-${side}`)
      anchor.tabIndex = -1
      anchor.dataset.port = side
      anchor.setAttribute('aria-label', t('story.connect'))
      block.append(anchor)
    }
    const resize = button('', 'story-resize')
    resize.tabIndex = -1
    resize.setAttribute('aria-label', t('story.resize'))
    block.append(resize)
    return block
  }

  function select(ids: Iterable<string>) {
    selection = new Set(ids)
    options.select(selection)
    for (const [id, node] of nodes) node.setAttribute('aria-pressed', String(selection.has(id)))
    for (const item of edgesLayer.querySelectorAll('.story-edge')) {
      item.classList.toggle('selected', selection.has(item.getAttribute('data-edge-id')!))
    }
  }

  function cancelDrag() {
    drag = undefined
    pointer = undefined
    ghost.clear()
    end = undefined
    touches.clear()
    marquee.hidden = true
    delete surface.dataset.gesture
  }

  function setScene(next: StoryScene) {
    const previous = labelInput
    labelInput = undefined
    previous?.remove()
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
    select([...selection].filter((id) => ids.has(id)))
    paintGeometry()
    hint.hidden = Boolean(scene.nodes.length)
  }

  function pinchPoints() {
    const [first, second] = [...touches.values()]
    return { center: pointAt(first, second, .5), distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)) }
  }

  surface.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Element) || event.target === labelInput || ![0, 1, 2].includes(event.button)) return
    const start = screen(event)
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, start)
      if (touches.size > 1) {
        surface.setPointerCapture(event.pointerId)
        drag = { kind: 'pinch', view, ...pinchPoints() }
        ghost.clear()
        paintGeometry()
        marquee.hidden = true
        surface.dataset.gesture = 'pan'
        return
      }
    }
    if (pointer !== undefined) return
    const target = event.target
    const node = getNode(target)
    const edge = getEdgeId(target)
    const side = target.closest<HTMLButtonElement>('[data-port]')?.dataset.port as StorySide | undefined
    const panning = space || hand || event.button !== 0
    if (edge && !node && !panning) {
      const next = new Set(additive(event) ? selection : [])
      if (next.has(edge)) next.delete(edge)
      else next.add(edge)
      select(next)
      surface.focus({ preventScroll: true })
      return
    }
    moved = false
    pointer = event.pointerId
    // Apply pointer capture to the viewport so an edge can be dropped outside its source card.
    surface.setPointerCapture(pointer)
    surface.focus({ preventScroll: true })
    if (panning) drag = { kind: 'pan', view, start }
    else if (node && side) drag = { kind: 'edge', from: { nodeId: node.id, side } }
    else if (node && target.closest('.story-resize')) drag = { kind: 'size', start, node }
    else if (node) {
      if (additive(event)) {
        const next = new Set(selection)
        if (next.has(node.id)) next.delete(node.id)
        else next.add(node.id)
        select(next)
      } else if (!selection.has(node.id)) select([node.id])
      drag = { kind: 'move', start, nodes: selectedNodes(scene.nodes, selection) }
    } else if (event.pointerType === 'touch') drag = { kind: 'pan', view, start }
    else {
      const base = additive(event) ? new Set(selection) : new Set<string>()
      select(base)
      drag = { kind: 'box', start, base }
    }
    surface.dataset.gesture = drag?.kind ?? ''
    event.preventDefault()
  })

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
    if (drag.kind === 'edge') {
      end = worldPoint(point, view)
      moved = true
      paintEdges()
      return
    }
    const dx = point.x - drag.start.x, dy = point.y - drag.start.y
    if (!moved && Math.hypot(dx, dy) < 3) return
    moved = true
    if (drag.kind === 'pan') {
      setView({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy })
    } else if (drag.kind === 'move') {
      for (const node of drag.nodes) ghost.set(node.id, { ...node, x: node.x + dx / view.zoom, y: node.y + dy / view.zoom })
      paintGeometry()
    } else if (drag.kind === 'size') {
      const node = drag.node
      ghost.set(node.id, { ...node, width: clamp(node.width + dx / view.zoom, 64, 100_000), height: clamp(node.height + dy / view.zoom, 44, 100_000) })
      paintGeometry()
    } else {
      const left = Math.min(drag.start.x, point.x), top = Math.min(drag.start.y, point.y)
      const width = Math.abs(dx), height = Math.abs(dy)
      marquee.hidden = false
      Object.assign(marquee.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` })
      const box = { ...worldPoint({ x: left, y: top }, view), width: width / view.zoom, height: height / view.zoom }
      select([...drag.base, ...scene.nodes.filter((node) => contains(box, node)).map((node) => node.id)])
    }
  })

  function connect(from: NodeEndpoint, event: PointerEvent) {
    const target = document.elementFromPoint(event.clientX, event.clientY)
    if (!surface.contains(target)) return
    const node = getNode(target)
    const edgeId = getEdgeId(target)
    const point = worldPoint(screen(event), view)
    let to: NodeEndpoint | EdgeEndpoint
    let nextNodes = scene.nodes
    if (node) {
      if (node.id === from.nodeId || node.kind === 'group') return
      const anchor = target?.closest<HTMLButtonElement>('[data-port]')?.dataset.port as StorySide | undefined
      to = { nodeId: node.id, side: anchor ?? nearestPort(node, point) }
    } else if (edgeId) {
      const segment = storySegments(scene).get(edgeId)
      if (!segment) return
      to = { edgeId, at: fractionOf(segment, point) }
    } else {
      const id = crypto.randomUUID()
      nextNodes = [...nextNodes, { ...point, id, kind: 'text', width: 176, height: 84, text: t('story.text') }]
      to = { nodeId: id, side: 'left' }
    }
    const edge: StoryEdge = { id: crypto.randomUUID(), from, to, name: '', direction: 'forward', stroke: 'solid', color: defaultStoryColor }
    options.change({ ...scene, nodes: nextNodes, edges: [...scene.edges, edge] }, edge.id)
  }

  surface.addEventListener('pointerup', (event) => {
    touches.delete(event.pointerId)
    if (drag?.kind === 'pinch') {
      saveView()
      if (touches.size === 1) {
        const [remaining, start] = [...touches][0]
        pointer = remaining
        drag = { kind: 'pan', view, start }
        moved = false
      } else if (!touches.size) cancelDrag()
      return
    }
    if (event.pointerId !== pointer) return
    const completed = drag
    const adjusted = ghost
    ghost = new Map()
    cancelDrag()
    if (completed && moved) {
      if (completed.kind === 'pan') saveView()
      if (completed.kind === 'move' || completed.kind === 'size') {
        options.change({ ...scene, nodes: scene.nodes.map((node) => adjusted.has(node.id) ? { ...node, ...adjusted.get(node.id)! } : node) })
      }
      if (completed.kind === 'edge') connect(completed.from, event)
      paintGeometry()
    }
  })
  surface.addEventListener('pointercancel', () => {
    if (drag?.kind === 'pan' || drag?.kind === 'pinch') saveView()
    cancelDrag()
    paintGeometry()
  })
  surface.addEventListener('contextmenu', (event) => event.preventDefault())
  function editLabel(id: string) {
    const edge = scene.edges.find((item) => item.id === id)
    const segment = storySegments(scene).get(id)
    if (!edge || !segment || !options.startLabelEdit()) return
    const point = pointAt(segment.from, segment.to, .5)
    const field = element('input', 'title-input story-inline-label')
    field.setAttribute('aria-label', t('story.relationName'))
    field.value = edge.name
    field.style.left = `${point.x * view.zoom + view.x}px`
    field.style.top = `${point.y * view.zoom + view.y - 9}px`
    labelInput = field
    surface.append(field)
    const finish = (save: boolean) => {
      if (field !== labelInput) return
      labelInput = undefined
      field.remove()
      const name = field.value.trim()
      if (save && name !== edge.name) {
        options.change({ ...scene, edges: scene.edges.map((item) => item.id === id ? { ...item, name } : item) })
      }
    }
    field.addEventListener('blur', () => finish(true), { once: true })
    field.addEventListener('keydown', (event) => {
      if (event.isComposing) return
      if (event.key !== 'Enter' && event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      finish(event.key === 'Enter')
      surface.focus({ preventScroll: true })
    })
    field.focus({ preventScroll: true })
    field.select()
  }

  surface.addEventListener('dblclick', (event) => {
    if (!(event.target instanceof Element) || event.target === labelInput || hand || space) return
    const target = document.elementFromPoint(event.clientX, event.clientY)
    const node = getNode(target)
    const edge = getEdgeId(target)
    if (node) options.edit(node.id)
    else if (edge) editLabel(edge)
    else options.create(worldPoint(screen(event), view))
    event.preventDefault()
  })
  surface.addEventListener('keydown', (event) => {
    if (event.target === labelInput) return
    if (event.code === 'Space') {
      space = true
      surface.classList.add('story-panning')
      event.preventDefault()
    } else if (event.key === 'Enter' && event.target instanceof Element) {
      const id = getNode(event.target)?.id ?? [...selection][0]
      if (id) options.edit(id)
    }
  })
  window.addEventListener('keyup', (event) => {
    if (event.code !== 'Space') return
    space = false
    surface.classList.toggle('story-panning', hand)
  })
  window.addEventListener('blur', () => {
    space = false
    surface.classList.toggle('story-panning', hand)
  })
  surface.addEventListener('wheel', (event) => {
    event.preventDefault()
    if (usingNativeGesture || drag || labelInput) return
    // Physical wheels usually produce stepped deltas. Precision touchpads pan with two fingers and pinch to zoom.
    const touchpad = event.deltaMode === 0 && (Math.abs(event.deltaY) < 45 || Math.abs(event.deltaX) > 0)
    if (event.ctrlKey || event.metaKey || (!touchpad && !event.shiftKey)) {
      const dy = event.deltaY * (event.deltaMode ? 14 : 1)
      setView(zoomAt(view, screen(event), view.zoom * Math.exp(-dy * .0018)))
    } else setView({ ...view, x: view.x - (event.deltaX || (event.shiftKey ? event.deltaY : 0)), y: view.y - (event.shiftKey ? 0 : event.deltaY) })
    paintEdges()
    queueView()
  }, { passive: false })

  // Safari exposes trackpad pinch as a gesture event on older WebKit releases.
  let gestureView = view
  surface.addEventListener('gesturestart', (event) => {
    event.preventDefault()
    usingNativeGesture = true
    gestureView = view
  })
  surface.addEventListener('gesturechange', (event) => {
    event.preventDefault()
    const gesture = event as MouseEvent & { scale: number }
    setView(zoomAt(gestureView, screen(gesture), gestureView.zoom * gesture.scale))
    paintEdges()
    queueView()
  })
  surface.addEventListener('gestureend', (event) => {
    event.preventDefault()
    usingNativeGesture = false
    saveView()
  })
  window.addEventListener('pagehide', () => { if (zoomTimer) saveView() })

  function fit(rect = bounds(scene.nodes)) {
    if (!rect) setView({ x: 0, y: 0, zoom: 1 })
    else {
      const mid = atCenter()
      const zoom = clamp(Math.min((surface.clientWidth - 100) / rect.width, (surface.clientHeight - 100) / rect.height), .15, 1.15)
      setView({ zoom, x: mid.x - (rect.x + rect.width / 2) * zoom, y: mid.y - (rect.y + rect.height / 2) * zoom })
    }
    paintEdges()
    saveView()
  }

  paintView()
  return {
    surface, center, setScene, select, fit, editingLabel: () => Boolean(labelInput),
    showView(next: StoryView) { setView(next); paintEdges() },
    zoom(factor: number) { setView(zoomAt(view, atCenter(), view.zoom * factor)); paintEdges(); saveView() },
    hand(on: boolean) { hand = on; surface.classList.toggle('story-panning', hand || space) },
  }
}
