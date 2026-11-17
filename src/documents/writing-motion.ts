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
  let center = false
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

  function viewport() {
    const visual = window.visualViewport
    const top = visual?.offsetTop ?? 0
    const bottom = top + (visual?.height ?? innerHeight)
    const rect = scroller?.getBoundingClientRect()
    const visibleTop = Math.max(top, rect ? rect.top + scroller!.clientTop : top)
    const visibleBottom = Math.min(bottom, rect ? rect.top + scroller!.clientTop + scroller!.clientHeight : bottom)
    return { top: visibleTop + (toolbar?.offsetHeight ?? 0), bottom: visibleBottom }
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

  function measure() {
    const reason = move
    move = undefined
    const shouldCenter = center
    center = false
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
    if (!position || reason === 'snap' || reducedMotion.matches || moved && (reason !== 'input' || !sameLine)) position = { x, y }
    target = { x, y }
    caret.style.height = `${height}px`
    caret.hidden = false
    if (moved) {
      // Restart the blink without forcing layout, keeping the caret lit while typing.
      for (const animation of caret.getAnimations({ subtree: true })) animation.startTime = document.timeline.currentTime
    }

    if (typewriter && shouldCenter && !inComposition) {
      const visible = viewport()
      const delta = (coords.top + coords.bottom - visible.top - visible.bottom) / 2
      if (visible.bottom > visible.top && Math.abs(delta) > 2) {
        scrollRoot.scrollTo({ top: scrollRoot.scrollTop + delta, behavior: reducedMotion.matches ? 'instant' : 'smooth' })
      }
    }
  }

  // Scrolling carries the caret with the paper. Unchanged local targets keep following.
  function layout() { schedule() }
  function resize() {
    const visible = viewport()
    paper.style.setProperty('--typewriter-space', `${Math.max(0, (visible.bottom - visible.top) / 2)}px`)
    layout()
  }
  function cancelCenter() {
    center = inputPending = false
    // Stop an in-flight smooth scroll as soon as the user starts browsing.
    if (typewriter) scrollRoot.scrollTo({ top: scrollRoot.scrollTop, behavior: 'instant' })
  }
  function transaction({ transaction }: { transaction: Transaction }) {
    if (transaction.docChanged) {
      center ||= inputPending
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
    if (reducedMotion.matches) cancelCenter()
    schedule('snap')
  }

  body.addEventListener('keydown', (event) => {
    if (event.isComposing || composing || editor.view.composing) return
    inputPending = !event.metaKey && !event.ctrlKey && !event.altKey
      && (event.key.length === 1 || ['Enter', 'Backspace', 'Delete'].includes(event.key))
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)
      || (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) schedule('snap')
  }, { capture: true, signal })
  const input = (event: Event) => {
    const inputType = (event as InputEvent).inputType ?? ''
    const typing = !inputType.startsWith('history') && (composing || editor.view.composing || /^(insert|delete)/.test(inputType))
    inputPending = typing
    center ||= typing
    schedule(typing ? 'input' : 'snap')
  }
  body.addEventListener('beforeinput', input, { signal })
  body.addEventListener('input', input, { signal })
  body.addEventListener('compositionstart', () => {
    composing = true
    center = false
    schedule('input')
  }, { signal })
  body.addEventListener('compositionupdate', () => schedule('input'), { signal })
  body.addEventListener('compositionend', () => {
    composing = false
    center = true
    schedule('input')
  }, { signal })
  body.addEventListener('focus', () => schedule('snap'), { signal })
  body.addEventListener('blur', () => { center = inputPending = false; hide() }, { signal })
  document.addEventListener('visibilitychange', layout, { signal })
  document.addEventListener('scroll', layout, { capture: true, passive: true, signal })
  document.addEventListener('wheel', cancelCenter, { capture: true, passive: true, signal })
  document.addEventListener('touchstart', cancelCenter, { capture: true, passive: true, signal })
  document.addEventListener('pointerdown', () => { cancelCenter(); schedule('snap') }, { capture: true, passive: true, signal })
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
    // ProseMirror's default scrolling would jump before the typewriter scroll begins.
    handlesScroll: () => typewriter && inputPending && !composing && !editor.view.composing,
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
    },
  }
}
