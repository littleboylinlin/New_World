import type { Editor } from '@tiptap/core'
import { t } from '../i18n'
import { afterTransition } from '../motion'
import { setExpanded } from '../shell/collapse'
import { visibleArea } from '../shell/popover'
import { button, element, icon } from '../ui'
import type { IconName } from '../ui'

/** How long a finished selection waits before its tools appear. */
export const selectionDelay = 200

interface SelectionToolbarOptions {
  getEditor: () => Editor
  isEditing: () => boolean
  /** The pane that scrolls the text; the tools never sit outside it. */
  scroller: HTMLElement
  /** On touch screens the tools slide out of this block under the top toolbar instead. */
  strip: HTMLElement
  actions: {
    bold: () => void
    italic: () => void
    idea: (text: string) => void
    task: () => void
    annotate: () => void
  }
  signal: AbortSignal
}

const navigation = /^(Arrow(Left|Right|Up|Down)|Home|End|Page(Up|Down))$/

/**
 * A small set of tools for selected text. It appears only once a selection is finished (the mouse
 * is released, or the keyboard or the touch handles stop moving) and a short pause has passed.
 * On a mouse it sits beside the selection, flipping to the other side when there is no room; on
 * touch screens it slides out under the top toolbar, clear of the system's own selection menu.
 */
