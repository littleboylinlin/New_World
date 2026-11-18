import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { isHistoryTransaction } from '@tiptap/pm/history'
import { appearance, onAppearanceChange } from '../appearance'
import { reducedMotion } from '../motion'

const smoothing = .35
const precision = .5
type Move = 'input' | 'snap'
interface Point { x: number; y: number }

/** A sibling of ProseMirror, so neither the document nor the IME's DOM is changed. */
export function writingMotion(editor: Editor, paper: HTMLElement) {
  const events = new AbortController()
  const { signal } = events
  const body = editor.view.dom
  const caret = document.createElement('span')
  caret.className = 'writing-caret'
  caret.setAttribute('aria-hidden', 'true')
  caret.hidden = true
  paper.append(caret)
  paper.classList.add('smooth-writing')

  let frame = 0
  let needsMeasure = false
  let move: Move | undefined
  let reveal = false
  let composing = false
  let inputPending = false
  let typewriter = appearance().typewriter
  let position: Point | undefined
  let target: Point | undefined

  // The desktop scrolls .page; the web version scrolls the document.
  let scroller = paper.parentElement
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
  const scrollRoot = scroller ?? document.scrollingElement as HTMLElement
  const toolbar = paper.parentElement?.querySelector<HTMLElement>('.editor-tools-row')
  const footer = document.querySelector<HTMLElement>('.site-footer')

  function viewport() {
    const visual = window.visualViewport
    const top = visual?.offsetTop ?? 0
    const bottom = top + (visual?.height ?? innerHeight)
    const rect = scroller?.getBoundingClientRect()
    const visibleTop = Math.max(top, rect ? rect.top + scroller!.clientTop : top)
    const visibleBottom = Math.min(bottom, rect ? rect.top + scroller!.clientTop + scroller!.clientHeight : bottom,
      footer?.offsetHeight ? footer.getBoundingClientRect().top : bottom)
    return { top: visibleTop, bottom: visibleBottom }
  }

  function requestFrame() {
    if (!frame) frame = requestAnimationFrame(tick)
  }

  function schedule(reason?: Move) {
    needsMeasure = true
    // An explicit jump takes precedence over input notifications in the same frame.
    if (reason === 'snap' || move !== 'snap' && reason) move = reason
    requestFrame()
  }

  function hide() {
    caret.hidden = true
    position = target = undefined
  }

  function paint() {
    if (position) caret.style.transform = `translate(${position.x}px, ${position.y}px)`
  }

  function tick() {
    frame = 0
    if (needsMeasure) {
      needsMeasure = false
      measure()
    }
    if (!position || !target) return
    if (reducedMotion.matches) {
      position = { ...target }
      paint()
      return
    }
    position.x += (target.x - position.x) * smoothing
    position.y += (target.y - position.y) * smoothing
    const settled = Math.hypot(target.x - position.x, target.y - position.y) < precision
    if (settled) position = { ...target }
    paint()
    if (!settled) requestFrame()
  }

  function compositionCoords() {
    // The native DOM selection can lead the ProseMirror state during composition.
    // Read a separate Range; never change the platform's selection or composition.
    const selection = body.ownerDocument.getSelection()
    if (!selection?.focusNode || !body.contains(selection.focusNode)) return
    const range = document.createRange()
    range.setStart(selection.focusNode, selection.focusOffset)
    range.collapse(true)
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
    if (rect.height) return { left: rect.left, top: rect.top, bottom: rect.bottom }
  }

  function characterWidth(node: Node | null | undefined, offset: number, fallback: number) {
    if (!(node instanceof Text) || !node.length || !body.contains(node)) return fallback
    const range = document.createRange()
    range.setStart(node, Math.max(0, offset - 1))
    range.setEnd(node, Math.max(1, offset))
    return range.getBoundingClientRect().width || fallback
  }

  function revealInput(coords: { top: number; bottom: number }, margin: number, inComposition: boolean) {
    const visible = viewport()
    const top = Math.max(visible.top, toolbar?.getBoundingClientRect().bottom ?? visible.top)
    const height = coords.bottom - coords.top
    const centeredTop = visible.top + (toolbar?.offsetHeight ?? 0)
    const centerLine = typewriter && !inComposition && visible.bottom > centeredTop
    const clearance = Math.max(0, centerLine ? (visible.bottom - centeredTop - height) / 2 : visible.bottom - top - height)
    const lowerEdge = visible.bottom - Math.min(margin, clearance)
    const scroll = scrollRoot.scrollTop
    const delta = coords.top < top ? coords.top - top : Math.max(0, coords.bottom - lowerEdge)
    if (Math.abs(delta) > .5) scrollRoot.scrollTo({ top: scroll + delta, behavior: 'instant' })
    if (centerLine) {
      const centerDelta = (coords.top + coords.bottom - centeredTop - visible.bottom) / 2
      if (Math.abs(centerDelta - delta) > 2) {
        scrollRoot.scrollTo({ top: scroll + centerDelta, behavior: reducedMotion.matches ? 'instant' : 'smooth' })
      }
    }
  }

  function measure() {
    const reason = move
    move = undefined
    const shouldReveal = reveal
    reveal = inputPending = false
    if (!editor.isEditable || !editor.view.hasFocus() || document.hidden) { hide(); return }
    const inComposition = composing || editor.view.composing
    const selection = editor.state.selection
    const nativeSelection = body.ownerDocument.getSelection()
    if (!inComposition && (!(selection instanceof TextSelection) || !selection.empty || nativeSelection && !nativeSelection.isCollapsed)) {
      hide()
      return
    }

    const coords = inComposition && compositionCoords() || editor.view.coordsAtPos(selection.head)
    const rect = paper.getBoundingClientRect()
    if (!rect.width || !rect.height) { hide(); return }
    const scaleX = rect.width / paper.offsetWidth
    const scaleY = rect.height / paper.offsetHeight
    const x = (coords.left - rect.left) / scaleX + paper.scrollLeft - paper.clientLeft
    const y = (coords.top - rect.top) / scaleY + paper.scrollTop - paper.clientTop
    const height = (coords.bottom - coords.top) / scaleY
    const moved = !target || Math.abs(x - target.x) > .01 || Math.abs(y - target.y) > .01
    const sameLine = target && Math.abs(y - target.y) < precision
    const snap = !position || reason === 'snap' || reducedMotion.matches || moved && (reason !== 'input' || !sameLine)
    const focus = nativeSelection?.focusNode
    const element = focus instanceof Element ? focus : focus?.parentElement
    const text = element && body.contains(element) ? element : body
    if (snap) position = { x, y }
    if (shouldReveal || moved && !snap) {
      const style = getComputedStyle(text)
      const zoom = text.currentCSSZoom ?? 1
      if (moved && !snap && position) {
        const width = characterWidth(focus, nativeSelection?.focusOffset ?? 0, parseFloat(style.fontSize) * zoom) / scaleX
        const distance = Math.hypot(x - position.x, y - position.y)
        if (distance > width) {
          position.x = x + (position.x - x) * width / distance
          position.y = y + (position.y - y) * width / distance
        }
      }
      if (shouldReveal) {
        const margin = 2 * (parseFloat(style.lineHeight) * zoom || coords.bottom - coords.top)
        const space = `${Math.ceil(margin / scaleY)}px`
        if (paper.style.getPropertyValue('--writing-bottom-space') !== space) paper.style.setProperty('--writing-bottom-space', space)
        revealInput(coords, margin, inComposition)
      }
    }
    target = { x, y }
    caret.style.height = `${height}px`
    caret.hidden = false
    if (moved) {
      // Restart the blink without forcing layout, keeping the caret lit while typing.
      for (const animation of caret.getAnimations({ subtree: true })) animation.startTime = document.timeline.currentTime
    }
  }

  // Scrolling carries the caret with the paper. Unchanged local targets keep following.
  function layout() { schedule() }
  function resize() {
    const visible = viewport()
    paper.style.setProperty('--typewriter-space', `${Math.max(0, (visible.bottom - visible.top - (toolbar?.offsetHeight ?? 0)) / 2)}px`)
    layout()
  }
  function cancelReveal() {
    reveal = inputPending = false
    // Stop an in-flight smooth scroll as soon as the user starts browsing.
    if (typewriter) scrollRoot.scrollTo({ top: scrollRoot.scrollTop, behavior: 'instant' })
  }
  function transaction({ transaction }: { transaction: Transaction }) {
    if (transaction.docChanged) {
      reveal ||= inputPending
      inputPending = false
    }
    if (isHistoryTransaction(transaction) || transaction.getMeta('pointer')) schedule('snap')
    else if (transaction.docChanged || (composing || editor.view.composing) && transaction.selectionSet) schedule('input')
    else if (transaction.selectionSet) schedule('snap')
    else schedule()
  }
  function preferences() {
    typewriter = appearance().typewriter
    paper.classList.toggle('typewriter-writing', typewriter && editor.isEditable)
    resize()
  }
  function motionPreference() {
    if (reducedMotion.matches) cancelReveal()
    schedule('snap')
  }

  body.addEventListener('keydown', (event) => {
    if (event.isComposing || composing || editor.view.composing) return
    inputPending = !event.metaKey && !event.ctrlKey && !event.altKey
      && (event.key.length === 1 || ['Enter', 'Backspace', 'Delete'].includes(event.key))
    if (event.repeat || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)
      || (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) schedule('snap')
  }, { capture: true, signal })
  const input = (event: Event) => {
    const inputType = (event as InputEvent).inputType ?? ''
    const typing = !inputType.startsWith('history') && (composing || editor.view.composing || /^(insert|delete)/.test(inputType))
    inputPending = typing
    reveal ||= typing
    schedule(typing ? 'input' : 'snap')
  }
  body.addEventListener('beforeinput', input, { signal })
  body.addEventListener('input', input, { signal })
  body.addEventListener('compositionstart', () => {
    composing = true
    reveal = false
    schedule('input')
  }, { signal })
  body.addEventListener('compositionupdate', () => { reveal = true; schedule('input') }, { signal })
  body.addEventListener('compositionend', () => {
    composing = false
    reveal = true
    schedule('input')
  }, { signal })
  body.addEventListener('focus', () => schedule('snap'), { signal })
  body.addEventListener('blur', () => { reveal = inputPending = false; hide() }, { signal })
  document.addEventListener('visibilitychange', layout, { signal })
  document.addEventListener('scroll', layout, { capture: true, passive: true, signal })
  document.addEventListener('wheel', cancelReveal, { capture: true, passive: true, signal })
  document.addEventListener('touchstart', cancelReveal, { capture: true, passive: true, signal })
  document.addEventListener('pointerdown', () => { cancelReveal(); schedule('snap') }, { capture: true, passive: true, signal })
  document.addEventListener('selectionchange', () => schedule(composing || editor.view.composing ? 'input' : undefined), { signal })
  window.addEventListener('resize', resize, { signal })
  window.visualViewport?.addEventListener('resize', resize, { signal })
  window.visualViewport?.addEventListener('scroll', layout, { signal })
  paper.addEventListener('load', layout, { capture: true, signal })
  document.fonts.addEventListener('loadingdone', resize, { signal })
  void document.fonts.ready.then(() => { if (!signal.aborted) resize() })
  // Images, tables, wrapping, or surrounding panels can move the text without a transaction.
  const observer = new ResizeObserver(layout)
  observer.observe(body)
  observer.observe(paper)
  if (paper.parentElement) observer.observe(paper.parentElement)
  const mutations = new MutationObserver(() => schedule())
  mutations.observe(body, { subtree: true, childList: true, attributes: true, characterData: true })
  document.addEventListener('animationend', (event) => {
    if (event.target instanceof Element && (event.target.contains(paper) || paper.contains(event.target))) layout()
  }, { signal })
  reducedMotion.addEventListener('change', motionPreference, { signal })
  const stopFollowing = onAppearanceChange(preferences)
  editor.on('transaction', transaction)
  preferences()

  return {
    handlesScroll: () => inputPending && !composing && !editor.view.composing,
    refresh: preferences,
    destroy() {
      events.abort()
      stopFollowing()
      editor.off('transaction', transaction)
      observer.disconnect()
      mutations.disconnect()
      cancelAnimationFrame(frame)
      caret.remove()
      paper.classList.remove('smooth-writing', 'typewriter-writing')
      paper.style.removeProperty('--typewriter-space')
      paper.style.removeProperty('--writing-bottom-space')
    },
  }
}
