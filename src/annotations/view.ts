import { t } from '../i18n'
import { formDialog } from '../dialogs'
import { storageError } from '../library'
import { button, element } from '../ui'
import { anchorMatches, annotationColors, inlineAnnotationColors, emptyAnnotations, maxAnnotationLength, popupPosition, sourceHash } from './model'
import type { ReadingAnchor, ReadingAnnotation } from './model'
import { readAnnotations, saveAnnotations } from './store'
import type { AnnotationTarget } from './store'
import type { AnnotationSurface, ReadingSelection } from './surface'
import { inlineAnnotationLayer } from './inline-view'
import './annotations.css'

/** Owns only reading UI. All listeners, timers and portals live exactly as long as the surface. */
export interface ReadingAnnotationOptions {
  /**
   * The page shows its own selection tools and keeps the list in a panel of its own: the
   * floating "add" button is left out and the list is always expanded.
   */
  embedded?: boolean
  onChange?: (count: number) => void
}

export interface ReadingAnnotations {
  (): void
  /** Opens the new-note form for the current selection; false when nothing usable is selected. */
  addFromSelection: () => boolean
  setAllDisplay: (display: 'inline' | 'mark') => void
  count: () => number
}

export function readingAnnotations(
  surface: AnnotationSurface, host: HTMLElement, target: AnnotationTarget, parentSignal: AbortSignal, options: ReadingAnnotationOptions = {},
): ReadingAnnotations {
  const lifetime = new AbortController()
  const { signal } = lifetime
  const previousTabIndex = surface.element.getAttribute('tabindex')
  surface.element.tabIndex = 0
  let dead = false
  let ready = false
  let busy = false
  let hash = ''
  let data = emptyAnnotations()
  let pendingSelection: ReadingSelection | undefined
  let activeIds: string[] = []
  let pinned = false
  let origin: HTMLElement | undefined
  let originLine = 0
  let closeTimer: number | undefined
  let frame = 0
  let selecting = false, keyboardSelecting = false, selectionArmed = false
  let lastAnchor: DOMRect | undefined
  let dialog: HTMLDialogElement | undefined
  const valid = (item: ReadingAnnotation) => anchorMatches(item.anchor, hash, surface.kind, surface.size, surface.quote)

  const manager = element('details', 'annotation-manager')
  manager.dataset.annotationUi = ''
  const summary = element('summary', '', t('annotations.title'))
  const list = element('div', 'annotation-list')
  const message = element('p', 'field-error')
  message.setAttribute('role', 'alert')
  message.hidden = true
  manager.append(summary, message, list)
  if (options.embedded) { manager.open = true; manager.classList.add('annotation-manager-embedded') }
  host.append(manager)

  function portal(className: string) {
    const node = element('div', `annotation-floating ${className}`)
    node.dataset.annotationUi = ''
    node.setAttribute('popover', 'manual')
    document.body.append(node)
    return node
  }
  const selectionTools = portal('annotation-selection')
  const add = button(t('annotations.add'), 'button button-primary button-small', 'plus')
  add.addEventListener('mousedown', (event) => event.preventDefault())
  selectionTools.append(add)
  const popup = portal('annotation-popup')
  popup.tabIndex = -1
  popup.setAttribute('role', 'dialog')
  popup.setAttribute('aria-label', t('annotations.title'))
  const inline = inlineAnnotationLayer(surface, signal, repositionPopup)

  function hide(node: HTMLElement) { if (node.matches(':popover-open')) node.hidePopover() }
  function hideSelection() { hide(selectionTools); pendingSelection = undefined }
  function closePopup(focus = false) {
    window.clearTimeout(closeTimer)
    hide(popup)
    if (focus && origin?.isConnected) origin.focus({ preventScroll: true })
    activeIds = []
    pinned = false
    origin = undefined
  }
  function report(cause: unknown) { message.textContent = storageError(cause); message.hidden = false; manager.open = true }
  function viewport() {
    const view = window.visualViewport
    return { left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0, width: view?.width ?? innerWidth, height: view?.height ?? innerHeight }
  }
  function place(node: HTMLElement, rect: DOMRect) {
    const view = viewport()
    node.style.maxWidth = `${Math.max(1, node === popup ? Math.min(320, view.width - 20) : view.width - 20)}px`
    const free = Math.max(rect.top - view.top - 18, view.top + view.height - rect.bottom - 18)
    node.style.maxHeight = `${Math.max(1, node === popup ? Math.min(free, view.height - 20) : view.height - 20)}px`
    if (!node.matches(':popover-open')) node.showPopover()
    const box = node.getBoundingClientRect()
    const position = popupPosition(rect, box.width, box.height, view)
    node.style.left = `${position.left}px`
    node.style.top = `${position.top}px`
  }

  function themeInlineColor() {
    const probe = element('span')
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--muted)'
    manager.append(probe)
    const channels = getComputedStyle(probe).color.match(/[\d.]+/g)
    probe.remove()
    return channels?.length === 3 ? '#' + channels.map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('') : inlineAnnotationColors[0]
  }

  function fields(item: ReadingAnnotation | undefined, defaultColor: string) {
    const textLabel = element('label', 'field-label', t('annotations.content'))
    const text = element('textarea', 'title-input annotation-input')
    text.name = 'text'; text.rows = 5; text.required = true; text.maxLength = maxAnnotationLength
    text.value = item?.text ?? ''
    textLabel.append(text, element('span', 'dialog-help', t('annotations.limit', [maxAnnotationLength])))
    const displayLabel = element('label', 'field-label', t('annotations.display'))
    const display = element('select', 'title-input')
    display.name = 'display'
    for (const value of ['mark', 'inline'] as const) {
      const option = element('option', '', t(`annotations.${value}`))
      option.value = value; display.append(option)
    }
    display.value = item?.display ?? 'mark'
    displayLabel.append(display)
    const explicit = element('input')
    explicit.type = 'hidden'; explicit.name = 'inlineColorSet'; explicit.value = item?.inlineColor ? '1' : ''
    function palette(isInline: boolean) {
      const values = isInline ? inlineAnnotationColors : annotationColors
      const colors = element('fieldset', 'annotation-colors')
      colors.append(element('legend', '', t(isInline ? 'annotations.inlineColor' : 'annotations.color')))
      const color = element('input')
      color.type = 'color'; color.name = isInline ? 'inlineColor' : 'color'
      color.value = isInline ? item?.inlineColor ?? defaultColor : item?.color ?? annotationColors[0]
      color.setAttribute('aria-label', t(isInline ? 'annotations.customInlineColor' : 'annotations.customColor'))
      function refresh() {
        for (const [i, preset] of [...colors.querySelectorAll('button')].entries()) preset.setAttribute('aria-pressed', String(color.value === values[i]))
      }
      for (const [i, value] of values.entries()) {
        const label = t(`annotations.${isInline ? 'inlineColor' : 'color'}${i}`)
        const preset = button(isInline ? '' : label, 'annotation-swatch')
        preset.setAttribute('aria-label', label); preset.title = label
        preset.style[isInline ? 'color' : 'backgroundColor'] = value
        if (isInline) { preset.classList.add('annotation-font-swatch'); preset.append('Aa') }
        preset.addEventListener('click', () => { color.value = value; if (isInline) explicit.value = '1'; refresh() })
        colors.append(preset)
      }
      color.addEventListener('input', () => { if (isInline) explicit.value = '1'; refresh() })
      colors.append(color)
      refresh()
      return colors
    }
    const highlights = palette(false), fonts = palette(true)
    const refreshMode = () => { highlights.hidden = display.value !== 'mark'; fonts.hidden = display.value !== 'inline' }
    display.addEventListener('change', refreshMode)
    refreshMode()
    return [textLabel, displayLabel, highlights, fonts, explicit]
  }

  async function persist(items: ReadingAnnotation[], expected = data.revision) {
    if (dead) throw new Error(t('annotations.closed'))
    try {
      data = await saveAnnotations(target, expected, items)
      if (!dead) { message.hidden = true; closePopup(); paint() }
    } catch (cause) {
      // Keep the user's draft open; refresh metadata without retrying or overwriting another window.
      try { data = await readAnnotations(target); if (!dead) paint() } catch { /* Keep the initial error. */ }
      throw cause
    }
  }

  function edit(item?: ReadingAnnotation, selection?: ReadingSelection) {
    if (!ready || busy || dialog?.isConnected || dead) return
    const expected = data.revision
    const items = data.items
    const anchor: ReadingAnchor | undefined = item?.anchor ?? (selection && {
      version: 1, kind: surface.kind, from: selection.from, to: selection.to, quote: selection.quote, sourceHash: hash,
    })
    if (!anchor) return
    hideSelection(); closePopup()
    window.getSelection()?.removeAllRanges()
    const defaultInlineColor = themeInlineColor()
    formDialog(document.body, {
      title: t(item ? 'annotations.edit' : 'annotations.add'), action: t('annotations.save'),
      fields: fields(item, defaultInlineColor),
    }, async (form) => {
      const text = String(form.get('text')).trim()
      if (!text || text.length > maxAnnotationLength) throw new Error(t('annotations.invalid'))
      const next: ReadingAnnotation = {
        id: item?.id ?? crypto.randomUUID(), anchor, text, color: String(form.get('color')),
        inlineColor: form.get('inlineColorSet') === '1' ? String(form.get('inlineColor')) : item?.inlineColor,
        display: form.get('display') === 'inline' ? 'inline' : 'mark', collapsed: item?.collapsed ?? true, createdAt: item?.createdAt ?? Date.now(),
      }
      await persist(item ? items.map((entry) => entry.id === item.id ? next : entry) : [...items, next], expected)
    })
    dialog = document.body.lastElementChild as HTMLDialogElement
    dialog.classList.add('annotation-dialog')
    dialog.addEventListener('close', () => { dialog = undefined; hideSelection() }, { once: true })
  }

  function remove(item: ReadingAnnotation) {
    if (busy || dialog?.isConnected) return
    closePopup(); hideSelection()
    const expected = data.revision, items = data.items
    formDialog(document.body, {
      title: t('annotations.delete'), action: t('annotations.confirmDelete'), danger: true,
      description: t('annotations.deleteHelp'),
    }, async () => persist(items.filter((entry) => entry.id !== item.id), expected))
    dialog = document.body.lastElementChild as HTMLDialogElement
    dialog.addEventListener('close', () => { dialog = undefined }, { once: true })
  }

  async function mutate(items: ReadingAnnotation[]) {
    if (busy || dead) return
    busy = true
    try { await persist(items) } catch (cause) { if (!dead) report(cause) }
    finally { busy = false }
  }

  function card(item: ReadingAnnotation) {
    const node = element('section', 'annotation-card')
    node.dataset.annotationUi = ''
    node.dataset.annotationId = item.id
    if (!valid(item)) node.append(element('p', 'annotation-invalid', t('annotations.invalidAnchor')))
    node.append(element('p', 'annotation-text', item.text))
    const actions = element('div', 'annotation-actions')
    for (const [label, symbol, action] of [
      ['annotations.edit', 'edit', () => edit(item)], ['annotations.delete', 'trash', () => remove(item)],
    ] as const) {
      const control = button('', 'annotation-action', symbol)
      control.setAttribute('aria-label', t(label)); control.title = t(label)
      control.addEventListener('click', action)
      actions.append(control)
    }
    node.append(actions)
    return node
  }

  function paint() {
    if (dead) return
    options.onChange?.(data.items.length)
    summary.textContent = t('annotations.count', [data.items.length])
    const validItems = data.items.filter(valid)
    surface.render(validItems)
    inline.render(validItems)
    list.replaceChildren()
    if (!data.items.length) { list.append(element('p', 'dialog-help', t('annotations.empty'))); return }
    const modes = element('div', 'annotation-actions')
    for (const display of ['inline', 'mark'] as const) {
      const change = button(t(`annotations.all${display}`), 'button button-quiet button-small')
      change.addEventListener('click', () => { void mutate(data.items.map((item) => ({ ...item, display }))) })
      modes.append(change)
    }
    list.append(modes, ...data.items.map((item) => card(item)))
  }

  function idsAt(node: EventTarget | null) {
    const mark = node instanceof Element ? node.closest<HTMLElement>('[data-annotation-ids]') : null
    if (!mark || (!surface.element.contains(mark) && !inline.element.contains(mark))) return
    return { mark, ids: (mark.dataset.annotationIds ?? '').split(' ').filter(Boolean) }
  }
  function markRect(mark: HTMLElement, y?: number) {
    if (inline.element.contains(mark)) return inline.anchor(mark)
    const rects = [...mark.getClientRects()]
    if (y !== undefined) originLine = Math.max(0, rects.findIndex((rect) => y >= rect.top && y <= rect.bottom))
    return rects[originLine] ?? mark.getBoundingClientRect()
  }
  function pinPopup() {
    if (!popup.matches(':popover-open')) return
    pinned = true; popup.dataset.pinned = 'true'
  }
  function showPopup(ids: string[], mark: HTMLElement, fix: boolean, y?: number) {
    if (!ready || dead || selecting || keyboardSelecting || dialog?.isConnected || pendingSelection || (pinned && !fix)) return
    window.clearTimeout(closeTimer)
    if (origin === mark && popup.matches(':popover-open') && activeIds.join(' ') === ids.join(' ')) { if (fix) pinPopup(); return }
    activeIds = ids; origin = mark; pinned = fix
    popup.dataset.pinned = String(pinned)
    popup.replaceChildren(...activeIds.map((id) => data.items.find((item) => item.id === id)).filter((item): item is ReadingAnnotation => !!item).map(card))
    lastAnchor = markRect(mark, y)
    place(popup, lastAnchor)
  }
  function laterClose() {
    window.clearTimeout(closeTimer)
    if (!pinned) closeTimer = window.setTimeout(() => { if (!popup.matches(':hover') && !origin?.matches(':hover') && !popup.contains(document.activeElement)) closePopup() }, 300)
  }
  for (const reading of [surface.element, inline.element]) {
    reading.addEventListener('pointerover', (event) => {
      const hit = idsAt(event.target)
      if (hit) showPopup(hit.ids, hit.mark, false, event.clientY)
    }, { signal })
    reading.addEventListener('pointerout', laterClose, { signal })
    reading.addEventListener('click', (event) => {
      if (surface.element.contains(event.target as Node) && surface.selection()) return
      const hit = idsAt(event.target)
      if (hit) showPopup(hit.ids, hit.mark, true, event.clientY)
    }, { signal })
    reading.addEventListener('keydown', (event) => {
      const hit = idsAt(event.target)
      if (hit && ['Enter', ' '].includes(event.key)) {
        event.preventDefault(); showPopup(hit.ids, hit.mark, true); popup.focus({ preventScroll: true })
      }
    }, { signal })
  }
  popup.addEventListener('pointerenter', () => window.clearTimeout(closeTimer), { signal })
  popup.addEventListener('pointerleave', laterClose, { signal })
  popup.addEventListener('click', pinPopup, { signal })
  popup.addEventListener('focusin', pinPopup, { signal })

  function refreshSelection() {
    if (options.embedded) return hideSelection()
    if (dead || !ready || selecting || keyboardSelecting || !selectionArmed || dialog?.isConnected || document.querySelector('dialog[open]')
      || document.activeElement?.matches('input, textarea, select')) return hideSelection()
    const selection = surface.selection()
    if (!selection) return hideSelection()
    closePopup()
    pendingSelection = selection
    place(selectionTools, selection.rect)
  }
  function scheduleSelection() {
    cancelAnimationFrame(frame)
    if (selecting || keyboardSelecting || !selectionArmed) {
      if (selecting && surface.selection()) closePopup()
      return hideSelection()
    }
    frame = requestAnimationFrame(refreshSelection)
  }
  document.addEventListener('selectionchange', scheduleSelection, { signal })
  document.addEventListener('pointerup', () => {
    if (!selecting) return
    selecting = false; selectionArmed = true; inline.element.removeAttribute('data-selecting')
    scheduleSelection()
  }, { signal })
  surface.element.addEventListener('mouseup', (event) => { if (event.button === 0 && !selecting) { selectionArmed = true; scheduleSelection() } }, { signal })
  surface.element.addEventListener('keyup', (event) => {
    if (keyboardSelecting && event.shiftKey) return
    keyboardSelecting = false; selectionArmed = true; scheduleSelection()
  }, { signal })
  surface.element.addEventListener('keydown', (event) => {
    if (!event.shiftKey || event.isComposing || !/^(Arrow(Left|Right|Up|Down)|Home|End)$/.test(event.key)) return
    const selection = window.getSelection()
    if (!selection?.modify) return
    keyboardSelecting = true; selectionArmed = true; hideSelection()
    if (!selection.anchorNode || !selection.focusNode || !surface.element.contains(selection.anchorNode) || !surface.element.contains(selection.focusNode)) {
      const range = document.createRange()
      range.selectNodeContents(surface.element); range.collapse(true)
      selection.removeAllRanges(); selection.addRange(range)
    }
    event.preventDefault()
    const backward = /Left|Up|Home/.test(event.key)
    const boundary = /Home|End/.test(event.key)
    const horizontal = /Left|Right/.test(event.key)
    const unit = boundary ? event.ctrlKey || event.metaKey ? 'documentboundary' : 'lineboundary'
      : event.metaKey ? horizontal ? 'lineboundary' : 'documentboundary'
        : event.ctrlKey || event.altKey ? horizontal ? 'word' : 'paragraphboundary' : horizontal ? 'character' : 'line'
    selection.modify('extend', backward ? 'backward' : 'forward', unit)
    if (selection.focusNode && !surface.element.contains(selection.focusNode)) {
      selection.extend(surface.element, backward ? 0 : surface.element.childNodes.length)
    }
  }, { signal, capture: true })
  document.addEventListener('keyup', (event) => {
    if (keyboardSelecting && (event.key === 'Shift' || !event.shiftKey)) { keyboardSelecting = false; selectionArmed = true; scheduleSelection() }
  }, { signal })
  surface.element.addEventListener('copy', (event) => {
    const selection = surface.selection()
    if (selection && event.clipboardData) { event.clipboardData.setData('text/plain', selection.quote); event.preventDefault() }
  }, { signal })
  add.addEventListener('click', () => { if (pendingSelection) edit(undefined, pendingSelection) }, { signal })
  document.addEventListener('focusin', (event) => {
    if (event.target instanceof Node && !surface.element.contains(event.target) && !selectionTools.contains(event.target)) hideSelection()
  }, { signal })
  document.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Node)) return
    if (!selectionTools.contains(event.target)) { hideSelection(); selectionArmed = false }
    if (surface.element.contains(event.target) && event.button === 0) {
      selecting = true; selectionArmed = true; inline.element.dataset.selecting = ''
      if (!idsAt(event.target)) closePopup()
    } else if (inline.element.contains(event.target)) window.getSelection()?.removeAllRanges()
    if (!popup.contains(event.target) && !idsAt(event.target)) closePopup()
  }, { signal })
  document.addEventListener('keydown', (event) => {
    if (event.shiftKey && /^(Arrow|Home|End|Page)/.test(event.key) && surface.element.contains(event.target as Node)) {
      keyboardSelecting = true; selectionArmed = true; hideSelection()
    }
    if (event.key === 'Escape' && !event.isComposing && !dialog?.isConnected) {
      if (pendingSelection) window.getSelection()?.removeAllRanges()
      hideSelection(); closePopup(true)
    }
  }, { signal })
  function cancelSelection() {
    selecting = keyboardSelecting = selectionArmed = false
    inline.element.removeAttribute('data-selecting')
    cancelAnimationFrame(frame); hideSelection()
  }
  document.addEventListener('pointercancel', cancelSelection, { signal })
  window.addEventListener('blur', cancelSelection, { signal })
  function repositionPopup() {
    if (!popup.matches(':popover-open') || !origin) return
    if (!origin.isConnected) {
      const replacement = [...inline.element.querySelectorAll<HTMLElement>('[data-annotation-ids]')]
        .find((node) => activeIds.some((id) => node.dataset.annotationIds?.split(' ').includes(id)))
      if (replacement) origin = replacement
      else if (!pinned) return closePopup()
    }
    const rect = origin.isConnected && !origin.hidden ? markRect(origin) : lastAnchor
    if (!rect) return
    const view = viewport()
    if (!pinned && (origin.hidden || rect.bottom < view.top || rect.top > view.top + view.height)) closePopup()
    else { lastAnchor = rect; place(popup, rect) }
  }
  const reposition = () => { hideSelection(); repositionPopup() }
  document.addEventListener('scroll', reposition, { signal, capture: true })
  window.addEventListener('resize', reposition, { signal })
  window.visualViewport?.addEventListener('resize', reposition, { signal })
  window.visualViewport?.addEventListener('scroll', reposition, { signal })
  manager.addEventListener('toggle', () => {
    if (options.embedded && !manager.open) manager.open = true
    hideSelection(); closePopup()
  }, { signal })

  void Promise.all([sourceHash(surface.source), readAnnotations(target)]).then(([digest, stored]) => {
    if (dead) return
    hash = digest; data = stored; ready = true; paint()
  }, (cause) => { if (!dead) report(cause) })

  function destroy() {
    if (dead) return
    dead = true; lifetime.abort(); parentSignal.removeEventListener('abort', destroy)
    window.clearTimeout(closeTimer); cancelAnimationFrame(frame)
    dialog?.remove(); selectionTools.remove(); popup.remove(); manager.remove(); surface.destroy()
    if (previousTabIndex === null) surface.element.removeAttribute('tabindex')
    else surface.element.setAttribute('tabindex', previousTabIndex)
  }
  parentSignal.addEventListener('abort', destroy, { once: true })
  return Object.assign(destroy, {
    addFromSelection() {
      const selection = ready && !dead ? surface.selection() : undefined
      if (!selection) return false
      edit(undefined, selection)
      return true
    },
    setAllDisplay(display: 'inline' | 'mark') {
      if (data.items.length) void mutate(data.items.map((item) => ({ ...item, display })))
    },
    count: () => data.items.length,
  })
}
