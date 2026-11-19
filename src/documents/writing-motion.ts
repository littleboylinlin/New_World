import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { isHistoryTransaction } from '@tiptap/pm/history'
import { appearance, onAppearanceChange } from '../appearance'
import { reducedMotion } from '../motion'
import { caretFollower } from '../typing/caret-motion'
import type { CaretMove } from '../typing/caret-motion'
import { editorComposition } from '../typing/composition'
import { touchSelection } from '../typing/touch-selection'

const precision = .5
type Move = 'input' | 'commit' | 'snap'
const rank: Record<Move, number> = { input: 1, commit: 2, snap: 3 }
interface Point { x: number; y: number }

/** A sibling of ProseMirror, so neither the document nor the IME's DOM is changed. */
export function writingMotion(editor: Editor, paper: HTMLElement) {
  const events = new AbortController()
  const { signal } = events
  const body = editor.view.dom
  const caret = document.createElement('span')
  caret.className = 'writing-caret typing-caret'
  caret.setAttribute('aria-hidden', 'true')
  caret.hidden = true
  paper.append(caret)
  paper.classList.add('smooth-writing')

  let frame = 0
  let needsMeasure = false
  let move: Move | undefined
  let reveal = false
  let composing = false
  let committing = false
  let inputPending = false
  // A held key or a jump stays in force until the key is released, however late its edit lands.
  let held = false
  let typewriter = appearance().typewriter
  let smooth = appearance().smoothTyping
  let target: Point | undefined
  const follower = caretFollower((point) => { caret.style.transform = `translate(${point.x}px, ${point.y}px)` })
  const composition = editorComposition(editor, () => schedule())

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
    if (reason && (!move || rank[reason] > rank[move])) move = reason
    requestFrame()
  }

  function hide() {
    caret.hidden = true
    target = undefined
    follower.reset()
  }

  const selectingByTouch = touchSelection(body, (active) => {
    paper.classList.toggle('native-caret', active)
    if (active) hide()
    else schedule('snap')
  }, () => {
    const selection = body.ownerDocument.getSelection()
    return !!selection?.anchorNode && body.contains(selection.anchorNode) && !selection.isCollapsed
  }, signal)

  function tick() {
    frame = 0
    if (needsMeasure) {
      needsMeasure = false
      measure()
    }
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
      if (Math.abs(centerDelta - delta) > 2) glideTo(scroll + centerDelta)
    }
  }

  // A smooth scroll inside a pane can stall when the page is busy; it is aimed once, and if it
  // has not arrived shortly after, the pane is set where it was going.
  let glideTarget: number | undefined
  let glideTimer = 0
  function glideTo(top: number) {
    const target = Math.max(0, Math.min(top, scrollRoot.scrollHeight - scrollRoot.clientHeight))
    if (reducedMotion.matches) { scrollRoot.scrollTo({ top: target, behavior: 'instant' }); return }
    if (glideTarget !== undefined && Math.abs(glideTarget - target) < 1) return
    glideTarget = target
    scrollRoot.scrollTo({ top: target, behavior: 'smooth' })
    window.clearTimeout(glideTimer)
    glideTimer = window.setTimeout(() => {
      if (glideTarget !== undefined && Math.abs(scrollRoot.scrollTop - glideTarget) > 1) scrollRoot.scrollTo({ top: glideTarget, behavior: 'instant' })
      glideTarget = undefined
    }, 450)
  }

  function measure() {
    const reason = move
    move = undefined
    const committed = committing
    committing = false
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

    if (selectingByTouch()) { hide(); return }

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
    // Text that wrapped onto the next line: the caret returns like a carriage, then slides down.
    const wrapped = target && x < target.x && y > target.y && y - target.y < 2.5 * height
    let kind: CaretMove = 'snap'
    if (follower.position && !reducedMotion.matches && (reason === 'input' || reason === 'commit' || committed && reason !== 'snap')) {
      kind = sameLine ? (reason === 'commit' || committed ? 'commit' : 'glide') : wrapped ? 'wrap' : 'snap'
    }
    const focus = nativeSelection?.focusNode
    const element = focus instanceof Element ? focus : focus?.parentElement
    const text = element && body.contains(element) ? element : body
    const zoom = text.currentCSSZoom ?? 1
    if (smooth && (moved || !follower.position)) {
      const width = kind === 'glide' ? characterWidth(focus, nativeSelection?.focusOffset ?? 0, parseFloat(getComputedStyle(text).fontSize) * zoom) / scaleX : 0
      follower.move({ x, y }, kind, width)
    }
    if (shouldReveal) {
      const margin = 2 * (parseFloat(getComputedStyle(text).lineHeight) * zoom || coords.bottom - coords.top)
      const space = `${Math.ceil(margin / scaleY)}px`
      if (paper.style.getPropertyValue('--writing-bottom-space') !== space) paper.style.setProperty('--writing-bottom-space', space)
      revealInput(coords, margin, inComposition)
    }
    target = { x, y }
    // With smooth typing off the text keeps the system caret; only the scrolling above still runs.
    if (!smooth) { caret.hidden = true; follower.reset(); return }
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
    glideTarget = undefined
    window.clearTimeout(glideTimer)
    // Stop an in-flight smooth scroll as soon as the user starts browsing.
    if (typewriter) scrollRoot.scrollTo({ top: scrollRoot.scrollTop, behavior: 'instant' })
  }
  function transaction({ transaction }: { transaction: Transaction }) {
    const typing = inputPending
    if (transaction.docChanged) {
      reveal ||= inputPending
      inputPending = false
    }
    const typed = !held && (typing || committing) || composing || editor.view.composing
    if (isHistoryTransaction(transaction) || transaction.getMeta('pointer') || ['paste', 'drop', 'cut'].includes(transaction.getMeta('uiEvent'))) schedule('snap')
    // Replacements, insertions from tools and other changes that were not typed arrive at once.
    else if (transaction.docChanged) schedule(typed ? 'input' : 'snap')
    else if ((composing || editor.view.composing) && transaction.selectionSet) schedule('input')
    else if (transaction.selectionSet) schedule('snap')
    else schedule()
  }
  function preferences() {
    typewriter = appearance().typewriter
    smooth = appearance().smoothTyping
    paper.classList.toggle('typewriter-writing', typewriter && editor.isEditable)
    paper.classList.toggle('plain-caret', !smooth)
    if (!smooth) hide()
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
    held = event.repeat || ['Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)
      || (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())
    if (held) schedule('snap')
  }, { capture: true, signal })
  body.addEventListener('keyup', () => { held = false }, { capture: true, signal })
  const input = (event: Event) => {
    const inputType = (event as InputEvent).inputType ?? ''
    // Pasting, dropping, cutting and history land at once; only typing slides.
    const typing = composing || editor.view.composing || /^(insertText|insertCompositionText|delete(Content|Word)(Backward|Forward))$/.test(inputType)
    inputPending = typing
    reveal ||= typing
    // Held keys still keep the caret in view, but land at once.
    schedule(typing && (!held || composing || editor.view.composing) ? 'input' : 'snap')
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
    committing = true
    reveal = true
    schedule('commit')
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
      window.clearTimeout(glideTimer)
      follower.destroy()
      composition.destroy()
      caret.remove()
      paper.classList.remove('smooth-writing', 'typewriter-writing', 'native-caret', 'plain-caret')
      paper.style.removeProperty('--typewriter-space')
      paper.style.removeProperty('--writing-bottom-space')
    },
  }
}
