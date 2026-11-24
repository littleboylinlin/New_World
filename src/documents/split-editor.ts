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
import { chapterNumber, isOwnWork, readableEditions, readableWorks, sourceMenu } from './compare-menu'
import type { CompareHere } from './compare-menu'
import { canOpenWindow, defaultSource, mainPane, openWindow, readCatalog, readLayout, readSource, saveLayout, sameSource } from './compare'
import type { CatalogWork, OpenPlacement, PaneSource, ReferenceSource } from './compare'
import { lastChapter } from './editor-prefs'
import type { Edition } from './model'
import { referencePane } from './reference-pane'
import type { ReferencePane } from './reference-pane'
import { canBrowse, webPane } from './web-pane'
import type { WebPane } from './web-pane'

/** Any pane beside the text: a read-only reference or a private web page. */
export type SidePane = ReferencePane | WebPane
export const isWebPane = (pane: SidePane | undefined): pane is WebPane => (pane as WebPane | undefined)?.kind === 'web'

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
  onReferenceChange: (pane: SidePane) => void
  /** Text selected in a web page, to keep as an idea or a task. */
  onKeep: (kind: 'idea' | 'task', entry: { text: string; title: string; url: string }) => void
  onSummarize?: (entry: { scope: 'selection' | 'page'; text: string; title: string; url: string }) => void
  /** Before something opens: drawers over the text (chapter list, side panel) step aside. */
  beforeOpen: () => void
  signal: AbortSignal
}

/** A dragged entry: what to open, or a work (or one of its versions) whose source is decided on drop. */
export type ComparePayload = { source: PaneSource } | { work: CatalogWork; editionId?: string }

/**
 * The editor's split view: the editable chapter plus read-only reference panes. Where the window
 * is too narrow to split, the references move into a drawer on the right that swipes between them.
 */
