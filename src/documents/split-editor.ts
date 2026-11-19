import { t } from '../i18n'
import { libraryChanges } from '../library'
import { afterTransition, motionMs } from '../motion'
import { setDropHost, draggableEntry } from '../shell/drag-open'
import type { DragPayload } from '../shell/drag-open'
import { menuButton } from '../shell/popover'
import type { ShellMenuItem } from '../shell/popover'
import { createSplitView } from '../shell/split'
import { fits, insertPane, paneIds, removePane } from '../shell/split-tree'
import type { SplitTree, Zone } from '../shell/split-tree'
import { button, element, icon } from '../ui'
import { showNotice } from '../undo'
import { canOpenWindow, defaultSource, mainPane, openWindow, readCatalog, readLayout, readSource, saveLayout, sameSource } from './compare'
import type { CatalogWork, OpenPlacement, ReferenceSource } from './compare'
import { lastChapter } from './editor-prefs'
import type { Edition } from './model'
import { referencePane } from './reference-pane'
import type { ReferencePane } from './reference-pane'

export const paneMinWidth = 260
export const paneMinHeight = 160
const maxReferences = 5

interface SplitEditorOptions {
  /** The workbench's main area; the panes fill it. */
  host: HTMLElement
  /** The editable chapter's pane. */
  main: HTMLElement
  edition: () => Edition
  chapterId: () => string
  /** Shows another chapter in the editable pane, saving the current one first. */
  switchMain: (id: string) => Promise<boolean>
  onFocusChange: () => void
  /** A reference pane loaded, or now shows another chapter. */
  onReferenceChange: (pane: ReferencePane) => void
  /** Before something opens: drawers over the text (chapter list, side panel) step aside. */
  beforeOpen: () => void
  signal: AbortSignal
}

/** A dragged entry: what to open, or a work whose default source is decided on drop. */
export type ComparePayload = { source: ReferenceSource } | { work: CatalogWork }

/**
 * The editor's split view: the editable chapter plus read-only reference panes. Where the window
 * is too narrow to split, the references move into a drawer on the right that swipes between them.
 */
