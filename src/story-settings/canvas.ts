import { t } from '../i18n'
import { button, element } from '../ui'
import { storyCanvasOverlays } from './canvas-overlays'
import { bounds, clamp, contains, fractionOf, nearestPort, pointAt, port, selectedNodes, storySegments, visibleLineCenter, worldPoint, zoomAt } from './geometry'
import type { Segment } from './geometry'
import { defaultStoryColor, storySides } from './model'
import type { EdgeEndpoint, NodeEndpoint, Point, Rect, StoryEdge, StoryNode, StoryScene, StorySide, StoryView } from './model'

interface CanvasOptions {
  select: (selection: ReadonlySet<string>) => void
  edit: (id: string) => void
  create: (point: Point) => void
  prepareLink: () => boolean
  linkModeChanged: (active: boolean) => void
  removeEdge: (id: string) => void
  change: (scene: StoryScene, relation?: { id: string; inspect: boolean }) => void
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

type LinkSource = { nodeId: string; side?: StorySide }
type LinkDrag = { kind: 'edge'; start: Point; from: LinkSource }
type Drop = { highlight?: Element } & (
  { point: Point; endpoint?: NodeEndpoint | EdgeEndpoint } | { error: 'linkSelf' | 'linkGroup' | 'linkOutside' })
type Tap = 'blank' | 'link' | { edge: string; additive: boolean }
type Drag =
  | { kind: 'pan'; start: Point; view: StoryView; tap?: Tap; stationary?: boolean }
  | { kind: 'pinch'; view: StoryView; center: Point; distance: number }
  | { kind: 'box'; start: Point; base: Set<string> }
  | { kind: 'move'; start: Point; nodes: StoryNode[] }
  | { kind: 'size'; start: Point; node: StoryNode }
  | LinkDrag

const touchTarget = 44
const touchSlop = 9
const doubleTapDelay = 400

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
  const hint = element('p', 'story-canvas-hint')
  const linkHint = element('p', 'story-link-hint')
  linkHint.setAttribute('role', 'status')
  const preview = svg('line', { class: 'story-edge-preview' })
  preview.style.display = 'none'
  edgesLayer.append(preview)
  marquee.hidden = true
  world.append(groups, edgesLayer, nodesLayer)
  surface.append(world, marquee, hint, linkHint)

  let scene: StoryScene = { nodes: [], edges: [], tags: [] }
  let view: StoryView = { x: 0, y: 0, zoom: 1 }
  let selection = new Set<string>()
  const nodes = new Map<string, HTMLElement>()
  const edgeGroups = new Map<string, SVGGElement>()
  let segments = storySegments(scene)
  const touches = new Map<number, Point>()
  const coarse = matchMedia('(any-pointer: coarse)')
  let drag: Drag | undefined
  let pointer: number | undefined
  let moved = false
  let space = false
  let hand = false
  let ghost = new Map<string, Rect>()
  let zoomTimer = 0
  let usingNativeGesture = false
  let linkMode: { from?: LinkSource } | undefined
  let linkPointer: Point | undefined
  let dropHighlight: Element | undefined
  let dropMessage = ''
  let feedback = ''
  let feedbackTimer = 0
  let newEdge: string | undefined
  let flashTimer = 0
  let panFrame = 0
  let previousFrame = 0
  let scrolledForLink = false
  let pressTimer = 0
  let lastTouchUp = -Infinity
  let lastBlankTap: { point: Point; time: number } | undefined
  const overlays = storyCanvasOverlays(surface, {
    connect: (nodeId) => enterLinkMode({ nodeId }),
    prepareEdit: options.prepareLink,
    name: editLabel,
    change: patchEdge,
    remove: options.removeEdge,
  })

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
  const toScreen = (point: Point): Point => ({ x: point.x * view.zoom + view.x, y: point.y * view.zoom + view.y })
  const screenRect = (rect: Rect): Rect => ({ ...toScreen(rect), width: rect.width * view.zoom, height: rect.height * view.zoom })
  const onScreen = (rect: Rect) => rect.x + rect.width > 0 && rect.y + rect.height > 0 && rect.x < surface.clientWidth && rect.y < surface.clientHeight
  const isControl = (target: Element | null) => target?.closest('.story-canvas-control')
  const hit = (point: Point) => {
    const box = surface.getBoundingClientRect()
    return document.elementFromPoint(box.left + point.x, box.top + point.y)
  }

