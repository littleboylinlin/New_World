import { onAppearanceChange } from '../appearance'
import { element } from '../ui'
import { t } from '../i18n'
import { inlinePlacements } from './inline-layout'
import type { InlinePlacement } from './inline-layout'
import type { PopupRect, ReadingAnnotation } from './model'
import type { AnnotationSurface } from './surface'

/** Fixed, clipped overlays leave source text, wrapping, line height and clipboard untouched. */
export function inlineAnnotationLayer(surface: AnnotationSurface, signal: AbortSignal, moved: () => void) {
  const layer = element('div', 'annotation-inline-layer')
  layer.dataset.annotationUi = ''
  document.body.append(layer)
  let items: ReadingAnnotation[] = []
  let dirty = true, frame = 0
  let placements = new Map<HTMLElement, InlinePlacement>()
  const relative = (rect: PopupRect, root: DOMRect) => ({ left: rect.left - root.left, right: rect.right - root.left, top: rect.top - root.top, bottom: rect.bottom - root.top })

  function clipping() {
    const viewport = window.visualViewport
    const clip = { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
      right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth), bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) }
    for (let node = surface.element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { clip.left = Math.max(clip.left, rect.left); clip.right = Math.min(clip.right, rect.right) }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { clip.top = Math.max(clip.top, rect.top); clip.bottom = Math.min(clip.bottom, rect.bottom) }
    }
    return clip
  }
  function layout(root: DOMRect) {
    const glyphs: PopupRect[] = []
    if (!items.length) { layer.replaceChildren(); placements.clear(); dirty = false; return }
    const walker = document.createTreeWalker(surface.element, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    while (walker.nextNode()) {
      range.selectNodeContents(walker.currentNode)
      for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) glyphs.push(relative(rect, root))
    }
    for (const node of surface.element.querySelectorAll('img, hr')) glyphs.push(relative(node.getBoundingClientRect(), root))
    const anchors = items.flatMap((item) => {
      const range = surface.range(item.anchor.from, item.anchor.to)
      const end = range.cloneRange()
      end.collapse(false)
      const rect = [...end.getClientRects()].find((rect) => rect.height > 0) ?? [...range.getClientRects()].filter((rect) => rect.height > 0).at(-1)
      if (!rect) return []
      let node = end.endContainer instanceof Element ? end.endContainer : end.endContainer.parentElement
      while (node && node !== surface.element) {
        const style = getComputedStyle(node), clip = node.getBoundingClientRect()
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (rect.right < clip.left || rect.left > clip.right)) return []
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.bottom < clip.top || rect.top > clip.bottom)) return []
        node = node.parentElement
      }
      return [{ id: item.id, rect: relative(rect, root) }]
    })
    const layout = inlinePlacements(anchors, glyphs, { left: 2, top: 0, right: root.width - 2, bottom: root.height })
    const nodes: HTMLElement[] = []
    const next = new Map<HTMLElement, InlinePlacement>()
    for (const placement of layout) {
      const ids = placement.ids.join(' ')
      const marker = [...placements.keys()].find((node) => node.dataset.annotationIds === ids) ?? element('button', 'annotation-inline')
      marker.setAttribute('type', 'button')
      marker.dataset.annotationIds = ids
      marker.dataset.compact = String(placement.compact)
      marker.setAttribute('aria-label', t('annotations.preview', [placement.ids.length]))
      marker.style.color = items.find((item) => item.id === placement.ids[0])?.inlineColor ?? 'var(--muted)'
      const arrow = element('span', 'annotation-inline-arrow')
      arrow.setAttribute('aria-hidden', 'true')
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 8 4')
      const path = document.createElementNS(svg.namespaceURI, 'path')
      path.setAttribute('d', 'M1 .5 4 3 7 .5')
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '1')
      svg.append(path); arrow.append(svg)
      const preview = element('span', 'annotation-inline-preview')
      for (const [i, id] of placement.ids.entries()) {
        const item = items.find((item) => item.id === id)!
        if (i) preview.append(' · ')
        const piece = element('span', 'annotation-inline-piece', item.text.replace(/\s+/g, ' '))
        piece.style.color = item.inlineColor ?? 'var(--muted)'
        preview.append(piece)
      }
      marker.replaceChildren(arrow, preview)
      marker.style.maxWidth = `${placement.rect.right - placement.rect.left}px`
      marker.style.height = `${placement.rect.bottom - placement.rect.top}px`
      next.set(marker, placement); nodes.push(marker)
    }
    layer.replaceChildren(...nodes)
    placements = next
    dirty = false
  }
  function update() {
    frame = 0
    if (signal.aborted || !surface.element.isConnected) return
    const root = surface.element.getBoundingClientRect()
    if (dirty) layout(root)
    const clip = clipping()
    for (const [node, placement] of placements) {
      const left = root.left + placement.rect.left, top = root.top + placement.rect.top
      node.style.left = `${left}px`; node.style.top = `${top}px`
      node.hidden = left < clip.left || left + Math.min(node.offsetWidth, placement.rect.right - placement.rect.left) > clip.right
        || top < clip.top || top + node.offsetHeight > clip.bottom
    }
    moved()
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
  const invalidate = () => { dirty = true; schedule() }
  const resize = new ResizeObserver(invalidate)
  resize.observe(surface.element)
  if (surface.element.parentElement) resize.observe(surface.element.parentElement)
  const attributes = new MutationObserver(invalidate)
  attributes.observe(document.documentElement, { attributes: true })
  const stopAppearance = onAppearanceChange(invalidate)
  document.fonts.addEventListener('loadingdone', invalidate, { signal })
  document.addEventListener('scroll', (event) => {
    if (event.target instanceof Node && surface.element.contains(event.target)) dirty = true
    schedule()
  }, { signal, capture: true })
  surface.element.addEventListener('animationend', invalidate, { signal })
  window.addEventListener('resize', invalidate, { signal })
  window.visualViewport?.addEventListener('resize', invalidate, { signal })
  window.visualViewport?.addEventListener('scroll', schedule, { signal })
  signal.addEventListener('abort', () => {
    cancelAnimationFrame(frame); resize.disconnect(); attributes.disconnect(); stopAppearance(); layer.remove()
  }, { once: true })
  return {
    element: layer,
    render: (next: ReadingAnnotation[]) => { items = next.filter((item) => item.display === 'inline'); invalidate() },
    anchor: (node: HTMLElement) => {
      const placement = placements.get(node)
      if (!placement) return node.getBoundingClientRect()
      const root = surface.element.getBoundingClientRect(), rect = node.getBoundingClientRect()
      return new DOMRect(rect.left, Math.min(rect.top, root.top + placement.anchor.top), rect.width,
        Math.max(rect.bottom, root.top + placement.anchor.bottom) - Math.min(rect.top, root.top + placement.anchor.top))
    },
  }
}