export function selectionToolbar({ getEditor, isEditing, scroller, strip, actions, signal }: SelectionToolbarOptions) {
  const floating = element('div', 'selection-toolbar')
  floating.setAttribute('role', 'toolbar')
  floating.setAttribute('aria-label', t('editor.selectionTools'))
  floating.dataset.state = 'closed'
  floating.hidden = true
  strip.classList.add('selection-strip')
  strip.setAttribute('role', 'toolbar')
  strip.setAttribute('aria-label', t('editor.selectionTools'))
  strip.hidden = true

  function tools(host: HTMLElement) {
    const make = (label: string, content: IconName | { glyph: string; className: string }, invoke: () => void, kind: string) => {
      const node = button('', `selection-tool selection-${kind}`)
      if (typeof content === 'string') node.append(icon(content))
      else node.append(element('span', `format-glyph ${content.className}`, content.glyph))
      node.append(element('span', 'selection-tool-label', label))
      node.setAttribute('aria-label', label)
      node.title = label
      node.dataset.kind = kind
      node.addEventListener('pointerdown', (event) => event.preventDefault())
      node.addEventListener('mousedown', (event) => event.preventDefault())
      node.addEventListener('click', () => { invoke(); paintPressed() })
      host.append(node)
      return node
    }
    return [
      make(t('editor.bold'), { glyph: 'B', className: 'format-bold' }, actions.bold, 'bold'),
      make(t('editor.italic'), { glyph: 'I', className: 'format-italic' }, actions.italic, 'italic'),
      make(t('ideas.capture'), 'idea', () => { const text = currentText(); hide(); actions.idea(text) }, 'idea'),
      make(t('editor.newTask'), 'check', () => { hide(); actions.task() }, 'task'),
      make(t('annotations.add'), 'edit', () => { hide(); actions.annotate() }, 'annotate'),
    ]
  }
  const floatingTools = tools(floating)
  const stripTools = tools(strip)
  document.body.append(floating)

  let pointerDown = false
  let keyboardSelecting = false
  let lastPointer = matchMedia('(hover: none) and (pointer: coarse)').matches ? 'touch' : 'mouse'
  let timer = 0
  let shown: { from: number; to: number } | undefined
  let place: 'floating' | 'strip' | undefined
  let frame = 0
  let settle: (() => void) | undefined

  function range() {
    const selection = document.getSelection()
    const editor = getEditor()
    if (!selection?.rangeCount || selection.isCollapsed || editor.isDestroyed) return
    const dom = editor.view.dom
    const current = selection.getRangeAt(0)
    if (!dom.contains(current.startContainer) || !dom.contains(current.endContainer)) return
    if (!current.toString().trim()) return
    return current
  }
  function currentText() {
    return range()?.toString().trim().slice(0, 4000) ?? ''
  }
  function key() {
    const { from, to } = getEditor().state.selection
    return { from, to }
  }

  function paintPressed() {
    const editor = getEditor()
    for (const node of [...floatingTools, ...stripTools]) {
      const kind = node.dataset.kind
      if (kind === 'bold' || kind === 'italic') {
        node.hidden = !isEditing()
        node.setAttribute('aria-pressed', String(editor.isActive(kind)))
      }
      if (kind === 'annotate') node.hidden = isEditing()
    }
  }

  function bounds() {
    const area = visibleArea()
    const pane = scroller.getBoundingClientRect()
    return {
      top: Math.max(area.top, pane.top), bottom: Math.min(area.bottom, pane.bottom),
      left: Math.max(area.left, pane.left), right: Math.min(area.right, pane.right),
    }
  }

  function position() {
    frame = 0
    if (place !== 'floating') return
    const selected = range()
    if (!selected) { hide(); return }
    const rects = [...selected.getClientRects()].filter((rect) => rect.width || rect.height)
    if (!rects.length) return
    const first = rects[0]
    const last = rects[rects.length - 1]
    const box = bounds()
    const width = floating.offsetWidth
    const height = floating.offsetHeight
    const union = rects.reduce((all, rect) => ({ left: Math.min(all.left, rect.left), right: Math.max(all.right, rect.right) }), { left: Infinity, right: -Infinity })
    const gap = 8
    let top = first.top - height - gap
    let side: 'top' | 'bottom' = 'top'
    if (top < box.top + 4) { top = last.bottom + gap; side = 'bottom' }
    if (side === 'bottom' && top + height > box.bottom - 4) {
      // Neither side has room (a very tall selection): keep the tools in view at the top.
      top = box.top + 4
    }
    const left = Math.max(box.left + 4, Math.min((union.left + union.right) / 2 - width / 2, box.right - width - 4))
    floating.style.left = `${Math.round(left)}px`
    floating.style.top = `${Math.round(top)}px`
    floating.dataset.side = side
    const visible = last.bottom > box.top && first.top < box.bottom
    floating.toggleAttribute('data-offscreen', !visible)
  }
  const schedulePosition = () => { if (!frame) frame = requestAnimationFrame(position) }

  function show() {
    timer = 0
    if (pointerDown || keyboardSelecting || document.querySelector('dialog[open]') || getEditor().view.composing) return
    const selected = range()
    if (!selected) { hide(); return }
    shown = key()
    paintPressed()
    const next = lastPointer === 'touch' ? 'strip' : 'floating'
    if (place && place !== next) hide(true)
    place = next
    if (place === 'strip') {
      setExpanded(strip, true)
      return
    }
    settle?.()
    floating.hidden = false
    floating.dataset.state = 'closed'
    position()
    void floating.offsetWidth
    floating.dataset.state = 'open'
  }

  function hide(instant = false) {
    window.clearTimeout(timer)
    timer = 0
    shown = undefined
    if (place === 'strip') setExpanded(strip, false)
    if (place === 'floating' && !floating.hidden) {
      floating.dataset.state = 'closing'
      settle = afterTransition(floating, 'fast', () => {
        settle = undefined
        if (floating.dataset.state === 'closing') { floating.hidden = true; floating.dataset.state = 'closed' }
      })
      if (instant) settle()
    }
    place = undefined
  }

  function schedule() {
    window.clearTimeout(timer)
    timer = window.setTimeout(show, selectionDelay)
  }

  const isVisible = () => Boolean(place)

  document.addEventListener('pointerdown', (event) => {
    lastPointer = event.pointerType === 'touch' || event.pointerType === 'pen' ? 'touch' : 'mouse'
    const target = event.target as Node
    if (floating.contains(target) || strip.contains(target)) return
    hide()
    if (getEditor().view.dom.contains(target) && event.button === 0) pointerDown = true
  }, { capture: true, signal })
  document.addEventListener('pointerup', () => {
    if (!pointerDown) return
    pointerDown = false
    if (range()) schedule()
  }, { signal })
  document.addEventListener('pointercancel', () => {
    // The browser took over (touch selection handles, or dragging selected text away); a
    // selection that is still there after that gets its tools once things settle.
    if (!pointerDown) return
    pointerDown = false
    if (range()) schedule()
  }, { signal })
  document.addEventListener('dragend', () => { if (range()) schedule() }, { signal })
  document.addEventListener('selectionchange', () => {
    if (pointerDown || keyboardSelecting) return
    const selected = range()
    if (!selected) { if (shown || timer) hide(); return }
    if (shown) {
      const now = key()
      if (now.from === shown.from && now.to === shown.to) { schedulePosition(); return }
      hide()
    }
    schedule()
  }, { signal })
  document.addEventListener('keydown', (event) => {
    if (event.isComposing) { hide(); return }
    if (event.key === 'Escape' && isVisible()) {
      event.preventDefault()
      event.stopPropagation()
      hide()
      // Escape cancels the selection itself; while writing the caret stays at its end.
      const editor = getEditor()
      if (isEditing()) editor.commands.setTextSelection(editor.state.selection.to)
      else document.getSelection()?.removeAllRanges()
      return
    }
    if (event.shiftKey && navigation.test(event.key)) { keyboardSelecting = true; hide(); return }
    if (['Shift', 'Control', 'Meta', 'Alt', 'CapsLock', 'Tab'].includes(event.key)) return
    // Formatting shortcuts keep the selection; anything else that edits or moves ends it.
    if ((event.ctrlKey || event.metaKey) && /^[biu]$/i.test(event.key)) { window.setTimeout(paintPressed); return }
    if (event.ctrlKey || event.metaKey) return
    if (isVisible() || timer) hide()
  }, { capture: true, signal })
  document.addEventListener('keyup', (event) => {
    if (!keyboardSelecting || event.shiftKey && event.key !== 'Shift') return
    keyboardSelecting = false
    if (range()) schedule()
  }, { signal })
  document.addEventListener('compositionstart', () => hide(), { capture: true, signal })
  document.addEventListener('beforeinput', (event) => { if (getEditor().view.dom.contains(event.target as Node)) hide() }, { capture: true, signal })
  scroller.addEventListener('scroll', schedulePosition, { passive: true, signal })
  window.addEventListener('resize', schedulePosition, { signal })
  window.visualViewport?.addEventListener('resize', schedulePosition, { signal })
  window.visualViewport?.addEventListener('scroll', schedulePosition, { signal })
  window.addEventListener('blur', () => { pointerDown = keyboardSelecting = false }, { signal })
  signal.addEventListener('abort', () => {
    window.clearTimeout(timer)
    cancelAnimationFrame(frame)
    floating.remove()
  }, { once: true })

  return {
    hide,
    isVisible,
    /** Called after the text or the mode changed under the tools. */
    refresh() { if (isVisible()) { paintPressed(); schedulePosition() } },
  }
}