  function edgeCenter(id: string) {
    const segment = segments.get(id)
    if (!segment) return
    return visibleLineCenter({ from: toScreen(segment.from), to: toScreen(segment.to) }, surface.clientWidth, surface.clientHeight)
  }

  function paintOverlays() {
    if (selection.size !== 1 || linkMode || drag?.kind === 'edge' || (drag && moved)) { overlays.render(); return }
    const [id] = selection
    const card = scene.nodes.find((node) => node.id === id && node.kind === 'card')
    const edge = scene.edges.find((edge) => edge.id === id)
    const rect = card && screenRect(ghost.get(id) ?? card)
    const point = edge && edgeCenter(id)
    const edited = overlays.editing()
    overlays.render(rect && onScreen(rect) ? { id, rect } : undefined, edge && point ? { edge, point } : undefined, edited ? edgeCenter(edited) : undefined)
  }

  function paintPorts() {
    if (!coarse.matches) return
    const padding = touchTarget / 2 + 2
    // Keep the full hit boxes inside the viewport and separated even on small, zoomed-out cards.
    function axis(start: number, length: number, limit: number) {
      const last = Math.max(padding, limit - padding)
      const gap = Math.min(touchTarget + 2, (last - padding) / 2)
      const middle = clamp(start + length / 2, padding + gap, last - gap)
      return [clamp(start - padding, padding, middle - gap), middle, clamp(start + length + padding, middle + gap, last)]
    }
    for (const id of selection) {
      const node = scene.nodes.find((item) => item.id === id)
      const block = nodes.get(id)
      if (!node || !block || node.kind === 'group') continue
      const rect = screenRect(ghost.get(id) ?? node)
      block.toggleAttribute('data-ports-outside', !onScreen(rect))
      if (!onScreen(rect)) continue
      const [left, x, right] = axis(rect.x, rect.width, surface.clientWidth)
      const [top, y, bottom] = axis(rect.y, rect.height, surface.clientHeight)
      const centers = { left: { x: left, y }, right: { x: right, y }, top: { x, y: top }, bottom: { x, y: bottom } }
      const offsetX = block.clientLeft, offsetY = block.clientTop
      for (const anchor of block.querySelectorAll<HTMLButtonElement>('[data-port]')) {
        const side = anchor.dataset.port as StorySide
        const point = centers[side]
        const dot = port(rect, side)
        anchor.style.setProperty('--touch-port-x', `${(point.x - rect.x) / view.zoom - offsetX}px`)
        anchor.style.setProperty('--touch-port-y', `${(point.y - rect.y) / view.zoom - offsetY}px`)
        anchor.style.setProperty('--touch-dot-x', `${clamp(dot.x - point.x, -13, 13)}px`)
        anchor.style.setProperty('--touch-dot-y', `${clamp(dot.y - point.y, -13, 13)}px`)
      }
    }
  }