export function mountSplitEditor(options: SplitEditorOptions) {
  const { host, signal } = options
  const refs = new Map<string, ReferencePane>()
  let layout: SplitTree = { pane: mainPane }
  let focused = mainPane
  let narrow = false
  let catalog: CatalogWork[] = []
  let serial = 0

  const split = createSplitView({
    label: t('split.label'), signal, minWidth: paneMinWidth, minHeight: paneMinHeight,
    onLayoutChange: (tree) => { if (!narrow) { layout = tree; persist() } },
    onFocusChange: (id) => { if (!narrow || id !== mainPane || !drawerOpen()) setFocused(id) },
  })
  split.attach(mainPane, options.main)
  split.setTree(layout)

  // ——— The drawer for narrow screens ———
  const drawer = element('aside', 'compare-drawer')
  drawer.setAttribute('aria-label', t('compare.drawer'))
  drawer.dataset.state = 'closed'
  drawer.hidden = true
  drawer.inert = true
  const track = element('div', 'compare-track')
  const dots = element('div', 'compare-dots')
  dots.setAttribute('role', 'tablist')
  dots.setAttribute('aria-label', t('compare.drawer'))
  drawer.append(track, dots)
  const scrim = element('div', 'compare-scrim')
  scrim.hidden = true
  host.append(split.element, scrim, drawer)
  let settle: (() => void) | undefined

  const toggle = button('', 'format-button compare-toggle')
  toggle.append(icon('compare'), element('span', 'trash-count side-count compare-count'))
  toggle.setAttribute('aria-label', t('compare.drawer'))
  toggle.title = t('compare.drawer')
  toggle.setAttribute('aria-expanded', 'false')
  toggle.addEventListener('mousedown', (event) => event.preventDefault())
  toggle.addEventListener('click', () => setDrawer(!drawerOpen()))

  const drawerOpen = () => drawer.dataset.state === 'open'
  function setDrawer(open: boolean, focusPane = true) {
    if (open === drawerOpen() || (open && !refs.size)) return
    settle?.()
    toggle.setAttribute('aria-expanded', String(open))
    if (open) {
      drawer.hidden = scrim.hidden = false
      drawer.inert = false
      void drawer.offsetWidth
      drawer.dataset.state = scrim.dataset.state = 'open'
      const current = slideIndex()
      const id = [...refs.keys()][current]
      if (id) setFocused(id)
      if (focusPane) requestAnimationFrame(() => (refs.get(focused)?.scroller ?? drawer).focus({ preventScroll: true }))
    } else {
      drawer.dataset.state = scrim.dataset.state = 'closed'
      drawer.inert = true
      settle = afterTransition(drawer, 'slow', () => { settle = undefined; if (!drawerOpen()) drawer.hidden = scrim.hidden = true })
      setFocused(mainPane)
    }
  }
  scrim.addEventListener('click', () => setDrawer(false))
  drawer.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    setDrawer(false)
    toggle.focus({ preventScroll: true })
  })
  const slideIndex = () => track.clientWidth ? Math.round(track.scrollLeft / track.clientWidth) : 0
  function paintDots() {
    const ids = [...refs.keys()]
    const current = Math.min(slideIndex(), ids.length - 1)
    dots.hidden = ids.length < 2
    dots.replaceChildren(...ids.map((id, index) => {
      const dot = element('button', 'compare-dot')
      dot.type = 'button'
      dot.setAttribute('role', 'tab')
      dot.setAttribute('aria-selected', String(index === current))
      const pane = refs.get(id)!
      dot.setAttribute('aria-label', t('compare.paneLabel', [pane.title(), pane.part()]))
      dot.addEventListener('click', () => showSlide(index))
      return dot
    }))
  }
  function showSlide(index: number, smooth = true) {
    track.scrollTo({ left: index * track.clientWidth, behavior: smooth && motionMs('base') ? 'smooth' : 'instant' })
  }
  let slideTimer = 0
  track.addEventListener('scroll', () => {
    window.clearTimeout(slideTimer)
    slideTimer = window.setTimeout(() => {
      paintDots()
      const id = [...refs.keys()][slideIndex()]
      if (id && drawerOpen()) setFocused(id)
    }, 80)
  }, { passive: true, signal })
  drawer.addEventListener('pointerdown', (event) => {
    for (const [id, pane] of refs) if (pane.element.contains(event.target as Node)) setFocused(id)
  }, { capture: true, signal })

  function paintToggle() {
    toggle.querySelector('.compare-count')!.textContent = refs.size ? String(refs.size) : ''
  }

  function setNarrow(next: boolean) {
    if (next === narrow) return
    for (const pane of refs.values()) pane.capture()
    narrow = next
    host.classList.toggle('compare-narrow', narrow)
    if (narrow) {
      for (const [id, pane] of refs) { split.detach(id); track.append(pane.element) }
      split.setTree({ pane: mainPane })
      split.focus(mainPane)
      setFocused(mainPane)
    } else {
      setDrawer(false, false)
      settle?.()
      for (const [id, pane] of refs) split.attach(id, pane.element)
      split.setTree(layout)
      if (focused !== mainPane) split.focus(focused)
    }
    options.onFocusChange()
    paintDots()
    requestAnimationFrame(() => { for (const pane of refs.values()) pane.restore() })
  }

  function evaluate() {
    const width = host.clientWidth
    const height = host.clientHeight
    if (!width || !height) return
    setNarrow(refs.size ? !fits(layout, width, height, paneMinWidth, paneMinHeight) : width < paneMinWidth * 2)
  }
  const observer = new ResizeObserver(evaluate)
  observer.observe(host)
  signal.addEventListener('abort', () => { observer.disconnect(); window.clearTimeout(slideTimer) }, { once: true })

  // ——— Focus ———
  function setFocused(id: string) {
    if (!refs.has(id) && id !== mainPane) id = mainPane
    if (id === focused) return
    focused = id
    options.onFocusChange()
    persist()
  }

  // ——— Remembered layout ———
  function persist() {
    if (signal.aborted) return
    const edition = options.edition()
    if (!refs.size) { saveLayout(edition, undefined); return }
    saveLayout(edition, {
      tree: layout,
      panes: Object.fromEntries([...refs].map(([id, pane]) => [id, pane.source()])),
      focused,
    })
  }

  // ——— Reference panes ———
  function createPane(id: string, source: ReferenceSource) {
    const pane = referencePane({
      source, signal,
      menu: () => paneMenu(id),
      onClose: () => close(id),
      onChange: () => { persist(); options.onReferenceChange(pane); paintDots() },
    })
    refs.set(id, pane)
    paintToggle()
    return pane
  }

  function close(id: string) {
    const pane = refs.get(id)
    if (!pane) return
    // The place is taken now, while the pane still has its size; destroying it later keeps that.
    pane.capture()
    pane.release()
    refs.delete(id)
    layout = removePane(layout, id) ?? { pane: mainPane }
    paintToggle()
    if (focused === id) { focused = mainPane }
    if (narrow) {
      pane.destroy()
      if (!refs.size) setDrawer(false)
      paintDots()
    } else {
      split.remove(id)
      const leave = () => { split.detach(id); pane.destroy() }
      const duration = motionMs('slow')
      if (duration) window.setTimeout(leave, duration + 40)
      else leave()
    }
    persist()
    evaluate()
    options.onFocusChange()
  }

  /** The zone a menu's "right" or "below" uses: beside the focused pane, else along the whole view. */
  function placementZone(placement: OpenPlacement): Zone | undefined {
    const side = placement === 'right' ? 'right' : 'bottom'
    for (const zone of [{ target: focused, side }, { target: mainPane, side }, { target: null, side }] as Zone[]) {
      if (split.canInsert(zone)) return zone
    }
  }

  function open(source: ReferenceSource, where: OpenPlacement | Zone) {
    if (refs.size >= maxReferences) { showNotice(t('compare.tooMany', [maxReferences])); return }
    options.beforeOpen()
    const id = `ref-${Date.now().toString(36)}-${++serial}`
    if (narrow) {
      const pane = createPane(id, source)
      layout = insertPane(layout, id, typeof where === 'string' ? { target: null, side: where === 'right' ? 'right' : 'bottom' } : where)
      track.append(pane.element)
      persist()
      paintDots()
      setDrawer(true)
      requestAnimationFrame(() => showSlide(refs.size - 1, false))
      return
    }
    const zone = typeof where === 'string' ? placementZone(where) : where
    if (!zone) { showNotice(t('compare.noRoom')); return }
    const pane = createPane(id, source)
    pane.element.dataset.entering = ''
    split.attach(id, pane.element)
    layout = insertPane(layout, id, zone)
    split.insert(id, zone)
    // The new pane fades in where the drop preview was, while the others glide aside.
    requestAnimationFrame(() => requestAnimationFrame(() => delete pane.element.dataset.entering))
    persist()
    requestAnimationFrame(() => pane.scroller.focus({ preventScroll: true }))
  }

  function resolve(payload: DragPayload): ReferenceSource | undefined {
    const value = payload as ComparePayload
    if ('source' in value) return value.source
    return defaultSource(value.work, (edition) => lastChapter(edition))
  }

  setDropHost({
    zoneAt(x, y) {
      const box = host.getBoundingClientRect()
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) return undefined
      if (narrow) {
        const width = Math.min(box.width - 44, 480)
        return { key: 'drawer', rect: { left: box.right - width, top: box.top, width, height: box.height } }
      }
      if (refs.size >= maxReferences) return undefined
      const found = split.zoneAt(x, y)
      return found && { key: JSON.stringify(found.zone), rect: found.rect }
    },
    drop(payload, key) {
      const source = resolve(payload)
      if (!source) { showNotice(t('compare.nothingToOpen')); return }
      open(source, key === 'drawer' ? 'right' : JSON.parse(key) as Zone)
    },
  }, signal)

  // ——— Menus ———
  function sameEdition(source: ReferenceSource) {
    const edition = options.edition()
    return source.kind === 'chapter' && source.library === edition.library && source.bookId === edition.bookId && source.editionId === edition.id
  }

  async function swap(id: string) {
    const pane = refs.get(id)
    const source = pane?.source()
    if (!pane || !source || source.kind !== 'chapter' || !sameEdition(source)) return
    const previous = options.chapterId()
    if (source.chapterId === previous) return
    if (!await options.switchMain(source.chapterId)) return
    await pane.show({ ...source, chapterId: previous })
    persist()
    if (narrow) setDrawer(false)
    else split.focus(mainPane)
    setFocused(mainPane)
  }

  function paneMenu(id: string): ShellMenuItem[] {
    const pane = refs.get(id)
    if (!pane) return []
    const source = pane.source()
    const items: ShellMenuItem[] = []
    if (source.kind === 'chapter' && sameEdition(source) && source.chapterId !== options.chapterId()) {
      items.push({ label: t('compare.editThis'), icon: 'swap', action: () => { void swap(id) } })
    }
    const chapters = pane.chapters()
    if (chapters.length > 1) {
      items.push({ label: t('editor.switchChapter'), icon: 'list', children: () => chapters.map(({ id: chapterId, title }, index) => ({
        label: `${String(index + 1).padStart(2, '0')}  ${title}`, radio: true, checked: source.kind === 'chapter' && source.chapterId === chapterId,
        action: () => { void pane.switchChapter(chapterId) },
      })) })
    }
    if (canOpenWindow()) items.push({ label: t('compare.openWindow'), icon: 'window', action: () => { openWindow(pane.source()); close(id) } })
    items.push({ label: t('compare.close'), icon: 'close', action: () => close(id) })
    return items
  }

  /** "Open on the right / below / in a new window" for anything that can be shown beside the text. */
  function openItems(source: () => ReferenceSource | undefined): ShellMenuItem[] {
    const run = (placement: OpenPlacement) => () => {
      const value = source()
      if (value) open(value, placement)
      else showNotice(t('compare.nothingToOpen'))
    }
    return [
      { label: t('compare.openRight'), icon: 'splitRight', action: run('right') },
      { label: t('compare.openBelow'), icon: 'splitDown', action: run('bottom') },
      ...(canOpenWindow() ? [{ label: t('compare.openWindow'), icon: 'window' as const, action: () => { const value = source(); if (value) openWindow(value) } }] : []),
    ]
  }

  function editionSources(work: CatalogWork): ShellMenuItem[] {
    const chapterItems = (edition: Edition) => edition.chapters.map(({ id, title }, index) => ({
      label: `${String(index + 1).padStart(2, '0')}  ${title}`,
      action: () => open({ kind: 'chapter', library: edition.library, bookId: edition.bookId, editionId: edition.id, chapterId: id }, 'right'),
    }))
    const items: ShellMenuItem[] = work.editions.length === 1
      ? chapterItems(work.editions[0])
      : work.editions.map((edition) => ({ label: edition.name, icon: 'copy' as const, children: () => chapterItems(edition) }))
    for (const file of work.files) {
      items.push({ label: file === work.book ? t('compare.originalFile') : file.title, icon: 'file', action: () => open({ kind: 'file', library: file.library, bookId: file.id }, 'right') })
    }
    return items
  }

  /** The work menu's "read beside": this work's other chapters first, then every other work. */
  function compareMenu(): ShellMenuItem[] {
    const edition = options.edition()
    const own = catalog.find((work) => work.book.library === edition.library && work.book.id === edition.bookId)
    const others = catalog.filter((work) => work !== own && (work.editions.some((item) => item.chapters.length) || work.files.length))
    const children = (): ShellMenuItem[] => [
      { label: t('compare.thisWork'), icon: 'book', children: () => {
        const current = options.chapterId()
        const items: ShellMenuItem[] = edition.chapters.filter(({ id }) => id !== current).map(({ id, title }) => ({
          label: title, action: () => open({ kind: 'chapter', library: edition.library, bookId: edition.bookId, editionId: edition.id, chapterId: id }, 'right'),
        }))
        for (const file of own?.files ?? []) items.push({ label: file === own?.book ? t('compare.originalFile') : file.title, icon: 'file', action: () => open({ kind: 'file', library: file.library, bookId: file.id }, 'right') })
        return items.length ? items : [{ label: t('compare.noOtherChapters'), disabled: true }]
      } },
      ...(others.length ? [{ separator: true, label: '' }] : []),
      ...others.map((work) => ({ label: work.book.title, icon: 'book' as const, children: () => editionSources(work) })),
    ]
    return [{ label: t('compare.readBeside'), icon: 'compare', children }]
  }

  // ——— The side panel's tab ———
  const panel = element('section', 'compare-panel')
  panel.setAttribute('aria-label', t('compare.tab'))
  const filter = element('input', 'title-input compare-filter')
  filter.type = 'search'
  filter.placeholder = t('compare.filter')
  filter.setAttribute('aria-label', t('compare.filter'))
  const hint = element('p', 'dialog-help compare-hint', t('compare.hint'))
  const list = element('div', 'compare-list')
  panel.append(filter, hint, list)
  filter.addEventListener('input', () => paintPanel())

  function entry(label: string, detail: string, payload: () => ComparePayload, className = '') {
    const row = element('div', `compare-entry ${className}`.trim())
    const main = button('', 'compare-entry-open')
    main.append(element('span', 'compare-entry-label', label))
    if (detail) main.append(element('span', 'compare-entry-detail', detail))
    main.title = t('compare.entryHint')
    const sourceOf = () => resolve(payload())
    main.addEventListener('click', () => { const value = sourceOf(); if (value) open(value, 'right'); else showNotice(t('compare.nothingToOpen')) })
    const more = button('', 'compare-entry-more', 'more')
    more.setAttribute('aria-label', t('compare.entryMenu', [label]))
    more.title = t('compare.entryMenu', [label])
    more.tabIndex = -1
    more.setAttribute('aria-hidden', 'true')
    menuButton(more, label, () => openItems(sourceOf))
    row.addEventListener('contextmenu', (event) => { event.preventDefault(); more.click() })
    draggableEntry(main, { label: () => label, payload, menu: () => more.click(), signal })
    row.append(main, more)
    return row
  }

  function paintPanel() {
    const query = filter.value.trim().toLocaleLowerCase()
    const edition = options.edition()
    const groups: HTMLElement[] = []
    for (const work of catalog) {
      const readable = work.editions.some((item) => item.chapters.length) || work.files.length
      if (!readable) continue
      const own = work.book.library === edition.library && work.book.id === edition.bookId
      if (query && !work.book.title.toLocaleLowerCase().includes(query)) continue
      const group = element('details', 'compare-work')
      group.open = own
      const summary = element('summary', 'compare-work-summary')
      summary.append(icon('chevron'))
      const head = entry(work.book.title, own ? t('compare.thisWork') : '', () => ({ work }), 'compare-work-entry')
      summary.append(head)
      // The summary's own toggle stays on its arrow, so the work's name can be dragged and clicked.
      head.addEventListener('click', (event) => event.preventDefault())
      const body = element('div', 'compare-work-body')
      for (const item of own ? work.editions.filter((version) => version.id === edition.id) : work.editions) {
        if (work.editions.length > 1 && !own) body.append(element('p', 'compare-edition', item.name))
        for (const [index, chapter] of item.chapters.entries()) {
          const source: ReferenceSource = { kind: 'chapter', library: item.library, bookId: item.bookId, editionId: item.id, chapterId: chapter.id }
          body.append(entry(chapter.title, String(index + 1).padStart(2, '0'), () => ({ source })))
        }
      }
      for (const file of work.files) {
        const source: ReferenceSource = { kind: 'file', library: file.library, bookId: file.id }
        body.append(entry(file === work.book ? t('compare.originalFile') : file.title, file.format.toUpperCase(), () => ({ source }), 'compare-file'))
      }
      group.append(summary, body)
      groups.push(group)
    }
    list.replaceChildren(...(groups.length ? groups : [element('p', 'dialog-help', query ? t('writing.noMatch') : t('compare.empty'))]))
  }

  let catalogRequest = 0
  async function refreshCatalog() {
    const turn = ++catalogRequest
    try {
      const next = await readCatalog()
      if (signal.aborted || turn !== catalogRequest) return
      catalog = next
      paintPanel()
    } catch { /* The list keeps what it showed. */ }
  }
  libraryChanges.addEventListener('update', () => { void refreshCatalog() }, { signal })
  void refreshCatalog()

  // ——— Restore what this edition had open ———
  const stored = readLayout(options.edition())
  if (stored) {
    let tree: SplitTree | undefined = stored.tree
    if (!paneIds(tree).includes(mainPane)) tree = undefined
    for (const id of tree ? paneIds(tree) : []) {
      if (id === mainPane) continue
      const source = readSource(stored.panes[id])
      if (!source || refs.size >= maxReferences) { tree = tree && removePane(tree, id); continue }
      const pane = createPane(id, source)
      split.attach(id, pane.element)
    }
    if (tree) {
      layout = tree
      split.setTree(layout)
      if (stored.focused && refs.has(stored.focused)) { split.focus(stored.focused); focused = stored.focused }
    }
  }
  evaluate()

  return {
    element: split.element,
    toggle,
    panel,
    /** The reference pane the toolbar works on, when one has the focus. */
    focusedReference: () => focused === mainPane ? undefined : refs.get(focused),
    references: () => [...refs.values()],
    isNarrow: () => narrow,
    open,
    openItems,
    compareMenu,
    paneMenu: (pane: ReferencePane) => {
      const id = [...refs].find(([, value]) => value === pane)?.[0]
      return id ? paneMenu(id) : []
    },
    hasSource: (source: ReferenceSource) => [...refs.values()].some((pane) => sameSource(pane.source(), source)),
    focusMain() { if (narrow) setDrawer(false, false); split.focus(mainPane); setFocused(mainPane) },
    refreshPanel: paintPanel,
    /** Lays the panes out now, once the page is in the document (before any scroll is restored). */
    relayout() { split.relayout(); evaluate() },
    refreshCatalog: () => { void refreshCatalog() },
  }
}

export type SplitEditor = ReturnType<typeof mountSplitEditor>
