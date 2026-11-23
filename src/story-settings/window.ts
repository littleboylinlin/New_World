import { locale, t } from '../i18n'
import { formDialog } from '../dialogs'
import { storageError, trashEntry } from '../library'
import type { TrashEntry } from '../library'
import { rasterData } from '../documents/markup'
import { showProjectExport } from '../projects/view'
import { fixedPage } from '../shell/fixed-page'
import { restoreTrash } from '../trash'
import { button, downloadFile, element, icon, notice } from '../ui'
import type { IconName } from '../ui'
import { cardInspector, storyInput, storyLabel } from './card-editor'
import { storyCanvas, storyTools } from './canvas'
import { cardDetails } from './canvas-overlays'
import type { StoryTool } from './canvas'
import { watchStoryChanges } from './changes'
import { storyImage } from './export-image'
import { bounds, center, freeBend, overlaps, selectedNodes } from './geometry'
import { StorySceneError, blankStoryCard, cardInput, defaultStoryColor, emptyStoryBoard, isNodeEnd, matchesStoryCard, maxStoryName, storyCards, storyDirections, storyStrokes } from './model'
import type { Point, Rect, StoryCardInput, StoryChapter, StoryEdge, StoryNode, StoryProblem, StoryScene, StoryTag } from './model'
import { parseStoryRoute } from './route'
import { copyStorySelection, parallelBends, pasteStorySelection, remainingStoryEdges } from './selection'
import { readStorySettings, saveStoryScene, saveStoryView } from './store'
import './window.css'

const main = element('main', 'story-window')
document.body.replaceChildren(main)
document.title = t('story.title')
const work = parseStoryRoute(location.hash)

type Panel = ReturnType<typeof cardInspector>
type Snapshot = Awaited<ReturnType<typeof readStorySettings>>
interface HistoryEntry { before: StoryScene; after: StoryScene; trash: TrashEntry[] }

const toolIcons: Record<StoryTool, IconName> = {
  select: 'pointer', hand: 'hand', card: 'cards', arrow: 'arrowTool', text: 'format', group: 'frame', image: 'image', eraser: 'eraser',
}
const toolKeys: Record<StoryTool, string[]> = {
  select: ['V', '1'], hand: ['H'], card: ['R', '2'], arrow: ['A', '5'], text: ['T', '8'], group: ['F'], image: ['9'], eraser: ['E', '0'],
}
const edgeColors = [defaultStoryColor, '#e03131', '#f08c00', '#2f9e44', '#1971c2', '#9c36b5']
const shortcuts: [string, string][] = [
  ['lock', 'Q'], ['pan', t('story.key.space')], ['wheel', t('story.key.wheel')], ['zoom', t('story.key.ctrlWheel')], ['fit', 'Shift + 1'],
  ['newCard', t('story.key.doubleBlank')], ['rename', t('story.key.doubleCard')], ['open', 'Enter'], ['nudge', t('story.key.arrows')],
  ['duplicate', 'Ctrl / ⌘ + D'], ['copy', 'Ctrl / ⌘ + C / V'], ['undo', 'Ctrl / ⌘ + Z'], ['redo', 'Ctrl / ⌘ + Shift + Z'],
  ['delete', 'Delete'], ['snap', t('story.key.holdCtrl')], ['select', t('story.key.shiftClick')],
]

function preference(key: string, fallback: boolean) {
  try { const value = localStorage.getItem(`new-world:story-${key}`); return value === null ? fallback : value === '1' } catch { return fallback }
}
function remember(key: string, value: boolean) {
  try { localStorage.setItem(`new-world:story-${key}`, value ? '1' : '0') } catch { /* Preferences are a convenience. */ }
}

