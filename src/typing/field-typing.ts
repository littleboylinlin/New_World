import './typing.css'
import { reducedMotion } from '../motion'
import { appearance, onAppearanceChange } from '../appearance'
import { caretFollower } from './caret-motion'
import type { CaretMove } from './caret-motion'
import './composition'
import { touchSelection } from './touch-selection'

/**
 * Smooth carets and reading boxes for every native text field, installed once for the document.
 * Fields are never wrapped or changed apart from hiding the native caret while focused: a layer
 * that ignores the pointer is drawn over them, so selection, clipboard, dragging, input methods,
 * screen readers and autofill keep using the field itself. Fields without a selection API
 * (password, number, date, time, colour, file, email) keep their native behaviour.
 */
type Field = HTMLInputElement | HTMLTextAreaElement
type Reason = 'input' | 'commit' | 'snap'
const rank: Record<Reason, number> = { input: 1, commit: 2, snap: 3 }
const textTypes = new Set(['text', 'search', 'url', 'tel'])
const jumps = new Set(['Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])
const typedInput = /^(insertText|insertCompositionText|delete(Content|Word)(Backward|Forward))$/
const copied = [
  'direction', 'fontFamily', 'fontSize', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontFeatureSettings',
  'fontVariationSettings', 'fontKerning', 'fontSizeAdjust', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform',
  'textIndent', 'tabSize', 'textAlign', 'textRendering', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'wordBreak', 'overflowWrap', 'hyphens',
] as const

/**
 * Readings are tracked for the document rather than per focus, so a view that moves a field
 * (and so blurs and refocuses it) mid-composition does not lose the reading box.
 */
interface Reading { start: number; text: string }
const readings = new WeakMap<Field, Reading>()

export function typingField(node: unknown): node is Field {
  if (node instanceof HTMLTextAreaElement) return !node.readOnly && !node.disabled
  return node instanceof HTMLInputElement && textTypes.has(node.type) && !node.readOnly && !node.disabled
}

interface Measure { x: number; y: number; height: number; width: number; line: number; scroll: number; boxes: DOMRect[] }

function session(field: Field) {
  const events = new AbortController()
  const { signal } = events
  const multiline = field instanceof HTMLTextAreaElement
  const host = field.closest<HTMLElement>('dialog, [popover]') ?? document.body
  const overlay = document.createElement('div')
  overlay.className = 'typing-overlay'
  overlay.setAttribute('aria-hidden', 'true')
  const layer = document.createElement('div')
  layer.className = 'typing-layer'
  const boxes = document.createElement('div')
  const caret = document.createElement('span')
  caret.className = 'typing-caret'
  caret.hidden = true
  // The mirror sits in a box of no size that clips it, so it never adds scrollable area.
  const measureBox = document.createElement('div')
  measureBox.className = 'typing-measure'
  const mirror = document.createElement('div')
  mirror.className = 'typing-mirror'
  measureBox.append(mirror)
  layer.append(boxes, caret)
  overlay.append(measureBox, layer)
  host.append(overlay)

  const style = getComputedStyle(field)
  layer.style.setProperty('--typing-caret-color', style.caretColor === 'auto' ? style.color : style.caretColor)
  const clippers: Element[] = []
  for (let node = field.parentElement; node && node !== host.parentElement; node = node.parentElement) {
    const overflow = getComputedStyle(node)
    if (overflow.overflowX !== 'visible' || overflow.overflowY !== 'visible') clippers.push(node)
  }

  const inset = 2
  let frame = 0
  let reason: Reason | undefined
  let needsLayout = true
  let committing = false
  let held = false
  const composing = () => readings.has(field)
  let previous: Measure | undefined
  const follower = caretFollower((point) => { caret.style.transform = `translate(${point.x}px, ${point.y}px)` })

  const selectingByTouch = touchSelection(field, (active) => {
    if (active) {
      caret.hidden = true
      follower.reset()
      delete field.dataset.typingCaret
    } else {
      field.dataset.typingCaret = ''
      schedule('snap')
    }
  }, () => !composing() && field.selectionStart !== field.selectionEnd, signal)

  function schedule(next?: Reason) {
    if (next && (!reason || rank[next] > rank[reason])) reason = next
    if (!frame) frame = requestAnimationFrame(update)
  }
  function relayout() {
    needsLayout = true
    schedule()
  }

  function composition(value: string) {
    const reading = readings.get(field)
    if (!reading?.text) return
    const { text } = reading
    const start = value.startsWith(text, reading.start) ? reading.start : nearest(value, text, field.selectionEnd ?? 0)
    if (start >= 0) return { start, end: start + text.length }
  }

  function measure(scale: number): Measure | undefined {
    const value = field.value
    const caretIndex = field.selectionDirection === 'backward' ? field.selectionStart : field.selectionEnd
    if (caretIndex === null) return
    const reading = composition(value)
    for (const name of copied) mirror.style[name] = style[name]
    mirror.style.whiteSpace = multiline ? 'pre-wrap' : 'pre'
    mirror.style.overflowWrap = multiline ? style.overflowWrap === 'normal' ? 'break-word' : style.overflowWrap : 'normal'
    const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    mirror.style.width = multiline ? `${field.clientWidth - paddingX}px` : 'auto'
    mirror.style.height = 'auto'
    // Text after the caret's paragraph cannot move the caret; leave it out of long fields.
    const paragraphEnd = value.indexOf('\n', Math.max(caretIndex, reading?.end ?? 0))
    const end = paragraphEnd < 0 ? value.length : paragraphEnd
    const cuts = new Set([0, end, caretIndex])
    if (reading) { cuts.add(reading.start); cuts.add(reading.end) }
    const points = [...cuts].sort((a, b) => a - b)
    const marker = document.createElement('span')
    marker.textContent = '​'
    const readingSpans: HTMLElement[] = []
    let before: Text | undefined
    const parts: Node[] = []
    for (let i = 0; i < points.length; i++) {
      const at = points[i]
      if (at === caretIndex) parts.push(marker)
      const next = points[i + 1]
      if (next === undefined || next === at) continue
      const span = document.createElement('span')
      span.textContent = value.slice(at, next)
      if (reading && at >= reading.start && next <= reading.end) readingSpans.push(span)
      if (next === caretIndex) before = span.firstChild as Text
      parts.push(span)
    }
    mirror.replaceChildren(...parts)
    const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const line = mirror.clientHeight - paddingY
    // Single-line fields centre their text vertically in the content box.
    const center = multiline ? 0 : (field.clientHeight - paddingY - line) / 2
    const offsetX = inset - field.scrollLeft
    const offsetY = center - field.scrollTop
    const frameRect = mirror.getBoundingClientRect()
    // Measure the last character within its run so the mirror keeps kerning and ligatures.
    let characterWidth = 0
    if (before) {
      const range = document.createRange()
      range.setStart(before, before.length - 1)
      range.setEnd(before, before.length)
      characterWidth = range.getBoundingClientRect().width / scale
    }
    const measured: Measure = {
      x: marker.offsetLeft + offsetX,
      y: marker.offsetTop + offsetY,
      height: marker.offsetHeight,
      width: characterWidth || parseFloat(style.fontSize),
      line: multiline ? parseFloat(style.lineHeight) || marker.offsetHeight : line,
      scroll: field.scrollLeft + field.scrollTop,
      boxes: lines(readingSpans.flatMap((span) => [...span.getClientRects()]).map((rect) => new DOMRect(
        (rect.left - frameRect.left) / scale + offsetX, (rect.top - frameRect.top) / scale + offsetY, rect.width / scale, rect.height / scale))),
    }
    return measured
  }

  function place(scale: number) {
    const rect = field.getBoundingClientRect()
    const origin = overlay.getBoundingClientRect()
    const left = (rect.left - origin.left) / scale + field.clientLeft - inset
    const top = (rect.top - origin.top) / scale + field.clientTop
    layer.style.transform = `translate(${left}px, ${top}px)`
    layer.style.width = `${field.clientWidth + 2 * inset}px`
    layer.style.height = `${field.clientHeight}px`
    // Clip to the scrolling panels around the field, so the caret never shows outside them.
    let visible = new DOMRect(rect.left + field.clientLeft * scale - inset * scale, rect.top + field.clientTop * scale, (field.clientWidth + 2 * inset) * scale, field.clientHeight * scale)
    for (const clipper of clippers) {
      const box = clipper.getBoundingClientRect()
      const x1 = Math.max(visible.left, box.left), y1 = Math.max(visible.top, box.top)
      const x2 = Math.min(visible.right, box.right), y2 = Math.min(visible.bottom, box.bottom)
      visible = new DOMRect(x1, y1, Math.max(0, x2 - x1), Math.max(0, y2 - y1))
    }
    const own = layer.getBoundingClientRect()
    layer.style.clipPath = `inset(${Math.max(0, visible.top - own.top) / scale}px ${Math.max(0, own.right - visible.right) / scale}px ${Math.max(0, own.bottom - visible.bottom) / scale}px ${Math.max(0, visible.left - own.left) / scale}px)`
    return visible.width > 0 && visible.height > 0
  }

  function update() {
    frame = 0
    const why = reason
    reason = undefined
    const committed = committing
    committing = false
    const rect = field.getBoundingClientRect()
    if (!field.isConnected || document.activeElement !== field || !rect.width || !field.offsetWidth) { layer.hidden = true; return }
    const scale = rect.width / field.offsetWidth
    layer.hidden = false
    if (needsLayout || why) {
      needsLayout = false
      if (!place(scale)) { caret.hidden = true; boxes.replaceChildren(); return }
    }
    const next = measure(scale)
    if (!next) { caret.hidden = true; return }
    paintBoxes(next.boxes)
    const collapsed = field.selectionStart === field.selectionEnd
    if (selectingByTouch() || !collapsed && !composing()) {
      caret.hidden = true
      follower.reset()
      previous = next
      return
    }
    const last = previous
    previous = next
    const moved = !last || Math.abs(next.x - last.x) > .01 || Math.abs(next.y - last.y) > .01
    const sameLine = last && Math.abs(next.y - last.y) < .5
    const wrapped = last && multiline && next.x < last.x && next.y > last.y && next.y - last.y < 2 * next.line
    // A field that scrolled its text moved everything under the caret; follow at once.
    const scrolled = last && Math.abs(next.scroll - last.scroll) > .5
    let kind: CaretMove = 'snap'
    if (follower.position && !reducedMotion.matches && !scrolled && (why === 'input' || why === 'commit' || committed && why !== 'snap')) {
      kind = sameLine ? (why === 'commit' || committed ? 'commit' : 'glide') : wrapped ? 'wrap' : 'snap'
    }
    caret.style.height = `${next.height}px`
    caret.hidden = false
    if (moved || !follower.position) {
      follower.move({ x: next.x, y: next.y }, kind, next.width)
      for (const animation of caret.getAnimations({ subtree: true })) animation.startTime = document.timeline.currentTime
    }
  }

  function paintBoxes(rects: DOMRect[]) {
    if (!rects.length) { if (boxes.childElementCount) boxes.replaceChildren(); return }
    const nodes = rects.map((rect, index) => {
      const box = boxes.children[index] as HTMLElement | undefined ?? document.createElement('span')
      box.className = 'typing-composition-box'
      box.style.transform = `translate(${rect.x}px, ${rect.y}px)`
      box.style.width = `${rect.width}px`
      box.style.height = `${rect.height}px`
      return box
    })
    boxes.replaceChildren(...nodes)
  }

  const element: HTMLElement = field
  element.addEventListener('keydown', (event) => {
    if (event.isComposing || composing()) return
    // A held key or a jump stays in force until the key is released, however late its edit lands.
    held = event.repeat || jumps.has(event.key) || event.ctrlKey || event.metaKey || event.altKey
    if (held) schedule('snap')
  }, { signal })
  element.addEventListener('keyup', () => { held = false }, { signal })
  const input = (event: Event) => {
    const type = (event as InputEvent).inputType ?? ''
    schedule(composing() || !held && typedInput.test(type) ? 'input' : 'snap')
  }
  field.addEventListener('beforeinput', input, { signal })
  field.addEventListener('input', input, { signal })
  field.addEventListener('compositionstart', () => schedule('input'), { signal })
  field.addEventListener('compositionupdate', () => schedule('input'), { signal })
  field.addEventListener('compositionend', () => {
    committing = true
    // The reading box goes the moment the word is chosen or the input is cancelled.
    boxes.replaceChildren()
    schedule('commit')
  }, { signal })
  field.addEventListener('select', () => schedule(), { signal })
  field.addEventListener('scroll', () => schedule(), { signal })
  field.addEventListener('pointerdown', () => schedule('snap'), { signal })
  field.addEventListener('pointerup', () => schedule('snap'), { signal })
  document.addEventListener('selectionchange', () => schedule(composing() ? 'input' : undefined), { signal })
  document.addEventListener('scroll', relayout, { capture: true, passive: true, signal })
  window.addEventListener('resize', relayout, { signal })
  window.visualViewport?.addEventListener('resize', relayout, { signal })
  window.visualViewport?.addEventListener('scroll', relayout, { signal })
  document.fonts.addEventListener('loadingdone', relayout, { signal })
  document.addEventListener('animationend', relayout, { capture: true, signal })
  document.addEventListener('transitionend', relayout, { capture: true, signal })
  reducedMotion.addEventListener('change', () => schedule('snap'), { signal })
  const observer = new ResizeObserver(relayout)
  observer.observe(field)
  field.dataset.typingCaret = ''
  schedule('snap')

  return () => {
    events.abort()
    observer.disconnect()
    cancelAnimationFrame(frame)
    follower.destroy()
    delete field.dataset.typingCaret
    overlay.remove()
  }
}

/** One box per line, so the pieces around the caret never show seams. */
function lines(rects: DOMRect[]) {
  const merged: DOMRect[] = []
  for (const rect of rects) {
    const last = merged.at(-1)
    if (last && Math.abs(last.top - rect.top) < 1 && Math.abs(last.right - rect.left) < 1) {
      merged[merged.length - 1] = new DOMRect(last.left, Math.min(last.top, rect.top), rect.right - last.left, Math.max(last.bottom, rect.bottom) - Math.min(last.top, rect.top))
    } else merged.push(rect)
  }
  return merged
}

function nearest(value: string, text: string, caret: number) {
  let best = -1
  for (let index = value.indexOf(text); index >= 0; index = value.indexOf(text, index + 1)) {
    if (best < 0 || Math.abs(index + text.length - caret) < Math.abs(best + text.length - caret)) best = index
  }
  return best
}

let installed = false

/** Follow focus across the whole document, including dialogs, popovers and the capture window. */
export function installFieldTyping(root: Document = document) {
  if (installed) return
  installed = true
  let active: { field: Field; stop: () => void } | undefined
  const stop = () => { active?.stop(); active = undefined }
  let enabled = appearance().smoothTyping
  const start = (target: EventTarget | null) => {
    if (active?.field === target) return
    stop()
    if (enabled && typingField(target)) active = { field: target, stop: session(target) }
  }
  // Turning smooth typing off hands the focused field straight back to the system caret, and on again takes it over.
  onAppearanceChange((value) => {
    if (value.smoothTyping === enabled) return
    enabled = value.smoothTyping
    if (!enabled) stop()
    else start(root.activeElement)
  })
  root.addEventListener('compositionstart', ({ target }) => {
    if (typingField(target)) readings.set(target, { start: Math.min(target.selectionStart ?? 0, target.selectionEnd ?? 0), text: '' })
  }, true)
  root.addEventListener('compositionupdate', (event) => {
    const { target } = event
    if (!typingField(target)) return
    const reading = readings.get(target) ?? { start: Math.min(target.selectionStart ?? 0, target.selectionEnd ?? 0), text: '' }
    reading.text = (event as CompositionEvent).data ?? ''
    readings.set(target, reading)
  }, true)
  root.addEventListener('compositionend', ({ target }) => { if (typingField(target)) readings.delete(target) }, true)
  root.addEventListener('focusin', (event) => start(event.target), true)
  root.addEventListener('focusout', (event) => { if (event.target === active?.field) stop() }, true)
  if (root.activeElement) start(root.activeElement)
}