  function paintView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
    const cell = 24 * view.zoom
    surface.style.backgroundSize = `${cell}px ${cell}px`
    surface.style.backgroundPosition = `${view.x % cell}px ${view.y % cell}px`
    surface.style.setProperty('--story-inverse-zoom', String(1 / view.zoom))
    surface.style.setProperty('--story-edge-hit', `${(coarse.matches ? 32 : 16) / view.zoom}px`)
    surface.dataset.zoom = String(view.zoom)
    paintPorts()
    paintOverlays()
  }

  function setView(next: StoryView) {
    lastBlankTap = undefined
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
    segments = storySegments(scene, (node) => ghost.get(node.id) ?? node)
    edgeGroups.clear()
    const items: SVGElement[] = []
    for (const edge of scene.edges) {
      const segment = segments.get(edge.id)
      if (!segment) continue
      const group = svg('g', { 'data-edge-id': edge.id, class: selection.has(edge.id) ? 'story-edge selected' : 'story-edge' })
      group.classList.toggle('story-edge-new', edge.id === newEdge)
      edgeGroups.set(edge.id, group)
      const color = edge.color
      group.append(line(segment, { class: 'story-hit', stroke: 'transparent' }))
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
    edgesLayer.replaceChildren(...items, preview)
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
    paintPorts()
    paintOverlays()
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
    for (const [id, node] of nodes) {
      node.setAttribute('aria-pressed', String(selection.has(id)))
      if (!selection.has(id)) node.removeAttribute('data-ports-outside')
    }
    for (const [id, group] of edgeGroups) group.classList.toggle('selected', selection.has(id))
    paintPorts()
    paintOverlays()
  }

  function paintLinkMode() {
    const step = drag?.kind === 'edge' ? 'drag' : linkMode ? (linkMode.from ? 'target' : 'source') : ''
    if (step) surface.dataset.connecting = step
    else delete surface.dataset.connecting
    const key = dropMessage || feedback || (step === 'target' ? 'linkPickTarget' : step === 'source' ? 'linkPickSource' : '')
    const message = key ? t(`story.${key}`) : ''
    if (linkHint.textContent !== message) linkHint.textContent = message
    linkHint.classList.toggle('story-link-error', key === 'linkSelf' || key === 'linkGroup' || key === 'linkOutside')
  }

  function showFeedback(key: string) {
    clearTimeout(feedbackTimer)
    feedback = key
    paintLinkMode()
    if (key) feedbackTimer = window.setTimeout(() => { feedback = ''; paintLinkMode() }, 2300)
  }

  function setLinkMode(next?: typeof linkMode) {
    const changed = Boolean(next) !== Boolean(linkMode)
    linkMode = next
    if (changed) options.linkModeChanged(Boolean(next))
    lastBlankTap = undefined
    overlays.hideMenu()
    showFeedback('')
    paintOverlays()
  }

  function enterLinkMode(from?: LinkSource) {
    if (!options.prepareLink()) return
    setLinkMode({ from })
    if (from) select([from.nodeId])
  }

  function targetAt(from: LinkSource, point: Point): Drop {
    const target = hit(point)
    if (!surface.contains(target) || isControl(target)) return { error: 'linkOutside' }
    const position = worldPoint(point, view)
    const node = getNode(target)
    if (node) {
      const highlight = nodes.get(node.id)
      if (node.id === from.nodeId) return { error: 'linkSelf', highlight }
      if (node.kind === 'group') return { error: 'linkGroup', highlight }
      const side = nearestPort(node, position)
      return { point: port(node, side), endpoint: { nodeId: node.id, side }, highlight }
    }
    const edgeId = getEdgeId(target)
    const segment = segments.get(edgeId)
    if (segment) {
      const at = fractionOf(segment, position)
      return { point: pointAt(segment.from, segment.to, at), endpoint: { edgeId, at }, highlight: edgeGroups.get(edgeId) }
    }
    return { point: position }
  }

  function sourcePort(from: LinkSource, towards: Point): NodeEndpoint | undefined {
    const node = scene.nodes.find(({ id }) => id === from.nodeId)
    return node && { nodeId: node.id, side: from.side ?? nearestPort(node, towards) }
  }

  function completeLink(from: LinkSource, target: Drop, inspect: boolean) {
    if ('error' in target) { showFeedback(target.error); return }
    const source = sourcePort(from, target.point)
    if (!source || !options.prepareLink()) return
    let to = target.endpoint
    let nextNodes = scene.nodes
    if (!to) {
      const id = crypto.randomUUID()
      const side = source.side === 'left' ? 'right' : source.side === 'right' ? 'left' : source.side === 'top' ? 'bottom' : 'top'
      to = { nodeId: id, side }
      const layout = { x: 0, y: 0, width: 176, height: 84 }
      const anchor = port(layout, side)
      nextNodes = [...nextNodes, {
        ...layout, id, kind: 'text', text: t('story.text'),
        x: target.point.x - anchor.x, y: target.point.y - anchor.y,
      }]
    }
    const edge: StoryEdge = { id: crypto.randomUUID(), from: source, to, name: '', direction: 'forward', stroke: 'solid', color: defaultStoryColor }
    setLinkMode()
    options.change({ ...scene, nodes: nextNodes, edges: [...scene.edges, edge] }, { id: edge.id, inspect })
  }

  function pickLink(point: Point) {
    if (linkMode?.from) { completeLink(linkMode.from, targetAt(linkMode.from, point), false); return }
    const node = getNode(hit(point))
    if (node?.kind === 'group') showFeedback('linkGroup')
  }

  function updateLinkPreview(from: LinkSource, point: Point) {
    const target = targetAt(from, point)
    const destination = 'point' in target ? target.point : worldPoint(point, view)
    const source = sourcePort(from, destination)
    if (!source) return
    const start = port(scene.nodes.find(({ id }) => id === source.nodeId)!, source.side)
    if (dropHighlight !== target.highlight) dropHighlight?.classList.remove('story-link-target', 'story-link-invalid')
    dropHighlight = target.highlight
    dropHighlight?.classList.toggle('story-link-target', 'point' in target)
    dropHighlight?.classList.toggle('story-link-invalid', 'error' in target)
    dropMessage = 'error' in target ? target.error : target.endpoint ? 'linkDropTarget' : 'linkDropText'
    for (const [key, value] of Object.entries({ x1: start.x, y1: start.y, x2: destination.x, y2: destination.y })) {
      preview.setAttribute(key, String(value))
    }
    preview.style.display = ''
    paintLinkMode()
  }

  function clearLinkPreview() {
    if (panFrame) cancelAnimationFrame(panFrame)
    panFrame = previousFrame = 0
    linkPointer = undefined
    dropHighlight?.classList.remove('story-link-target', 'story-link-invalid')
    dropHighlight = undefined
    dropMessage = ''
    preview.style.display = 'none'
    if (scrolledForLink) saveView()
    scrolledForLink = false
  }

  function linkScrollSpeed(point: Point) {
    const axis = (value: number, span: number) => {
      const margin = Math.min(46, span / 4)
      if (!margin || value < -margin || value > span + margin) return 0
      return clamp((margin - value) / margin, 0, 1) - clamp((value - span + margin) / margin, 0, 1)
    }
    return { x: axis(point.x, surface.clientWidth), y: axis(point.y, surface.clientHeight) }
  }

  function scrollForLink(time: number) {
    panFrame = 0
    if (drag?.kind !== 'edge' || !linkPointer) return
    const speed = linkScrollSpeed(linkPointer)
    if (!speed.x && !speed.y) { previousFrame = 0; return }
    const distance = .85 * (previousFrame ? Math.min(32, time - previousFrame) : 16)
    previousFrame = time
    const before = view
    setView({ ...view, x: view.x + speed.x * distance, y: view.y + speed.y * distance })
    scrolledForLink ||= before.x !== view.x || before.y !== view.y
    updateLinkPreview(drag.from, linkPointer)
    if (before.x !== view.x || before.y !== view.y) panFrame = requestAnimationFrame(scrollForLink)
  }

  function connected(id: string) {
    if (newEdge) edgeGroups.get(newEdge)?.classList.remove('story-edge-new')
    newEdge = id
    edgeGroups.get(id)?.classList.add('story-edge-new')
    clearTimeout(flashTimer)
    flashTimer = window.setTimeout(() => { edgeGroups.get(id)?.classList.remove('story-edge-new'); newEdge = undefined }, 500)
    showFeedback('linkSuccess')
  }

  function cancelDrag() {
    drag = undefined
    pointer = undefined
    moved = false
    ghost.clear()
    touches.clear()
    clearTimeout(pressTimer)
    clearLinkPreview()
    marquee.hidden = true
    delete surface.dataset.gesture
    paintLinkMode()
    paintOverlays()
  }

  function setScene(next: StoryScene) {
    overlays.clearEditor()
    cancelDrag()
    scene = next
    if (linkMode?.from && !scene.nodes.some(({ id }) => id === linkMode?.from?.nodeId)) setLinkMode({})
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
    if (!(event.target instanceof Element) || ![0, 1, 2].includes(event.button)) return
    if (isControl(event.target) && !(event.pointerType === 'touch' && touches.size)) {
      lastBlankTap = undefined
      return
    }
    const start = screen(event)
    if (event.pointerType === 'touch' && (pointer === undefined || touches.size)) {
      touches.set(event.pointerId, start)
      if (touches.size > 1) {
        surface.setPointerCapture(event.pointerId)
        event.preventDefault()
        clearTimeout(pressTimer)
        clearLinkPreview()
        overlays.hideMenu()
        lastBlankTap = undefined
        drag = { kind: 'pinch', view, ...pinchPoints() }
        moved = true
        ghost.clear()
        paintGeometry()
        marquee.hidden = true
        surface.dataset.gesture = 'pan'
        paintLinkMode()
        return
      }
    }
    if (pointer !== undefined) return
    overlays.hideMenu()
    showFeedback('')
    const target = event.target
    const node = getNode(target)
    const edge = getEdgeId(target)
    const side = target.closest<HTMLButtonElement>('[data-port]')?.dataset.port as StorySide | undefined
    const panning = space || hand || event.button !== 0
    moved = false
    pointer = event.pointerId
    // Capture on the viewport so gestures can cross objects or the board boundary.
    surface.setPointerCapture(pointer)
    surface.focus({ preventScroll: true })

    if (panning) drag = { kind: 'pan', view, start }
    else if (linkMode) {
      const from = linkMode.from
      const source = from ? (node?.id === from.nodeId ? from : undefined)
        : node && node.kind !== 'group' ? { nodeId: node.id, side } : undefined
      drag = source ? { kind: 'edge', start, from: source } : { kind: 'pan', view, start, tap: 'link' }
    } else if (node && side) drag = { kind: 'edge', start, from: { nodeId: node.id, side } }
    else if (node && target.closest('.story-resize')) drag = { kind: 'size', start, node }
    else if (node) {
      if (additive(event)) {
        const next = new Set(selection)
        if (next.has(node.id)) next.delete(node.id)
        else next.add(node.id)
        select(next)
      } else if (!selection.has(node.id)) select([node.id])
      drag = { kind: 'move', start, nodes: selectedNodes(scene.nodes, selection) }
      if (node.kind === 'card' && event.pointerType === 'touch') {
        pressTimer = window.setTimeout(() => {
          if (drag?.kind !== 'move' || moved) return
          drag = undefined
          select([node.id])
          overlays.openMenu(node.id, start)
        }, 500)
      }
    } else if (edge) {
      drag = { kind: 'pan', start, view, tap: { edge, additive: additive(event) }, stationary: event.pointerType !== 'touch' }
    } else if (event.pointerType === 'touch') drag = { kind: 'pan', view, start, tap: 'blank' }
    else {
      const base = additive(event) ? new Set(selection) : new Set<string>()
      select(base)
      drag = { kind: 'box', start, base }
    }
    if (drag.kind !== 'pan' || drag.tap !== 'blank') lastBlankTap = undefined
    surface.dataset.gesture = drag.kind
    paintLinkMode()
    if (drag.kind === 'edge') paintOverlays()
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
    const dx = point.x - drag.start.x, dy = point.y - drag.start.y
    if (!moved && Math.hypot(dx, dy) < (event.pointerType === 'touch' ? touchSlop : 3)) return
    if (!moved) {
      moved = true
      clearTimeout(pressTimer)
      lastBlankTap = undefined
    }
    if (drag.kind === 'edge') {
      linkPointer = point
      paintOverlays()
      updateLinkPreview(drag.from, point)
      if (!panFrame) panFrame = requestAnimationFrame(scrollForLink)
    } else if (drag.kind === 'pan') {
      if (!drag.stationary) setView({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy })
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

  function tapBlank(point: Point) {
    select([])
    const time = performance.now()
    const first = lastBlankTap
    if (first && time - first.time <= doubleTapDelay && Math.hypot(first.point.x - point.x, first.point.y - point.y) <= 28) {
      lastBlankTap = undefined
      options.create(worldPoint(point, view))
    } else lastBlankTap = { point, time }
  }

  function tapEdge(id: string, additive: boolean) {
    const next = new Set(additive ? selection : [])
    if (next.has(id)) next.delete(id)
    else next.add(id)
    select(next)
  }

  surface.addEventListener('pointerup', (event) => {
    const touch = touches.delete(event.pointerId)
    if (touch) lastTouchUp = performance.now()
    if (drag?.kind === 'pinch' && touch) {
      saveView()
      if (touches.size === 1) {
        const [remaining, start] = [...touches][0]
        pointer = remaining
        drag = { kind: 'pan', view, start }
        moved = false
      } else if (!touches.size) cancelDrag()
      else {
        pointer = touches.keys().next().value
        drag = { kind: 'pinch', view, ...pinchPoints() }
      }
      return
    }
    if (event.pointerId !== pointer) return
    const completed = drag
    const didMove = moved
    const adjusted = ghost
    const point = screen(event)
    const drop = completed?.kind === 'edge' && didMove ? targetAt(completed.from, point) : undefined
    ghost = new Map()
    cancelDrag()
    if (!completed) return
    if (completed.kind === 'edge') {
      if (drop) completeLink(completed.from, drop, !linkMode && !touch)
      else if (linkMode?.from) pickLink(point)
      else enterLinkMode(completed.from)
    } else if (completed.kind === 'pan') {
      if (didMove && !completed.stationary) saveView()
      else if (!didMove) {
        if (completed.tap === 'blank') tapBlank(point)
        else if (completed.tap === 'link') pickLink(point)
        else if (completed.tap) tapEdge(completed.tap.edge, completed.tap.additive)
      }
    } else if (didMove && (completed.kind === 'move' || completed.kind === 'size')) {
      options.change({ ...scene, nodes: scene.nodes.map((node) => adjusted.has(node.id) ? { ...node, ...adjusted.get(node.id)! } : node) })
      paintGeometry()
    }
  })

  function cancelGesture() {
    if (drag?.kind === 'pan' || drag?.kind === 'pinch') saveView()
    lastBlankTap = undefined
    cancelDrag()
    paintGeometry()
  }
  function lostPointer(event: PointerEvent) {
    if (event.pointerId === pointer || touches.has(event.pointerId)) cancelGesture()
  }
  surface.addEventListener('pointercancel', lostPointer)
  surface.addEventListener('lostpointercapture', lostPointer)
  surface.addEventListener('contextmenu', (event) => event.preventDefault())

  function patchEdge(id: string, change: Partial<Pick<StoryEdge, 'name' | 'direction' | 'stroke'>>) {
    options.change({ ...scene, edges: scene.edges.map((edge) => edge.id === id ? { ...edge, ...change } : edge) })
  }

  function editLabel(id: string) {
    const edge = scene.edges.find((item) => item.id === id)
    if (!edge || !options.prepareLink()) return
    const point = edgeCenter(id)
    if (!point) return
    select([id])
    overlays.editName(edge, point)
  }

  surface.addEventListener('dblclick', (event) => {
    if (!(event.target instanceof Element) || isControl(event.target) || linkMode || hand || space || performance.now() - lastTouchUp < doubleTapDelay) return
    const point = screen(event)
    const target = hit(point)
    const node = getNode(target)
    const edge = getEdgeId(target)
    if (node) options.edit(node.id)
    else if (edge) editLabel(edge)
    else options.create(worldPoint(point, view))
    event.preventDefault()
  })
  surface.addEventListener('keydown', (event) => {
    if (!(event.target instanceof Element) || isControl(event.target)) return
    if (event.code === 'Space') {
      space = true
      surface.classList.add('story-panning')
      event.preventDefault()
    } else if (event.key === 'Enter') {
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
    if (pointer !== undefined) cancelGesture()
  })
  surface.addEventListener('wheel', (event) => {
    if (event.target instanceof Element && isControl(event.target)) return
    event.preventDefault()
    if (usingNativeGesture || drag || overlays.editing()) return
    // Physical wheels usually produce stepped deltas. Precision touchpads pan with two fingers and pinch to zoom.
    const touchpad = event.deltaMode === 0 && (Math.abs(event.deltaY) < 45 || Math.abs(event.deltaX) > 0)
    if (event.ctrlKey || event.metaKey || (!touchpad && !event.shiftKey)) {
      const dy = event.deltaY * (event.deltaMode ? 14 : 1)
      setView(zoomAt(view, screen(event), view.zoom * Math.exp(-dy * .0018)))
    } else setView({ ...view, x: view.x - (event.deltaX || (event.shiftKey ? event.deltaY : 0)), y: view.y - (event.shiftKey ? 0 : event.deltaY) })
    queueView()
  }, { passive: false })

  // Safari exposes trackpad pinch as a gesture event on older WebKit releases.
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

  function fit(rect = bounds(scene.nodes)) {
    if (!rect) setView({ x: 0, y: 0, zoom: 1 })
    else {
      const mid = atCenter()
      const zoom = clamp(Math.min((surface.clientWidth - 100) / rect.width, (surface.clientHeight - 100) / rect.height), .15, 1.15)
      setView({ zoom, x: mid.x - (rect.x + rect.width / 2) * zoom, y: mid.y - (rect.y + rect.height / 2) * zoom })
    }
    saveView()
  }

  function updatePointerAppearance() {
    hint.textContent = t(coarse.matches ? 'story.emptyTouchCanvas' : 'story.emptyCanvas')
    paintView()
  }
  coarse.addEventListener('change', updatePointerAppearance)
  new ResizeObserver(() => { paintPorts(); paintOverlays() }).observe(surface)
  updatePointerAppearance()
  return {
    surface, center, setScene, select, fit, connected, editingLabel: () => Boolean(overlays.editing()),
    showView: setView,
    zoom(factor: number) { setView(zoomAt(view, atCenter(), view.zoom * factor)); saveView() },
    hand(on: boolean) {
      hand = on
      if (on && linkMode) setLinkMode()
      surface.classList.toggle('story-panning', hand || space)
    },
    toggleLink() { if (linkMode) setLinkMode(); else enterLinkMode() },
    dismiss() {
      if (overlays.hideMenu(true)) return true
      if (!linkMode && drag?.kind !== 'edge') return false
      if (drag) cancelGesture()
      setLinkMode()
      return true
    },
  }
}
