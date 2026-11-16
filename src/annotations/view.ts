import { t } from '../i18n'
import { formDialog } from '../dialogs'
import { storageError } from '../library'
import { button, element } from '../ui'
import { anchorMatches, annotationColors, emptyAnnotations, maxAnnotationLength, popupPosition, sourceHash } from './model'
import type { ReadingAnchor, ReadingAnnotation } from './model'
import { readAnnotations, saveAnnotations } from './store'
import type { AnnotationTarget } from './store'
import type { AnnotationSurface, ReadingSelection } from './surface'
import './annotations.css'

/** Owns only reading UI. All listeners, timers and portals live exactly as long as the surface. */
export function readingAnnotations(surface: AnnotationSurface, host: HTMLElement, target: AnnotationTarget, parentSignal: AbortSignal) {
  const lifetime = new AbortController()
  const { signal } = lifetime
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
    node.style.maxWidth = `${Math.max(1, view.width - 20)}px`
    node.style.maxHeight = `${Math.max(1, view.height - 20)}px`
    if (!node.matches(':popover-open')) node.showPopover()
    const box = node.getBoundingClientRect()
    const position = popupPosition(rect, box.width, box.height, view)
    node.style.left = `${position.left}px`
    node.style.top = `${position.top}px`
  }

  function fields(item?: ReadingAnnotation) {
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
    const colors = element('fieldset', 'annotation-colors')
    colors.append(element('legend', '', t('annotations.color')))
    const color = element('input')
    color.type = 'color'; color.name = 'color'; color.value = item?.color ?? annotationColors[0]
    color.setAttribute('aria-label', t('annotations.customColor'))
    for (const [i, value] of annotationColors.entries()) {
      const preset = button(t(`annotations.color${i}`), 'annotation-swatch')
      preset.style.backgroundColor = value
      preset.setAttribute('aria-pressed', String(color.value === value))
      preset.addEventListener('click', () => { color.value = value; refresh() })
      colors.append(preset)
    }
    function refresh() {
      for (const [i, preset] of [...colors.querySelectorAll('button')].entries()) preset.setAttribute('aria-pressed', String(color.value === annotationColors[i]))
    }
    color.addEventListener('input', refresh)
    colors.append(color)
    return [textLabel, displayLabel, colors]
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
    const quote = element('blockquote', 'annotation-quote', anchor.quote.slice(0, 500))
    formDialog(document.body, {
      title: t(item ? 'annotations.edit' : 'annotations.add'), action: t('annotations.save'),
      fields: [quote, ...fields(item)],
    }, async (form) => {
      const text = String(form.get('text')).trim()
      if (!text || text.length > maxAnnotationLength) throw new Error(t('annotations.invalid'))
      const next: ReadingAnnotation = {
        id: item?.id ?? crypto.randomUUID(), anchor, text, color: String(form.get('color')),
        display: form.get('display') === 'inline' ? 'inline' : 'mark', collapsed: item?.collapsed ?? false, createdAt: item?.createdAt ?? Date.now(),
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

  function card(item: ReadingAnnotation, inline = false) {
    const node = element('section', inline ? 'annotation-card annotation-inline' : 'annotation-card')
    node.dataset.annotationUi = ''
    node.dataset.annotationId = item.id
    node.style.setProperty('--annotation-color', item.color)
    if (inline) node.contentEditable = 'false'
    const head = element('div', 'annotation-card-head')
    const title = element('strong', '', t('annotations.note'))
    head.append(title)
    if (inline) {
      const toggle = button(t(item.collapsed ? 'annotations.expand' : 'annotations.collapse'), 'button button-quiet button-small')
      toggle.setAttribute('aria-expanded', String(!item.collapsed))
      toggle.addEventListener('click', () => { void mutate(data.items.map((entry) => entry.id === item.id ? { ...entry, collapsed: !entry.collapsed } : entry)) })
      head.append(toggle)
    }
    node.append(head)
    if (!inline || !item.collapsed) {
      if (!valid(item)) node.append(element('p', 'annotation-invalid', t('annotations.invalidAnchor')))
      const quote = element('blockquote', 'annotation-quote', item.anchor.quote.slice(0, 160))
      const text = element('p', 'annotation-text', item.text)
      const actions = element('div', 'annotation-actions')
      const update = button(t('annotations.edit'), 'button button-quiet button-small', 'edit')
      update.addEventListener('click', () => edit(item))
      const erase = button(t('annotations.delete'), 'button button-quiet button-small remove-button', 'trash')
      erase.addEventListener('click', () => remove(item))
      actions.append(update, erase)
      node.append(quote, text, actions)
    }
    return node
  }

  function paint() {
    if (dead) return
    summary.textContent = t('annotations.count', [data.items.length])
    surface.render(data.items.filter(valid), (item) => card(item, true))
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
    if (!mark || !surface.element.contains(mark)) return
    return { mark, ids: (mark.dataset.annotationIds ?? '').split(' ').filter(Boolean) }
  }
  function markRect(mark: HTMLElement, y?: number) {
    const rects = [...mark.getClientRects()]
    if (y !== undefined) originLine = Math.max(0, rects.findIndex((rect) => y >= rect.top && y <= rect.bottom))
    return rects[originLine] ?? mark.getBoundingClientRect()
  }
  function pinPopup() {
    if (!popup.matches(':popover-open')) return
    pinned = true; popup.dataset.pinned = 'true'
    const label = popup.querySelector('.annotation-popup-head .dialog-help')
    if (label) label.textContent = t('annotations.pinned')
  }
  function showPopup(ids: string[], mark: HTMLElement, fix: boolean, y?: number) {
    if (!ready || dead || dialog?.isConnected || pendingSelection || (pinned && !fix)) return
    window.clearTimeout(closeTimer)
    if (origin === mark && popup.matches(':popover-open')) { if (fix) pinPopup(); return }
    activeIds = ids; origin = mark; pinned = fix
    popup.dataset.pinned = String(pinned)
    const header = element('div', 'annotation-popup-head')
    header.append(element('span', 'dialog-help', t(fix ? 'annotations.pinned' : 'annotations.pinHelp')))
    const close = button(t('annotations.close'), 'button button-quiet button-small', 'close')
    close.addEventListener('click', (event) => { event.stopPropagation(); closePopup(true) })
    header.append(close)
    popup.replaceChildren(header, ...activeIds.map((id) => data.items.find((item) => item.id === id)).filter((item): item is ReadingAnnotation => !!item).map((item) => card(item)))
    place(popup, markRect(mark, y))
  }
  function laterClose() {
    window.clearTimeout(closeTimer)
    if (!pinned) closeTimer = window.setTimeout(() => { if (!popup.matches(':hover') && !origin?.matches(':hover') && !popup.contains(document.activeElement)) closePopup() }, 300)
  }
  surface.element.addEventListener('pointerover', (event) => {
    const hit = idsAt(event.target)
    if (hit) showPopup(hit.ids, hit.mark, false, event.clientY)
  }, { signal })
  surface.element.addEventListener('pointerout', laterClose, { signal })
  surface.element.addEventListener('click', (event) => {
    if (surface.selection()) return
    const hit = idsAt(event.target)
    if (hit) showPopup(hit.ids, hit.mark, true, event.clientY)
  }, { signal })
  surface.element.addEventListener('keydown', (event) => {
    const hit = idsAt(event.target)
    if (hit && ['Enter', ' '].includes(event.key)) {
      event.preventDefault(); showPopup(hit.ids, hit.mark, true); popup.focus({ preventScroll: true })
    }
  }, { signal })
  popup.addEventListener('pointerenter', () => window.clearTimeout(closeTimer), { signal })
  popup.addEventListener('pointerleave', laterClose, { signal })
  popup.addEventListener('click', pinPopup, { signal })
  popup.addEventListener('focusin', pinPopup, { signal })

  function refreshSelection() {
    if (dead || !ready || dialog?.isConnected || document.querySelector('dialog[open]')) return hideSelection()
    const selection = surface.selection()
    if (!selection) return hideSelection()
    closePopup()
    pendingSelection = selection
    place(selectionTools, selection.rect)
  }
  document.addEventListener('selectionchange', () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(refreshSelection)
  }, { signal })
  surface.element.addEventListener('mouseup', refreshSelection, { signal })
  surface.element.addEventListener('keyup', refreshSelection, { signal })
  surface.element.addEventListener('copy', (event) => {
    const selection = surface.selection()
    if (selection && event.clipboardData) { event.clipboardData.setData('text/plain', selection.quote); event.preventDefault() }
  }, { signal })
  add.addEventListener('click', () => { if (pendingSelection) edit(undefined, pendingSelection) }, { signal })
  document.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Node)) return
    if (!selectionTools.contains(event.target)) hideSelection()
    if (!popup.contains(event.target) && !idsAt(event.target)) closePopup()
  }, { signal })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.isComposing && !dialog?.isConnected) { hideSelection(); closePopup(true) }
  }, { signal })
  const reposition = () => {
    hideSelection()
    if (popup.matches(':popover-open') && origin?.isConnected) {
      const rect = markRect(origin), view = viewport()
      if (rect.bottom < view.top || rect.top > view.top + view.height || rect.right < view.left || rect.left > view.left + view.width) { if (!pinned) closePopup(); else place(popup, rect) }
      else place(popup, rect)
    }
  }
  document.addEventListener('scroll', reposition, { signal, capture: true })
  window.addEventListener('resize', reposition, { signal })
  window.visualViewport?.addEventListener('resize', reposition, { signal })
  window.visualViewport?.addEventListener('scroll', reposition, { signal })
  const resize = new ResizeObserver(reposition)
  resize.observe(surface.element)
  manager.addEventListener('toggle', () => { hideSelection(); closePopup() }, { signal })

  void Promise.all([sourceHash(surface.source), readAnnotations(target)]).then(([digest, stored]) => {
    if (dead) return
    hash = digest; data = stored; ready = true; paint()
  }, (cause) => { if (!dead) report(cause) })

  function destroy() {
    if (dead) return
    dead = true; lifetime.abort(); parentSignal.removeEventListener('abort', destroy)
    window.clearTimeout(closeTimer); cancelAnimationFrame(frame); resize.disconnect()
    dialog?.remove(); selectionTools.remove(); popup.remove(); manager.remove(); surface.destroy()
  }
  parentSignal.addEventListener('abort', destroy, { once: true })
  return destroy
}
