import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { appearance, onAppearanceChange } from '../appearance'
import { reducedMotion } from '../motion'

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
  let animate = false
  let instant = false
  let center = false
  let composing = false
  let inputPending = false
  let typewriter = appearance().typewriter
  let previous: { x: number; y: number } | undefined

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

  function schedule(move = false, snap = false) {
    animate ||= move
    instant ||= snap
    if (!frame) frame = requestAnimationFrame(sync)
  }

  function hide() {
    caret.hidden = true
    previous = undefined
  }

  function sync() {
    frame = 0
    const transition = animate && !instant && !reducedMotion.matches
    const snap = instant
    const shouldCenter = center
    animate = instant = center = false
    if (!editor.isEditable || !editor.view.hasFocus() || document.hidden) { hide(); return }
    // Keep the last committed position while the platform owns the composition.
    if (composing || editor.view.composing) return
    const selection = editor.state.selection
    if (!(selection instanceof TextSelection) || !selection.empty) { hide(); return }

    const coords = editor.view.coordsAtPos(selection.head)
    const rect = paper.getBoundingClientRect()
    if (!rect.width || !rect.height) { hide(); return }
    const scaleX = rect.width / paper.offsetWidth
    const scaleY = rect.height / paper.offsetHeight
    const x = (coords.left - rect.left) / scaleX + paper.scrollLeft - paper.clientLeft
    const y = (coords.top - rect.top) / scaleY + paper.scrollTop - paper.clientTop
    const height = (coords.bottom - coords.top) / scaleY
    const moved = !previous || Math.abs(x - previous.x) > .1 || Math.abs(y - previous.y) > .1
    const shortMove = previous && Math.hypot(x - previous.x, y - previous.y) <= 80
    if (moved || snap || reducedMotion.matches) caret.style.transition = transition && shortMove ? 'transform 75ms ease-out' : 'none'
    caret.style.height = `${height}px`
    caret.style.transform = `translate(${x}px, ${y}px)`
    caret.hidden = false
    if (moved) {
      // Restart the blink without forcing layout, keeping the caret lit while typing.
      for (const animation of caret.getAnimations({ subtree: true })) animation.startTime = document.timeline.currentTime
    }
    previous = { x, y }

    if (typewriter && shouldCenter) {
      const visible = viewport()
      const delta = (coords.top + coords.bottom - visible.top - visible.bottom) / 2
      if (visible.bottom > visible.top && Math.abs(delta) > 2) {
        scrollRoot.scrollTo({ top: scrollRoot.scrollTop + delta, behavior: reducedMotion.matches ? 'instant' : 'smooth' })
      }
    }
  }

  function layout() { schedule(false, true) }
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
  function transaction({ transaction }: { transaction: { docChanged: boolean; selectionSet: boolean } }) {
    if (transaction.docChanged) {
      center ||= inputPending
      inputPending = false
    }
    if (transaction.docChanged || transaction.selectionSet) schedule(true)
    else schedule()
  }
  function preferences() {
    typewriter = appearance().typewriter
    paper.classList.toggle('typewriter-writing', typewriter && editor.isEditable)
    resize()
  }
  function motionPreference() {
    caret.style.transition = 'none'
    if (reducedMotion.matches) cancelCenter()
    layout()
  }

  body.addEventListener('keydown', (event) => {
    inputPending = !event.metaKey && !event.ctrlKey && !event.altKey
      && (event.key.length === 1 || ['Enter', 'Backspace', 'Delete'].includes(event.key))
  }, { capture: true, signal })
  body.addEventListener('beforeinput', () => { inputPending = true }, { signal })
  body.addEventListener('input', () => { center = true; schedule(true) }, { signal })
  body.addEventListener('compositionstart', () => {
    composing = true
    center = false
    caret.style.transition = 'none'
  }, { signal })
  body.addEventListener('compositionend', () => {
    composing = false
    center = true
    schedule(false, true)
  }, { signal })
  body.addEventListener('focus', () => schedule(), { signal })
  body.addEventListener('blur', () => { center = inputPending = false; hide() }, { signal })
  document.addEventListener('visibilitychange', layout, { signal })
  document.addEventListener('scroll', layout, { capture: true, passive: true, signal })
  document.addEventListener('wheel', cancelCenter, { capture: true, passive: true, signal })
  document.addEventListener('touchstart', cancelCenter, { capture: true, passive: true, signal })
  document.addEventListener('pointerdown', cancelCenter, { capture: true, passive: true, signal })
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