export function mountSplitEditor(options: SplitEditorOptions) {
  const { host, signal } = options
  const refs = new Map<string, SidePane>()
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
      settle = afterTransition(drawer, 'base', () => { settle = undefined; if (!drawerOpen()) drawer.hidden = scrim.hidden = true })
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
    // Too narrow for two panes side by side means no splitting at all, not even one above another.
    setNarrow(width < paneMinWidth * 2 || (refs.size > 0 && !fits(layout, width, height, paneMinWidth, paneMinHeight)))
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
  // Web panes are private: neither where they were nor that they were there is remembered.
  // The next time the layout comes back without them, and the other panes share their room.
  function persist() {
    if (signal.aborted) return
    const edition = options.edition()
    const kept = [...refs].filter((entry): entry is [string, ReferencePane] => !isWebPane(entry[1]))
    let tree: SplitTree = layout
    for (const [id, pane] of refs) if (isWebPane(pane)) tree = removePane(tree, id) ?? { pane: mainPane }
    if (!kept.length) { saveLayout(edition, undefined); return }
    saveLayout(edition, {
      tree,
      panes: Object.fromEntries(kept.map(([id, pane]) => [id, pane.source() as ReferenceSource])),
      focused: kept.some(([id]) => id === focused) ? focused : mainPane,
    })
  }

  // ——— Reference panes ———
  function createPane(id: string, source: PaneSource): SidePane {
    if (source.kind === 'web') {
      const page = webPane({
        id, url: source.url, signal,
        menu: () => paneMenu(id),
        onClose: () => close(id),
        onChange: () => { options.onReferenceChange(page); paintDots() },
        onFocus: () => { if (!narrow) split.focus(id); setFocused(id) },
        onKeep: options.onKeep,
        onSummarize: options.onSummarize,
      })
      refs.set(id, page)
      paintToggle()
      return page
    }
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
      const duration = motionMs('base')
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

  function open(source: PaneSource, where: OpenPlacement | Zone) {
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
      requestAnimationFrame(() => {
        showSlide(refs.size - 1, false)
        if (isWebPane(pane) && source.kind === 'web' && !source.url) pane.focusAddress()
      })
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
    requestAnimationFrame(() => {
      if (isWebPane(pane) && source.kind === 'web' && !source.url) pane.focusAddress()
      else pane.scroller.focus({ preventScroll: true })
    })
  }

  function resolve(payload: DragPayload): PaneSource | undefined {
    const value = payload as ComparePayload
    if ('source' in value) return value.source
    const source = defaultSource(value.work, (edition) => lastChapter(edition), value.editionId)
    // The version being edited opens to a chapter beside the one in the editable pane, never to it.
    if (source?.kind !== 'chapter' || !sameEdition(source) || source.chapterId !== options.chapterId()) return source
    const chapters = options.edition().chapters
    const index = chapters.findIndex(({ id }) => id === source.chapterId)
    const other = chapters[index + 1] ?? chapters[index - 1]
    if (other) return { ...source, chapterId: other.id }
    const file = value.editionId ? undefined : value.work.files[0]
    return file && { kind: 'file', library: file.library, bookId: file.id }
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
  function sameEdition(source: PaneSource) {
    const edition = options.edition()
    return source.kind === 'chapter' && source.library === edition.library && source.bookId === edition.bookId && source.editionId === edition.id
  }

  async function swap(id: string) {
    const pane = refs.get(id)
    const source = pane?.source()
    if (!pane || isWebPane(pane) || !source || source.kind !== 'chapter' || !sameEdition(source)) return
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
    if (isWebPane(pane)) {
      return [
        { label: t('web.openOutside'), icon: 'window', disabled: !pane.url(), action: () => { void window.newWorldDesktop?.web?.('openOutside', id) } },
        { label: t('web.close'), icon: 'close', action: () => close(id) },
      ]
    }
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
  function openItems(source: () => PaneSource | undefined): ShellMenuItem[] {
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

  function here(): CompareHere {
    const edition = options.edition()
    return { library: edition.library, bookId: edition.bookId, editionId: edition.id, chapterId: options.chapterId() }
  }

  /** The work menu's "read beside": the whole library, this work first, by work → version → chapter. */
  function compareMenu(): ShellMenuItem[] {
    return [{ label: t('compare.readBeside'), icon: 'compare', children: () => sourceMenu(catalog, here(), (source) => open(source, 'right')) }]
  }

  // ——— The side panel's tab ———
  const panel = element('section', 'compare-panel')
  panel.setAttribute('aria-label', t('compare.tab'))
  const filter = element('input', 'title-input compare-filter')
  filter.type = 'search'
  filter.placeholder = t('compare.filter')
  filter.setAttribute('aria-label', t('compare.filter'))
  const list = element('div', 'compare-list')
  panel.append(filter, list)
  // Repainting while an input method is still composing would end the word early.
  filter.addEventListener('input', (event) => { if (!(event as InputEvent).isComposing) paintPanel() })
  filter.addEventListener('compositionend', () => paintPanel())

  // Each drawing of the list owns its entries' listeners; the next drawing releases them.
  let listing = new AbortController()
  signal.addEventListener('abort', () => listing.abort(), { once: true })

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
    draggableEntry(main, { label: () => label, payload, menu: () => more.click(), signal: listing.signal })
    row.append(main, more)
    return row
  }

  // Which works and versions are unfolded, remembered on this device. Searching unfolds what it
  // finds without changing what is remembered.
  const expandedKey = 'new-world:compare-expanded'
  let expanded: Record<string, boolean> = {}
  try {
    const raw = JSON.parse(localStorage.getItem(expandedKey) ?? 'null')
    if (raw && typeof raw === 'object') expanded = Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean>
  } catch { /* Every branch starts at its default. */ }
  function remember(key: string, open: boolean) {
    expanded[key] = open
    const entries = Object.entries(expanded)
    if (entries.length > 400) expanded = Object.fromEntries(entries.slice(-400))
    try { localStorage.setItem(expandedKey, JSON.stringify(expanded)) } catch { /* Only a convenience. */ }
  }

  /** A foldable level of the list (a work or a version) whose own name can be clicked and dragged. */
  function branch(key: string, head: HTMLElement, open: boolean, forced: boolean, className: string) {
    const group = element('details', `compare-branch ${className}`)
    group.dataset.key = key
    group.open = open
    const summary = element('summary', 'compare-branch-summary')
    summary.append(icon('chevron'), head)
    // The summary's own toggle stays on its arrow, so the name can be dragged and clicked.
    head.addEventListener('click', (event) => event.preventDefault())
    let byHand = false
    summary.addEventListener('click', () => { byHand = true }, { signal: listing.signal })
    group.addEventListener('toggle', () => {
      if (byHand && !forced) remember(key, group.open)
      byHand = false
    }, { signal: listing.signal })
    const body = element('div', 'compare-branch-body')
    group.append(summary, body)
    return { group, body }
  }

  function paintPanel() {
    listing.abort()
    listing = new AbortController()
    const query = filter.value.trim().toLocaleLowerCase()
    const matches = (text: string) => text.toLocaleLowerCase().includes(query)
    const where = here()
    const groups: HTMLElement[] = []
    for (const work of readableWorks(catalog, where)) {
      const own = isOwnWork(work, where)
      const workHit = !query || matches(work.book.title)
      const editions = readableEditions(work, where).flatMap((edition) => {
        if (workHit || matches(edition.name)) return [{ edition, chapters: edition.chapters.map((chapter, index) => ({ chapter, index })) }]
        const found = edition.chapters.map((chapter, index) => ({ chapter, index })).filter(({ chapter }) => matches(chapter.title))
        return found.length ? [{ edition, chapters: found }] : []
      })
      const files = work.files.filter((file) => workHit || matches(file === work.book ? t('compare.originalFile') : file.title))
      if (query && !workHit && !editions.length && !files.length) continue
      const workKey = `work:${work.book.library}/${work.book.id}`
      // A search unfolds every work it found, and the versions where it found chapters.
      const workForced = Boolean(query)
      const head = entry(work.book.title, own ? t('compare.thisWork') : '', () => ({ work }), 'compare-work-entry')
      const { group, body } = branch(workKey, head, workForced || (expanded[workKey] ?? own), workForced, 'compare-work')
      if (own) group.classList.add('compare-own')
      for (const { edition, chapters } of editions) {
        const current = edition.id === where.editionId
        const editionKey = `edition:${edition.id}`
        const editionForced = Boolean(query) && !workHit
        const versionHead = entry(edition.name, current ? t('compare.currentVersion') : t('compare.chapterCount', [edition.chapters.length]), () => ({ work, editionId: edition.id }), 'compare-edition-entry')
        const version = branch(editionKey, versionHead, editionForced || (expanded[editionKey] ?? (current || readableEditions(work, where).length === 1)), editionForced, 'compare-edition')
        for (const { chapter, index } of chapters) {
          if (current && chapter.id === where.chapterId) {
            const row = element('div', 'compare-entry compare-entry-current')
            const label = element('div', 'compare-entry-open')
            label.append(element('span', 'compare-entry-label', chapter.title), element('span', 'compare-entry-detail', chapterNumber(index)), element('span', 'compare-entry-tag', t('compare.editing')))
            row.append(label)
            version.body.append(row)
            continue
          }
          const source: ReferenceSource = { kind: 'chapter', library: edition.library, bookId: edition.bookId, editionId: edition.id, chapterId: chapter.id }
          version.body.append(entry(chapter.title, chapterNumber(index), () => ({ source })))
        }
        body.append(version.group)
      }
      for (const file of files) {
        const source: ReferenceSource = { kind: 'file', library: file.library, bookId: file.id }
        body.append(entry(file === work.book ? t('compare.originalFile') : file.title, file.format.toUpperCase(), () => ({ source }), 'compare-file'))
      }
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
    paneMenu: (pane: SidePane) => {
      const id = [...refs].find(([, value]) => value === pane)?.[0]
      return id ? paneMenu(id) : []
    },
    /** Opens a private web page beside the text, blank (the address bar takes the caret) or at an address. */
    openWeb(url?: string, where: OpenPlacement | Zone = 'right') { if (canBrowse()) open({ kind: 'web', url }, where) },
    hasSource: (source: PaneSource) => [...refs.values()].some((pane) => sameSource(pane.source(), source)),
    focusMain() { if (narrow) setDrawer(false, false); split.focus(mainPane); setFocused(mainPane) },
    /** Another drawer (chapter list, side panel) is opening over the text; this one steps aside. */
    closeDrawer() { setDrawer(false, false) },
    refreshPanel: paintPanel,
    /** Lays the panes out now, once the page is in the document (before any scroll is restored). */
    relayout() { split.relayout(); evaluate() },
    refreshCatalog: () => { void refreshCatalog() },
  }
}

export type SplitEditor = ReturnType<typeof mountSplitEditor>