function mount(route: NonNullable<typeof work>) {
  const scope = { library: route.library, bookId: route.bookId }
  const signal = new AbortController().signal
  fixedPage(main, signal)
  let chapter = route.chapter
  let board = emptyStoryBoard(scope)
  let snapshot: Snapshot | undefined
  let opened = false
  let writing = false
  // Saves run one at a time; `saved` is the board as stored, `board` also holds changes still being saved.
  let saved = board
  let pending = 0
  let generation = 0
  let queue: Promise<void> = Promise.resolve()
  let refreshPending = false
  let turn = 0
  let selection: ReadonlySet<string> = new Set()
  let panel: Panel | undefined
  let editedId = ''
  let undo: HistoryEntry[] = []
  let redo: HistoryEntry[] = []
  let clipboard = ''
  let snapping = preference('snapping', true)
  let grid = preference('grid', true)
  let displayedTags = new Map<string | undefined, { tag?: StoryTag; form: HTMLFormElement }>()
  let imagePoint: Point | undefined
  let revealed = ''

  const stage = element('div', 'story-stage')
  const message = element('p', 'story-banner')
  message.setAttribute('role', 'alert')
  message.hidden = true

  function report(error?: unknown) {
    message.hidden = error === undefined
    message.textContent = error === undefined ? '' : error instanceof StorySceneError ? explain(error.problem) : storageError(error)
    // Point at what needs fixing.
    const id = error instanceof StorySceneError && 'id' in error.problem ? error.problem.id : ''
    if (id && [...board.scene.nodes, ...board.scene.edges].some((item) => item.id === id)) {
      canvas.select([id])
      canvas.reveal(id)
    }
  }

  function chapterName(ref?: StoryChapter) {
    const edition = snapshot?.editions.find(({ id }) => id === ref?.editionId)
    const index = edition?.chapters.findIndex(({ id }) => id === ref?.chapterId) ?? -1
    return edition && index >= 0 ? t('story.chapterOption', [index + 1, edition.chapters[index].title]) : t('story.chapterUnavailable')
  }

  /** One sentence per reason a save was refused, naming the card, chapter or size involved. */
  function explain(problem: StoryProblem) {
    const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    switch (problem.kind) {
      case 'cardName': return t('story.problem.cardName')
      case 'aliases': case 'fields': case 'tagMissing': return t(`story.problem.${problem.kind}`, [problem.name])
      case 'chapter': case 'state': return problem.chapter
        ? t(`story.problem.${problem.kind}Repeat`, [problem.name, chapterName(problem.chapter)])
        : t(`story.problem.${problem.kind}Invalid`, [problem.name])
      case 'tag': return t('story.problem.tag', [problem.name])
      case 'size': return t('story.problem.size', [megabytes(problem.bytes), megabytes(problem.limit)])
      default: return t(`story.problem.${problem.kind}`)
    }
  }

  let repairNoticed = false
  /** A board left by an earlier build of the canvas is saved back in the current format, once, with a note. */
  function saveRepair(repair: NonNullable<Snapshot['repair']>) {
    void write(board.scene, [], []).then((saved) => {
      if (!saved || repairNoticed) return
      repairNoticed = true
      const notes = [
        repair.removedEdges ? t('story.repairedEdges', [repair.removedEdges]) : '',
        repair.removedNodes ? t('story.repairedNodes', [repair.removedNodes]) : '',
        repair.repairedCards ? t('story.repairedCards', [repair.repairedCards]) : '',
      ].filter(Boolean)
      if (notes.length) canvas.toast.show(notes.join(' '), { duration: 8000 })
    })
  }

  const editable = () => Boolean(snapshot?.book)
  // The canvas reports layout while it is being built, before the panels below exist.
  let ready = false

  const canvas = storyCanvas({
    select(next) { selection = next; paintControls(); paintProps(); revealSelection() },
    change: (scene, ids) => {
      if (!editable()) return Promise.resolve(false)
      // The change shows at once, so it is selected at once; a refused save rolls the selection back with it.
      const saving = commit(scene)
      if (ids) canvas.select(ids)
      return saving
    },
    createCard: (rect, name) => createCard(rect, name),
    openCard: (id) => edit(id),
    remove: (ids) => deleteSelection(ids),
    pickImage(point) { imagePoint = point; imageFile.click() },
    toolChanged: paintTools,
    viewChanged(view) {
      zoom.textContent = `${Math.round(view.zoom * 100)}%`
      if (snapshot?.book) void saveStoryView(scope, view).catch(report)
    },
    layout: () => { if (ready) placeFloating() },
    editable,
    snapping: () => snapping,
  })

  function action(key: string, symbol: IconName, run: () => void, text = false) {
    const label = t(`story.${key}`)
    const control = button(text ? label : '', `button button-small button-quiet ${text ? 'story-wide' : 'story-square'}`, symbol)
    control.title = label
    control.setAttribute('aria-label', label)
    control.onclick = run
    return control
  }

  function island(className: string, label?: string) {
    const box = element('div', `story-island story-canvas-control ${className}`)
    if (label) { box.setAttribute('role', 'toolbar'); box.setAttribute('aria-label', label) }
    return box
  }

  // ——— Top left: menu, work title and the chapter new cards link to ———
  const menuIsland = island('story-menu-island')
  const menuButton = action('menu', 'menu', () => toggleMenu())
  menuButton.setAttribute('aria-haspopup', 'menu')
  menuButton.setAttribute('aria-expanded', 'false')
  const title = element('p', 'story-work-title')
  const context = element('p', 'story-chapter-context')
  const titleBlock = element('div', 'story-title-block')
  titleBlock.append(title, context)
  menuIsland.append(menuButton, titleBlock)
  const menu = element('div', 'story-menu story-canvas-control')
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', t('story.menu'))
  menu.hidden = true
  const menuItem = (key: string, symbol: IconName, run: () => void) => {
    const item = button(t(`story.${key}`), 'story-menu-item', symbol)
    item.setAttribute('role', 'menuitem')
    item.onclick = () => { closeMenu(); run() }
    return item
  }
  menu.append(
    menuItem('find', 'search', () => sidebarTo('find')), menuItem('tags', 'list', () => sidebarTo('tags')),
    menuItem('trash', 'trash', () => sidebarTo('trash')), element('hr'),
    menuItem('exportImage', 'image', () => exportImage()), menuItem('exportProject', 'download', () => {
      if (snapshot?.book) showProjectExport({ library: scope.library, id: scope.bookId }, snapshot.book.title)
    }), element('hr'),
    menuItem('settings', 'settings', () => sidebarTo('settings')),
  )
  function toggleMenu(open = menu.hidden) {
    menu.hidden = !open
    menuButton.setAttribute('aria-expanded', String(open))
    if (open) {
      sidebarTo()
      revealed = ''
      revealSelection()
      for (const item of menu.querySelectorAll<HTMLButtonElement>('button')) item.disabled = !snapshot?.book
      menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    }
  }
  function closeMenu() { if (!menu.hidden) toggleMenu(false) }
  document.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && event.target instanceof Node && !menu.contains(event.target) && !menuButton.contains(event.target)) closeMenu()
  }, { signal })

  // ——— Tools: one row, top centre (bottom on phones) ———
  const toolbar = island('story-toolbar', t('story.tools'))
  const toolButtons = new Map<StoryTool, HTMLButtonElement>()
  for (const tool of storyTools) {
    const name = t(`story.tool.${tool}`)
    const control = button('', 'story-tool', toolIcons[tool])
    control.append(element('kbd', 'story-key', toolKeys[tool].at(-1)))
    control.setAttribute('aria-label', name)
    control.title = `${name} — ${toolKeys[tool].join(t('story.or'))}`
    control.dataset.tool = tool
    control.onclick = (event) => {
      if (event.detail === 2) { chooseTool(tool, true); return }
      chooseTool(tool)
    }
    toolButtons.set(tool, control)
    toolbar.append(control)
  }
  function chooseTool(tool: StoryTool, lock = false) {
    if (!editable() && tool !== 'select' && tool !== 'hand') return
    if (tool === 'group' && selection.size && !lock) { createGroup(); return }
    canvas.setTool(tool, lock)
  }
  function paintTools(tool: StoryTool, locked: boolean) {
    for (const [name, control] of toolButtons) {
      control.setAttribute('aria-pressed', String(name === tool))
      control.toggleAttribute('data-locked', name === tool && locked)
      if (name === tool && locked) control.setAttribute('aria-description', t('story.toolLocked'))
      else control.removeAttribute('aria-description')
    }
    if (locked) canvas.toast.show(t('story.toolLocked'))
  }

  // ——— Bottom left: zoom and history ———
  const viewIsland = island('story-view-island', t('story.viewTools'))
  const zoom = button('100%', 'button button-small button-quiet story-zoom-value')
  zoom.title = t('story.zoomReset')
  zoom.setAttribute('aria-label', t('story.zoomReset'))
  zoom.onclick = () => canvas.resetZoom()
  const undoButton = action('undo', 'undo', () => { void stepHistory(false) })
  const redoButton = action('redo', 'redo', () => { void stepHistory(true) })
  const zoomGroup = element('div', 'story-island-group')
  zoomGroup.append(action('zoomOut', 'minimize', () => canvas.zoom(1 / 1.2)), zoom, action('zoomIn', 'plus', () => canvas.zoom(1.2)), action('fit', 'focus', () => canvas.fit()))
  const historyGroup = element('div', 'story-island-group')
  historyGroup.append(undoButton, redoButton)
  viewIsland.append(zoomGroup, historyGroup)

  // ——— Properties: only while something is selected ———
  const props = element('section', 'story-props story-canvas-control')
  props.setAttribute('aria-label', t('story.properties'))
  props.hidden = true

  // ——— Floating side panels: card list, tags, trash, settings ———
  const left = element('aside', 'story-sidebar story-canvas-control')
  left.hidden = true
  const right = element('aside', 'story-inspector story-canvas-control')
  right.hidden = true
  const sidebarHead = element('div', 'story-inspector-head')
  const sidebarTitle = element('h2')
  const sidebarContent = element('div', 'story-sidebar-content')
  const search = storyInput('', 'search')
  search.placeholder = t('story.search')
  search.setAttribute('aria-label', search.placeholder)
  let sidebar: 'find' | 'tags' | 'trash' | 'settings' | undefined
  const result = element('div', 'story-results')
  const closeSidebar = action('closePanel', 'close', () => sidebarTo())
  sidebarHead.append(sidebarTitle, closeSidebar)
  left.append(sidebarHead, sidebarContent)

  const imageFile = element('input')
  imageFile.type = 'file'
  imageFile.accept = 'image/png,image/jpeg,image/gif,image/webp'
  imageFile.hidden = true
  imageFile.onchange = () => {
    const file = imageFile.files?.[0]
    imageFile.value = ''
    if (file) void addImage(file, file.name, imagePoint).catch(report)
  }

  stage.append(canvas.surface, menuIsland, menu, toolbar, viewIsland, props, left, right, message)
  main.append(stage, imageFile)
  main.classList.toggle('story-no-grid', !grid)
  ready = true

  function paintControls() {
    const unavailable = !editable()
    undoButton.disabled = unavailable || !undo.length
    redoButton.disabled = unavailable || !redo.length
    for (const [tool, control] of toolButtons) control.disabled = unavailable && tool !== 'select' && tool !== 'hand'
  }

  function activeChapter(): StoryChapter | undefined {
    const edition = snapshot?.editions.find(({ id }) => id === chapter?.editionId)
    return edition?.chapters.some(({ id }) => id === chapter?.chapterId) ? chapter : undefined
  }

  function paintContext() {
    const active = activeChapter()
    const edition = snapshot?.editions.find(({ id }) => id === active?.editionId)
    const entry = edition?.chapters.find(({ id }) => id === active?.chapterId)
    context.textContent = entry ? t('story.defaultChapter', [entry.title]) : ''
    context.hidden = !entry
  }

  function routeChanged(hash: string) {
    const next = parseStoryRoute(hash)
    if (!next || next.library !== scope.library || next.bookId !== scope.bookId) return
    chapter = next.chapter
    history.replaceState(null, '', hash)
    paintContext()
  }
  window.newWorldDesktop?.onStoryContext?.(routeChanged)
  window.addEventListener('hashchange', () => routeChanged(location.hash), { signal })

  // ——— Placing floating panels beside, never over, the selection ———

  const phone = () => stage.clientWidth <= 600
  const noHover = matchMedia('(hover: none)')
  const coarse = matchMedia('(any-pointer: coarse)')
  const rectOf = (item: HTMLElement): Rect => {
    const box = item.getBoundingClientRect(), base = stage.getBoundingClientRect()
    return { x: box.left - base.left, y: box.top - base.top, width: box.width, height: box.height }
  }
  const overlapArea = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

  /** The two places the properties panel may take: left/right on wide screens, bottom/top on phones. */
  function propSlots(): Rect[] {
    const width = stage.clientWidth, height = stage.clientHeight
    const top = rectOf(menuIsland).y + rectOf(menuIsland).height + 8
    if (phone()) {
      const size = { width: width - 16, height: props.offsetHeight }
      const bottom = rectOf(toolbar).y - 8 - size.height
      return [{ x: 8, y: bottom, ...size }, { x: 8, y: top, ...size }]
    }
    const size = { width: props.offsetWidth, height: props.offsetHeight }
    return [{ x: 12, y: top, ...size }, { x: width - 12 - size.width, y: top, ...size }]
  }

  function placeFloating() {
    if (props.hidden) return
    // Keep a margin round the selection, so even a flat arrow has room.
    const raw = canvas.selectionRect()
    const pad = coarse.matches ? 28 : 16
    const target = raw && { x: raw.x - pad, y: raw.y - pad, width: raw.width + pad * 2, height: raw.height + pad * 2 }
    const slots = propSlots()
    // Never over the selection; then stay clear of an open side panel.
    const panels = [left, right].filter((item) => !item.hidden).map(rectOf)
    const cost = (slot: Rect) => (target ? overlapArea(slot, target) * 1000 : 0) + panels.reduce((sum, panel) => sum + overlapArea(slot, panel), 0)
    const slot = slots.reduce((best, slot) => cost(slot) < cost(best) ? slot : best)
    props.style.left = `${slot.x}px`
    props.style.top = `${slot.y}px`
    props.dataset.side = String(slots.indexOf(slot))
  }

  /** After a new selection, pan the board if a panel would still cover it. */
  function revealSelection() {
    const key = [...selection].join()
    if (!key || key === revealed) { revealed = key; return }
    revealed = key
    requestAnimationFrame(() => {
      const target = canvas.selectionRect()
      if (!target || canvas.editing()) return
      const covers = [props, right, left, menu].filter((item) => !item.hidden).map(rectOf).filter((item) => overlaps(item, target))
      if (!covers.length) return
      const cover = bounds(covers)!
      const room = { x: stage.clientWidth, y: stage.clientHeight }
      if (phone() || cover.width > room.x * .6) {
        const below = cover.y > room.y / 2
        const dy = below ? cover.y - 12 - (target.y + target.height) : cover.y + cover.height + 12 - target.y
        if (Math.abs(dy) < room.y) canvas.panBy(0, dy)
      } else {
        const onLeft = cover.x < room.x / 2
        const dx = onLeft ? cover.x + cover.width + 16 - target.x : cover.x - 16 - (target.x + target.width)
        canvas.panBy(dx, 0)
      }
    })
  }

  // ——— Properties panel content ———

  function propButton(key: string, symbol: IconName, run: () => void, text = false) {
    const control = action(key, symbol, run, text)
    control.classList.add('story-prop-button')
    return control
  }

  function segmented<T extends string>(key: string, values: readonly T[], current: T | undefined, symbols: Record<T, IconName | string>, choose: (value: T) => void) {
    const group = element('div', 'story-segmented')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', t(`story.${key}`))
    for (const value of values) {
      const symbol = symbols[value]
      const label = t(`story.${key}.${value}`)
      const control = button(symbol.length > 2 ? '' : symbol, 'button button-small button-quiet story-square', symbol.length > 2 ? symbol as IconName : undefined)
      control.setAttribute('aria-label', label)
      control.title = label
      control.setAttribute('aria-pressed', String(value === current))
      control.onclick = () => choose(value)
      group.append(control)
    }
    return group
  }

  function section(key: string, ...children: HTMLElement[]) {
    const block = element('div', 'story-prop-section')
    block.append(element('h3', '', t(`story.${key}`)), ...children)
    return block
  }

  function patchEdges(change: Partial<StoryEdge>) {
    const ids = new Set(selection)
    void commit({ ...board.scene, edges: board.scene.edges.map((edge) => ids.has(edge.id) ? { ...edge, ...change } : edge) })
  }

  /** A button that steps through a list of values, for the compact phone sheet. */
  function cycle<T extends string>(key: string, values: readonly T[], current: T | undefined, glyph: (value: T) => string | HTMLElement, choose: (value: T) => void) {
    const next = values[(values.indexOf(current as T) + 1) % values.length]
    const control = button('', 'button button-small button-quiet story-square story-cycle')
    const label = `${t(`story.${key}`)}：${current ? t(`story.${key}.${current}`) : '—'}`
    control.setAttribute('aria-label', label)
    control.title = label
    control.append(current ? glyph(current) : '·')
    control.onclick = () => choose(next)
    return control
  }

  function paintProps() {
    const ids = [...selection]
    const nodes = board.scene.nodes.filter(({ id }) => selection.has(id))
    const edges = board.scene.edges.filter(({ id }) => selection.has(id))
    props.hidden = !ids.length || !editable()
    if (props.hidden) { props.replaceChildren(); return }
    const compact = phone()
    props.classList.toggle('story-props-compact', compact)
    const items: HTMLElement[] = []
    const single = ids.length === 1 ? nodes[0] : undefined
    const primary: HTMLElement[] = []
    if (single?.kind === 'card') primary.push(propButton('openCard', 'edit', () => edit(single.id), !compact), propButton('rename', 'format', () => canvas.rename(single.id)))
    if (single?.kind === 'group') primary.push(propButton('rename', 'format', () => canvas.rename(single.id), !compact))
    if (single?.kind === 'text') primary.push(propButton('editText', 'edit', () => canvas.editText(single.id), !compact))
    if (edges.length === 1 && ids.length === 1) primary.push(propButton('relationName', 'format', () => canvas.editLabel(edges[0].id), !compact))
    // Without a mouse there is no hover, so a selected card shows its details here.
    const details = single?.kind === 'card' && noHover.matches ? cardDetails(single, board.scene.tags, 3) : undefined
    if (details) items.push(details)
    const same = <K extends keyof StoryEdge>(key: K) => edges.length && edges.every((edge) => edge[key] === edges[0][key]) ? edges[0][key] : undefined
    const strokeGlyph = { solid: '—', dash: '- -', dot: '··' }
    const directionGlyph = { forward: '→', back: '←', both: '↔', none: '—' }
    const arrange = [propButton('duplicate', 'copy', () => duplicate()), propButton('delete', 'trash', () => deleteSelection())]
    arrange[1].classList.add('remove-button')
    if (compact) {
      // Phones get one short row, so the sheet never covers what it edits.
      const row = element('div', 'story-prop-row')
      row.append(...primary)
      if (edges.length) {
        const color = same('color')
        row.append(
          cycle('color', edgeColors, edgeColors.includes(color as string) ? color as string : undefined, (value) => {
            const dot = element('span', 'story-swatch-dot')
            dot.style.setProperty('--swatch', value)
            return dot
          }, (value) => patchEdges({ color: value })),
          cycle('stroke', storyStrokes, same('stroke'), (value) => strokeGlyph[value], (stroke) => patchEdges({ stroke })),
          cycle('direction', storyDirections, same('direction'), (value) => directionGlyph[value], (direction) => patchEdges({ direction })),
        )
      } else row.append(propButton('bringFront', 'up', () => reorder(true)), propButton('sendBack', 'down', () => reorder(false)))
      row.append(...arrange)
      items.push(row)
    } else {
      if (primary.length) { const row = element('div', 'story-prop-row'); row.append(...primary); items.push(row) }
      if (edges.length) {
        const colors = element('div', 'story-swatches')
        colors.setAttribute('role', 'group')
        colors.setAttribute('aria-label', t('story.color'))
        for (const value of edgeColors) {
          const swatch = button('', 'story-swatch')
          swatch.style.setProperty('--swatch', value)
          swatch.setAttribute('aria-label', value)
          swatch.setAttribute('aria-pressed', String(same('color') === value))
          swatch.onclick = () => patchEdges({ color: value })
          colors.append(swatch)
        }
        const custom = storyInput(String(same('color') ?? defaultStoryColor), 'color')
        custom.className = 'story-swatch story-swatch-custom'
        custom.setAttribute('aria-label', t('story.customColor'))
        custom.onchange = () => patchEdges({ color: custom.value })
        colors.append(custom)
        items.push(section('color', colors))
        items.push(section('stroke', segmented('stroke', storyStrokes, same('stroke'), { solid: 'rule', dash: '- -', dot: '··' }, (stroke) => patchEdges({ stroke }))))
        items.push(section('direction', segmented('direction', storyDirections, same('direction'), directionGlyph, (direction) => patchEdges({ direction }))))
      }
      const actions = element('div', 'story-prop-row')
      actions.append(propButton('bringFront', 'up', () => reorder(true)), propButton('sendBack', 'down', () => reorder(false)), ...arrange)
      items.push(section('arrange', actions))
    }
    props.replaceChildren(...items)
    placeFloating()
  }

  // ——— Scene changes ———

  function spawn(): Point {
    const mid = canvas.center()
    const offset = board.scene.nodes.length % 7 * 25
    return { x: mid.x - 100 + offset, y: mid.y - 65 + offset }
  }

  function replaceNode(node: StoryNode) {
    const nodes = board.scene.nodes
    return { ...board.scene, nodes: nodes.some(({ id }) => id === node.id) ? nodes.map((current) => current.id === node.id ? node : current) : [...nodes, node] }
  }

  /**
   * Shows a change at once and saves changes one after another, each on top of the last, so quick
   * edits never wait for or overwrite each other. If a save is refused, the board goes back to the
   * last saved state, the changes queued after it are dropped, and the reason is shown.
   */
  function write(next: StoryScene, add: TrashEntry[], remove: TrashEntry[], history?: () => void) {
    if (!snapshot?.book) return Promise.resolve(false)
    const turn = generation
    board = { ...board, scene: next }
    canvas.setScene(next)
    pending++
    writing = true
    paintControls()
    paintProps()
    paintSidebar()
    report()
    const run = queue.then(async () => {
      if (turn !== generation) return false
      try {
        saved = await saveStoryScene(scope, saved.revision, next, { add, remove })
        board = { ...saved, scene: board.scene }
        history?.()
        return true
      } catch (error) {
        generation++
        board = saved
        canvas.setScene(saved.scene)
        paintProps()
        paintSidebar()
        report(error)
        refreshPending = true
        return false
      } finally {
        pending--
        writing = pending > 0
        paintControls()
        if (!writing && refreshPending) { refreshPending = false; void refresh() }
      }
    })
    queue = run.then(() => undefined)
    return run
  }

  function commit(next: StoryScene, trash: TrashEntry[] = []) {
    const history = { before: board.scene, after: next, trash }
    return write(next, trash, [], () => {
      undo = [...undo.slice(-49), history]
      redo = []
    })
  }

  async function stepHistory(forward: boolean) {
    if (!finishPanel()) return
    // Undo the latest change, including one still being saved.
    await queue
    const entry = (forward ? redo : undo).at(-1)
    if (!entry) return
    if (await write(forward ? entry.after : entry.before, forward ? entry.trash : [], forward ? [] : entry.trash, () => {
      if (forward) { redo.pop(); undo.push(entry) } else { undo.pop(); redo.push(entry) }
    })) closePanel()
  }

  function closePanel() {
    panel = undefined
    editedId = ''
    right.replaceChildren()
    right.hidden = true
    placeFloating()
  }

  function finishPanel() {
    if (!panel?.editing()) return true
    panel.status(t('story.finishEditing'))
    return false
  }

  function cardPanel(input: StoryCardInput, id: string, focus = true) {
    let expected = JSON.stringify(input)
    panel = cardInspector({
      heading: t('story.editCard'),
      close: closePanel,
      remove: () => deleteSelection([id]),
      save: async (value) => {
        const current = board.scene.nodes.find((node) => node.id === id)
        if (current?.kind !== 'card' || JSON.stringify(cardInput(current)) !== expected) throw new Error(t('story.conflict'))
        const next = { ...current, ...value }
        if (!await commit(replaceNode(next))) throw new Error(message.textContent ?? t('story.conflict'))
        expected = JSON.stringify(cardInput(next))
        canvas.select([id])
      },
    }, input, !input.fields.length && !input.body.trim(), () => sidebarTo('tags'))
    editedId = id
    right.replaceChildren(panel.form)
    right.hidden = false
    placeFloating()
    panel.refresh(snapshot?.editions ?? [], board.scene.tags)
    if (focus) panel.focus()
    revealed = ''
    revealSelection()
  }

  function createCard(rect: Rect, name: string) {
    if (!editable()) return
    const id = crypto.randomUUID()
    void commit(replaceNode({ ...rect, kind: 'card', id, ...blankStoryCard(activeChapter()), name }))
    canvas.select([id])
  }

  function edit(id: string, focus = true, force = false) {
    if (!snapshot?.book || (!force && !finishPanel())) return
    const node = board.scene.nodes.find((item) => item.id === id)
    if (node?.kind !== 'card') return
    if (phone()) sidebarTo()
    canvas.select([id])
    cardPanel(cardInput(node), node.id, focus)
  }

  function createGroup() {
    const selected = selectedNodes(board.scene.nodes, selection)
    const box = bounds(selected)
    if (!box || !editable()) return
    const id = crypto.randomUUID()
    const rect = { x: box.x - 25, y: box.y - 44, width: box.width + 50, height: box.height + 69 }
    void commit({ ...board.scene, nodes: [{ ...rect, kind: 'group', id, name: t('story.group') }, ...board.scene.nodes] })
    canvas.select([id])
  }

  async function addImage(file: Blob, name: string, at?: Point) {
    const src = await rasterData(file)
    if (!src) throw new Error(t('story.invalidImage'))
    const image = new Image()
    image.src = src
    await image.decode()
    const height = Math.round(Math.min(300, Math.max(65, 230 * image.naturalHeight / image.naturalWidth)))
    const point = at ? { x: Math.round(at.x - 115), y: Math.round(at.y - height / 2) } : spawn()
    const id = crypto.randomUUID()
    void commit(replaceNode({ ...point, kind: 'image', src, name, id, width: 230, height }))
    canvas.select([id])
  }

  function deleteSelection(ids = [...selection]) {
    if (!editable() || !ids.length) return
    const selected = new Set(ids)
    const cards = storyCards(board.scene).filter(({ id }) => selected.has(id))
    const removeNow = async () => {
      // The board may have been saved meanwhile; only refuse if a card to delete has changed or gone.
      if (cards.some((card) => JSON.stringify(board.scene.nodes.find(({ id }) => id === card.id)) !== JSON.stringify(card))) throw new Error(t('story.conflict'))
      const entries = cards.map((card) => {
        const entry = trashEntry('storyCard', scope.library, scope.bookId, card.name)
        entry.storyCard = card
        return entry
      })
      const removeNodes = new Set(board.scene.nodes.filter((node) => selected.has(node.id) && node.kind !== 'card').map(({ id }) => id))
      const edges = remainingStoryEdges(board.scene.edges, new Set(ids), removeNodes)
      if (!await commit({ ...board.scene, edges, nodes: board.scene.nodes.filter(({ id }) => !selected.has(id)) }, entries)) {
        throw new Error(message.textContent ?? t('story.conflict'))
      }
      if (selected.has(editedId)) closePanel()
    }
    if (cards.length) formDialog(main, {
      title: t('story.deleteTitle'), action: t('story.deleteConfirm'), danger: true,
      description: t('story.deleteDescription', [cards.length]),
    }, removeNow)
    else void removeNow().catch(report)
  }

  function reorder(front: boolean) {
    const chosen = (items: { id: string }[]) => items.filter(({ id }) => selection.has(id))
    const rest = (items: { id: string }[]) => items.filter(({ id }) => !selection.has(id))
    const order = <T extends { id: string }>(items: T[]) => (front ? [...rest(items), ...chosen(items)] : [...chosen(items), ...rest(items)]) as T[]
    void commit({ ...board.scene, nodes: order(board.scene.nodes), edges: order(board.scene.edges) })
  }

  /** Spreads pasted arrows that join the same two nodes as an existing arrow into separate curves. */
  function spread(existing: StoryEdge[], added: StoryEdge[]) {
    const all = [...existing]
    return added.map((edge) => {
      let next = edge
      if (isNodeEnd(edge.from) && isNodeEnd(edge.to)) {
        const used = parallelBends(all, edge.from.nodeId, edge.to.nodeId)
        if (used.some((bend) => Math.abs(bend - edge.bend) < 24)) next = { ...edge, bend: freeBend(used) }
      }
      all.push(next)
      return next
    })
  }

  function insert(pasted: ReturnType<typeof pasteStorySelection>) {
    if (!pasted || (!pasted.nodes.length && !pasted.edges.length)) return
    const edges = spread(board.scene.edges, pasted.edges)
    void commit({ nodes: [...board.scene.nodes, ...pasted.nodes], edges: [...board.scene.edges, ...edges], tags: pasted.tags })
    canvas.select([...pasted.nodes, ...edges].map(({ id }) => id))
  }

  function duplicate() {
    if (!editable() || !selection.size || !finishPanel()) return
    const encoded = copyStorySelection(scope, board.scene, selection)
    const box = canvas.selectionRect()
    if (!encoded || !box) return
    const view = canvas.view()
    const middle = center(box)
    insert(pasteStorySelection(encoded, scope, board.scene, { x: (middle.x - view.x) / view.zoom, y: (middle.y - view.y) / view.zoom }))
  }

  function nudge(dx: number, dy: number) {
    if (!editable() || !selection.size) return
    const moving = new Set(selectedNodes(board.scene.nodes, selection).map(({ id }) => id))
    const shift = <T extends object>(end: T) => 'x' in end && 'y' in end && !('width' in end) ? { ...end, x: (end.x as number) + dx, y: (end.y as number) + dy } : end
    void commit({
      ...board.scene,
      nodes: board.scene.nodes.map((node) => moving.has(node.id) ? { ...node, x: node.x + dx, y: node.y + dy } : node),
      edges: board.scene.edges.map((edge) => selection.has(edge.id) ? { ...edge, from: shift(edge.from), to: shift(edge.to) } : edge),
    })
  }

  async function copyToClipboard() {
    const encoded = copyStorySelection(scope, board.scene, selection)
    if (!encoded) return
    clipboard = encoded
    try { await navigator.clipboard.writeText(encoded) } catch { /* Same-window paste still works. */ }
  }

  function pasteText(content: string) {
    if (!content || !editable() || !finishPanel()) return
    const pasted = pasteStorySelection(content, scope, board.scene, canvas.center())
    if (pasted) { insert(pasted); return }
    const id = crypto.randomUUID()
    void commit(replaceNode({ ...spawn(), id, kind: 'text', width: 220, height: 104, text: content }))
    canvas.select([id])
  }

  function exportImage() {
    if (!board.scene.nodes.length && !board.scene.edges.length) { canvas.toast.show(t('story.exportEmpty')); return }
    const scope = element('label', 'field-label')
    const choice = element('select', 'title-input')
    choice.name = 'scope'
    choice.add(new Option(t('story.exportAll'), 'all'))
    if (selection.size) choice.add(new Option(t('story.exportSelection'), 'selection', true, true))
    scope.append(element('span', '', t('story.exportScope')), choice)
    const chosen = new Set(selection)
    formDialog(main, { title: t('story.exportImage'), action: t('story.exportSave'), fields: [scope] }, async (data) => {
      const blob = await storyImage(board.scene, data.get('scope') === 'selection' ? chosen : undefined, getComputedStyle(main).fontFamily)
      if (!blob) throw new Error(t('story.exportEmpty'))
      const name = (snapshot?.book?.title ?? t('story.title')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180)
      downloadFile(blob, `${name}.png`)
    })
  }

  // ——— Clipboard and keyboard ———

  const textControl = (target: EventTarget | null) => target instanceof Element && target.closest('input, select, textarea, [contenteditable]')
  window.addEventListener('copy', (event) => {
    if (textControl(event.target) || document.querySelector('dialog[open]') || !event.clipboardData) return
    const encoded = copyStorySelection(scope, board.scene, selection)
    if (!encoded) return
    clipboard = encoded
    event.clipboardData.setData('text/plain', encoded)
    event.preventDefault()
  }, { signal })
  window.addEventListener('paste', (event) => {
    if (textControl(event.target) || document.querySelector('dialog[open]') || !event.clipboardData) return
    const file = [...event.clipboardData.files].find((file) => file.type.startsWith('image/'))
    if (file) void addImage(file, file.name).catch(report)
    else pasteText(event.clipboardData.getData('text/plain') || clipboard)
    event.preventDefault()
  }, { signal })

  const keyTools: Record<string, StoryTool> = {
    v: 'select', 1: 'select', h: 'hand', r: 'card', 2: 'card', a: 'arrow', 5: 'arrow', t: 'text', 8: 'text', f: 'group', 9: 'image', e: 'eraser', 0: 'eraser',
  }
  window.addEventListener('keydown', (event) => {
    if (event.isComposing || document.querySelector('dialog[open]')) return
    if (event.key === 'Escape') {
      if (!menu.hidden) { closeMenu(); menuButton.focus(); event.preventDefault(); return }
      if (canvas.dismiss()) { event.preventDefault(); return }
      if (textControl(event.target) && !right.contains(event.target as Node) && !left.contains(event.target as Node)) return
      if (panel) closePanel()
      else if (sidebar) sidebarTo()
      else canvas.select([])
      return
    }
    if (textControl(event.target) || canvas.editing() || (event.target instanceof Element && event.target.closest('.story-menu'))) return
    const modifier = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()
    if (modifier && key === 'z') { event.preventDefault(); void stepHistory(event.shiftKey) }
    else if (modifier && key === 'y') { event.preventDefault(); void stepHistory(true) }
    else if (modifier && key === 'a') { event.preventDefault(); canvas.select([...board.scene.nodes, ...board.scene.edges].map(({ id }) => id)) }
    else if (modifier && key === 'd') { event.preventDefault(); duplicate() }
    else if (modifier) return
    else if (event.shiftKey && event.code === 'Digit1') { event.preventDefault(); canvas.fit() }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelection() }
    else if (event.key.startsWith('Arrow') && selection.size) {
      event.preventDefault()
      const step = event.shiftKey ? 10 : 1
      nudge(event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0)
    } else if (event.key === 'Enter' && selection.size === 1 && !(event.target instanceof HTMLButtonElement)) {
      const [id] = selection
      const node = board.scene.nodes.find((item) => item.id === id)
      event.preventDefault()
      if (node?.kind === 'card') edit(id)
      else if (node?.kind === 'text') canvas.editText(id)
      else if (node?.kind === 'group') canvas.rename(id)
      else if (!node) canvas.editLabel(id)
    } else if (key === 'q' && !event.shiftKey && !event.altKey) { event.preventDefault(); canvas.toggleLock() }
    else if (!event.shiftKey && !event.altKey && keyTools[key]) { event.preventDefault(); chooseTool(keyTools[key]) }
  }, { signal })
  window.addEventListener('beforeunload', (event) => {
    if (!panel?.editing() && !canvas.editing() && !writing) return
    panel?.status(t('story.finishEditing'))
    event.preventDefault()
    event.returnValue = true
  })

  // ——— Side panels ———

  function sidebarTo(mode?: typeof sidebar) {
    if (mode === 'tags' && mode !== sidebar) {
      displayedTags.clear()
      result.replaceChildren()
    }
    sidebar = mode
    left.hidden = !mode
    placeFloating()
    if (!mode) return
    revealed = ''
    revealSelection()
    if (phone()) closePanel()
    sidebarTitle.textContent = t(`story.${mode}`)
    sidebarContent.replaceChildren(...(mode === 'find' ? [search, result] : [result]))
    paintSidebar()
    if (mode === 'find') search.focus({ preventScroll: true })
    else closeSidebar.focus({ preventScroll: true })
  }

  function tagForm(tag?: StoryTag) {
    const form = element('form', 'story-tag-form')
    const name = storyInput(tag?.name ?? '')
    name.placeholder = t('story.tagName')
    name.maxLength = maxStoryName
    name.setAttribute('aria-label', t('story.tagName'))
    name.required = true
    const color = storyInput(tag?.color ?? defaultStoryColor, 'color')
    color.setAttribute('aria-label', t('story.color'))
    const save = button(t(tag ? 'story.save' : 'story.newTag'), 'button button-small button-quiet')
    save.type = 'submit'
    form.append(name, color, save)
    form.onsubmit = (event) => {
      event.preventDefault()
      const draftName = name.value
      const draftColor = color.value
      const value = draftName.trim()
      if (!value || (tag && !board.scene.tags.some(({ id }) => id === tag.id))) return
      const next = { id: tag?.id ?? crypto.randomUUID(), name: value, color: draftColor }
      const tags = tag ? board.scene.tags.map((row) => row.id === tag.id ? next : row) : [...board.scene.tags, next]
      void commit({ ...board.scene, tags }).then((saved) => {
        if (!saved) return
        if (!tag && name.value === draftName && color.value === draftColor) {
          name.value = ''
          color.value = defaultStoryColor
        }
        panel?.refresh(snapshot?.editions ?? [], board.scene.tags)
      })
    }
    return form
  }

  function toggle(key: 'snapping' | 'grid', value: boolean, change: (value: boolean) => void) {
    const input = element('input')
    input.type = 'checkbox'
    input.checked = value
    input.onchange = () => change(input.checked)
    const label = storyLabel(t(`story.${key}`), input)
    label.className = 'story-toggle'
    return label
  }

  function paintSidebar() {
    if (!sidebar) return
    if (sidebar === 'find') {
      const cards = storyCards(board.scene).filter((card) => matchesStoryCard(card, search.value)).sort((a, b) => a.name.localeCompare(b.name, locale))
      const rows = cards.map((card) => {
        const row = button(card.name, 'story-result')
        if (card.aliases.length) row.append(element('small', '', card.aliases.join(t('story.nameSeparator'))))
        row.onclick = () => {
          if (phone()) sidebarTo()
          canvas.select([card.id])
          canvas.fit(card)
        }
        return row
      })
      result.replaceChildren(...(rows.length ? rows : [element('p', 'dialog-help', t('story.noMatch'))]))
    } else if (sidebar === 'tags') {
      // Keep an unrelated row's draft and focus when another tag is saved.
      const rows = new Map([undefined, ...board.scene.tags].map((tag) => {
        const id = tag?.id
        const previous = displayedTags.get(id)
        const form = previous && previous.tag?.name === tag?.name && previous.tag?.color === tag?.color ? previous.form : tagForm(tag)
        return [id, { tag, form }] as const
      }))
      for (const [id, { form }] of displayedTags) if (rows.get(id)?.form !== form) form.remove()
      let anchor: ChildNode | null = result.firstChild
      for (const { form } of rows.values()) {
        if (form !== anchor) result.insertBefore(form, anchor)
        anchor = form.nextSibling
      }
      displayedTags = rows
    } else if (sidebar === 'trash') {
      const rows = (snapshot?.trash ?? []).map((entry) => {
        const row = element('div', 'story-trash-row')
        const restore = button(t('trash.restore'), 'button button-small button-quiet')
        restore.onclick = async () => {
          restore.disabled = true
          try { await restoreTrash(entry.id) } catch (error) { report(error); restore.disabled = false }
        }
        row.append(element('strong', '', entry.title), restore)
        return row
      })
      result.replaceChildren(...(rows.length ? rows : [element('p', 'dialog-help', t('trash.theTrashIsEmpty'))]))
    } else if (!result.querySelector('.story-toggle')) {
      const list = element('dl', 'story-shortcuts')
      for (const [id, keys] of [
        ...storyTools.map((tool) => [`tool.${tool}`, toolKeys[tool].join(t('story.or'))] as const),
        ...shortcuts.map(([id, keys]) => [`shortcut.${id}`, keys] as const),
      ]) list.append(element('dt', '', t(`story.${id}`)), element('dd', '', keys))
      const help = element('details', 'story-shortcut-help')
      help.append(element('summary', '', t('story.shortcuts')), list)
      result.replaceChildren(
        toggle('snapping', snapping, (value) => { snapping = value; remember('snapping', value) }),
        toggle('grid', grid, (value) => { grid = value; remember('grid', value); main.classList.toggle('story-no-grid', !value) }),
        help,
      )
    }
  }
  search.oninput = paintSidebar

  async function refresh() {
    const request = ++turn
    try {
      const next = await readStorySettings(scope)
      if (request !== turn) return
      if (writing) { refreshPending = true; return }
      snapshot = next
      title.textContent = next.book?.title ?? ''
      paintContext()
      document.title = next.book ? t('story.windowTitle', [next.book.title]) : t('story.title')
      if (!next.book) {
        board = saved = emptyStoryBoard(scope)
        opened = false
        undo = redo = []
        closePanel()
        canvas.setScene(board.scene)
        report(new Error(t('story.workUnavailable')))
      } else if (!opened || next.board.revision !== board.revision) {
        if (!opened) {
          canvas.showView(next.board.view)
          zoom.textContent = `${Math.round(next.board.view.zoom * 100)}%`
        }
        board = saved = next.board
        canvas.setScene(board.scene)
        undo = redo = []
        opened = true
        if (editedId && !panel?.editing()) {
          if (board.scene.nodes.some(({ id }) => id === editedId)) edit(editedId, false)
          else closePanel()
        }
        report()
        if (next.repair?.changed) saveRepair(next.repair)
      }
      panel?.refresh(next.editions, board.scene.tags)
      paintControls()
      paintProps()
      paintSidebar()
    } catch (error) {
      if (request === turn) report(error)
    }
  }
  window.addEventListener('focus', () => { void refresh() }, { signal })
  watchStoryChanges(scope, () => { void refresh() }, signal)
  paintControls()
  paintTools('select', false)
  void refresh()
}

if (work) mount(work)
else main.append(notice(t('story.workUnavailable'), true))
