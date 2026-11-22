import { locale, t } from '../i18n'
import { formDialog } from '../dialogs'
import { storageError, trashEntry } from '../library'
import type { TrashEntry } from '../library'
import { rasterData } from '../documents/markup'
import { fixedPage } from '../shell/fixed-page'
import { restoreTrash } from '../trash'
import { button, element, icon, notice } from '../ui'
import type { IconName } from '../ui'
import { cardInspector, edgeInspector, objectInspector, storyInput, storyLabel } from './card-editor'
import { storyCanvas } from './canvas'
import { watchStoryChanges } from './changes'
import { bounds, selectedNodes } from './geometry'
import { blankStoryCard, cardInput, defaultStoryColor, emptyStoryBoard, matchesStoryCard, maxStoryName, storyCards } from './model'
import type { Point, StoryCardInput, StoryChapter, StoryEdge, StoryNode, StoryScene, StoryTag } from './model'
import { parseStoryRoute } from './route'
import { copyStorySelection, pasteStorySelection, remainingStoryEdges } from './selection'
import { readStorySettings, saveStoryScene, saveStoryView } from './store'
import './window.css'

const main = element('main', 'story-window')
document.body.replaceChildren(main)
document.title = t('story.title')
const work = parseStoryRoute(location.hash)
if (work) mount(work)
else main.append(notice(t('story.workUnavailable'), true))

type Panel = ReturnType<typeof cardInspector> | ReturnType<typeof edgeInspector> | ReturnType<typeof objectInspector>
type Snapshot = Awaited<ReturnType<typeof readStorySettings>>
interface HistoryEntry { before: StoryScene; after: StoryScene; trash: TrashEntry[] }

function mount(route: NonNullable<typeof work>) {
  const scope = { library: route.library, bookId: route.bookId }
  const signal = new AbortController().signal
  fixedPage(main, signal)
  let chapter = route.chapter
  let board = emptyStoryBoard(scope)
  let snapshot: Snapshot | undefined
  let opened = false
  let writing = false
  let refreshPending = false
  let turn = 0
  let selection: ReadonlySet<string> = new Set()
  let panel: Panel | undefined
  let editedId = ''
  let undo: HistoryEntry[] = []
  let redo: HistoryEntry[] = []
  let clipboard = ''
  let hand = false
  let displayedTags = ''

  const header = element('header', 'story-header')
  const heading = element('div', 'story-title')
  heading.append(icon('cards'), element('h1', '', t('story.title')))
  const title = element('p', 'story-work-title')
  const context = element('p', 'story-chapter-context')
  const titleLine = element('div', 'story-title-line')
  titleLine.append(title, context)
  header.append(heading, titleLine)
  const bar = element('div', 'story-tools')
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', t('story.canvas'))
  const message = element('p', 'story-banner')
  message.setAttribute('role', 'status')
  message.hidden = true

  const stage = element('div', 'story-stage')
  const layout = element('div', 'story-layout')
  const left = element('aside', 'story-sidebar')
  left.hidden = true
  const right = element('aside', 'story-inspector')
  right.hidden = true
  const sidebarHead = element('div', 'story-inspector-head')
  const sidebarTitle = element('h2')
  const sidebarContent = element('div', 'story-sidebar-content')
  const search = storyInput('', 'search')
  search.placeholder = t('story.search')
  search.setAttribute('aria-label', search.placeholder)
  let sidebar: 'find' | 'tags' | 'trash' | undefined
  const result = element('div', 'story-results')
  left.append(sidebarHead, sidebarContent)

  function report(error?: unknown) {
    message.hidden = error === undefined
    message.textContent = error === undefined ? '' : storageError(error)
  }

  const canvas = storyCanvas({
    select(next) { selection = next; paintControls() },
    create: (point) => newCard(point),
    prepareLink() {
      if (!snapshot?.book || writing || !finishPanel()) return false
      closePanel()
      if (!left.hidden && innerWidth <= 800) sidebarTo()
      return true
    },
    linkModeChanged(active) {
      connect.setAttribute('aria-pressed', String(active))
      if (active) setHand(false)
    },
    removeEdge: (id) => deleteSelection([id]),
    edit: (id) => edit(id),
    change(scene, relation) {
      if (!snapshot?.book) return
      void commit(scene).then((saved) => {
        if (!saved || !relation) return
        canvas.select([relation.id])
        if (relation.inspect) edit(relation.id)
        canvas.connected(relation.id)
      })
    },
    viewChanged(view) {
      zoom.textContent = `${Math.round(view.zoom * 100)}%`
      if (snapshot?.book) void saveStoryView(scope, view).catch(report)
    },
  })

  function action(key: string, symbol: IconName, run: () => void, text = false) {
    const label = t(`story.${key}`)
    const control = button(text ? label : '', `button button-small button-quiet ${text ? '' : 'story-square'}`, symbol)
    control.title = label
    control.setAttribute('aria-label', label)
    control.onclick = run
    return control
  }

  const closeSidebar = action('closePanel', 'close', () => sidebarTo())
  sidebarHead.append(sidebarTitle, closeSidebar)
  const find = action('find', 'search', () => sidebarTo(sidebar === 'find' ? undefined : 'find'), true)
  const tags = action('tags', 'list', () => sidebarTo(sidebar === 'tags' ? undefined : 'tags'), true)
  const trash = action('trash', 'trash', () => sidebarTo(sidebar === 'trash' ? undefined : 'trash'))
  const create = action('newCard', 'plus', () => newCard(spawn()), true)
  create.classList.remove('button-quiet')
  create.classList.add('button-primary')
  const connect = action('linkMode', 'connect', () => canvas.toggleLink(), true)
  connect.setAttribute('aria-pressed', 'false')
  const text = action('text', 'format', () => addObject({ kind: 'text', id: crypto.randomUUID(), ...spawn(), width: 180, height: 92, text: t('story.text') }))
  const group = action('group', 'panel', createGroup)
  const image = action('image', 'image', () => imageFile.click())
  const imageFile = element('input')
  imageFile.type = 'file'
  imageFile.accept = 'image/png,image/jpeg,image/gif,image/webp'
  imageFile.hidden = true
  imageFile.onchange = () => {
    const file = imageFile.files?.[0]
    imageFile.value = ''
    if (file) void addImage(file, file.name).catch(report)
  }
  function setHand(on: boolean) {
    hand = on
    canvas.hand(hand)
    pan.setAttribute('aria-pressed', String(hand))
  }
  const pan = action('pan', 'swap', () => setHand(!hand))
  pan.setAttribute('aria-pressed', 'false')
  const editSelection = action('edit', 'edit', () => { if (selection.size === 1) edit([...selection][0]) })
  const remove = action('delete', 'trash', () => deleteSelection())
  const undoButton = action('undo', 'undo', () => { void stepHistory(false) })
  const redoButton = action('redo', 'redo', () => { void stepHistory(true) })
  const copy = action('copy', 'copy', () => { void copyToClipboard() })
  const paste = action('paste', 'file', () => { void pasteFromClipboard() })
  const toolGroup = (...controls: HTMLElement[]) => {
    const group = element('div', 'story-tool-group')
    group.append(...controls)
    return group
  }
  bar.append(toolGroup(create, connect), toolGroup(text, group, image), toolGroup(pan, editSelection, remove, copy, paste),
    toolGroup(undoButton, redoButton), toolGroup(find, tags, trash))
  const zoom = element('output', 'story-zoom-value', '100%')
  const viewTools = element('div', 'story-view-tools')
  viewTools.append(action('zoomOut', 'minimize', () => canvas.zoom(1 / 1.2)), zoom, action('zoomIn', 'plus', () => canvas.zoom(1.2)),
    action('fit', 'focus', () => canvas.fit()))
  stage.append(canvas.surface, viewTools)
  layout.append(left, stage, right)
  main.append(header, bar, message, layout, imageFile)

  function paintControls() {
    const unavailable = !snapshot?.book || writing
    for (const control of [create, connect, text, group, image, paste, tags, trash, find]) control.disabled = unavailable
    for (const control of [remove, copy]) control.disabled = unavailable || !selection.size
    editSelection.disabled = unavailable || selection.size !== 1
    undoButton.disabled = unavailable || !undo.length
    redoButton.disabled = unavailable || !redo.length
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

  function spawn(): Point {
    const center = canvas.center()
    const offset = board.scene.nodes.length % 7 * 25
    return { x: center.x - 100 + offset, y: center.y - 65 + offset }
  }

  function replaceNode(node: StoryNode) {
    const nodes = board.scene.nodes
    return { ...board.scene, nodes: nodes.some(({ id }) => id === node.id) ? nodes.map((current) => current.id === node.id ? node : current) : [...nodes, node] }
  }

  async function write(next: StoryScene, add: TrashEntry[], remove: TrashEntry[], history?: () => void) {
    if (writing || !snapshot?.book) return false
    writing = true
    paintControls()
    report()
    try {
      board = await saveStoryScene(scope, board.revision, next, { add, remove })
      history?.()
      canvas.setScene(board.scene)
      paintSidebar()
      return true
    } catch (error) {
      report(error)
      refreshPending = true
      return false
    } finally {
      writing = false
      paintControls()
      if (refreshPending) { refreshPending = false; void refresh() }
    }
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
  }

  function finishPanel() {
    if (!panel?.editing()) return true
    panel.status(t('story.finishEditing'))
    return false
  }

  function includePanel(next: Panel, id = '', focus = true) {
    panel = next
    editedId = id
    right.replaceChildren(next.form)
    right.hidden = false
    if ('refresh' in next) next.refresh(snapshot?.editions ?? [], board.scene.tags)
    if (focus) next.focus()
  }

  function cardPanel(point: Point, input: StoryCardInput, id: string, existing = false, focus = true) {
    let expected = JSON.stringify(input)
    includePanel(cardInspector({
      heading: existing ? t('story.editCard') : t('story.newCard'),
      close: closePanel,
      remove: existing ? () => deleteSelection([id]) : undefined,
      save: async (value) => {
        const current = board.scene.nodes.find((node) => node.id === id)
        if (existing && (current?.kind !== 'card' || JSON.stringify(cardInput(current)) !== expected)) throw new Error(t('story.conflict'))
        const rect = current ?? { ...point, width: 210, height: 140 }
        if (!await commit(replaceNode({ kind: 'card', id, x: rect.x, y: rect.y, width: rect.width, height: rect.height, ...value }))) {
          throw new Error(message.textContent ?? t('story.conflict'))
        }
        expected = JSON.stringify(value)
        canvas.select([id])
        if (!existing) { existing = true; queueMicrotask(() => edit(id, false, true)) }
      },
    }, input, !existing, () => sidebarTo('tags')), id, focus)
  }

  function newCard(point: Point) {
    if (!snapshot?.book || writing || !finishPanel()) return
    canvas.dismiss()
    if (!left.hidden && innerWidth < 800) sidebarTo()
    cardPanel(point, blankStoryCard(activeChapter()), crypto.randomUUID())
  }

  function edit(id: string, focus = true, force = false) {
    if (!snapshot?.book || writing || (!force && !finishPanel())) return
    const node = board.scene.nodes.find((item) => item.id === id)
    const edge = board.scene.edges.find((item) => item.id === id)
    if (!node && !edge) return
    canvas.select([id])
    if (node?.kind === 'card') { cardPanel(node, cardInput(node), node.id, true, focus); return }
    const base = { close: closePanel, remove: () => deleteSelection([id]) }
    if (edge) {
      let expected = JSON.stringify(edge)
      includePanel(edgeInspector({
        ...base, heading: t('story.editEdge'),
        save: async (next: StoryEdge) => {
          if (JSON.stringify(board.scene.edges.find((current) => current.id === id)) !== expected) throw new Error(t('story.conflict'))
          if (!await commit({ ...board.scene, edges: board.scene.edges.map((current) => current.id === id ? next : current) })) {
            throw new Error(message.textContent ?? t('story.conflict'))
          }
          expected = JSON.stringify(next)
        },
      }, edge), id, focus)
    } else if (node) {
      const payload = (value: StoryNode) => value.kind === 'text' ? value.text : value.name
      let expected = payload(node)
      includePanel(objectInspector({
        ...base, heading: t(`story.${node.kind}`),
        save: async (next) => {
          const current = board.scene.nodes.find((item) => item.id === id)
          if (!current || payload(current) !== expected) throw new Error(t('story.conflict'))
          if (!await commit(replaceNode({ ...next, x: current.x, y: current.y, width: current.width, height: current.height }))) {
            throw new Error(message.textContent ?? t('story.conflict'))
          }
          expected = payload(next)
        },
      }, node), id, focus)
    }
  }

  function addObject(node: StoryNode) {
    if (!finishPanel()) return
    void commit(replaceNode(node)).then((saved) => { if (saved) edit(node.id) })
  }

  function createGroup() {
    const selected = selectedNodes(board.scene.nodes, selection)
    const box = bounds(selected)
    const rect = box ? { x: box.x - 25, y: box.y - 44, width: box.width + 50, height: box.height + 69 }
      : { ...spawn(), width: 300, height: 205 }
    addObject({ ...rect, kind: 'group', id: crypto.randomUUID(), name: t('story.group') })
  }

  async function addImage(file: Blob, name: string) {
    const src = await rasterData(file)
    if (!src) throw new Error(t('story.invalidImage'))
    const image = new Image()
    image.src = src
    await image.decode()
    const height = Math.min(300, Math.max(65, 230 * image.naturalHeight / image.naturalWidth))
    addObject({ ...spawn(), kind: 'image', src, name, id: crypto.randomUUID(), width: 230, height })
  }

  function deleteSelection(ids = [...selection]) {
    if (!snapshot?.book || writing || !ids.length) return
    const selected = new Set(ids)
    const cards = storyCards(board.scene).filter(({ id }) => selected.has(id))
    const revision = board.revision
    const removeNow = async () => {
      if (board.revision !== revision) throw new Error(t('story.conflict'))
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

  async function copyToClipboard() {
    const encoded = copyStorySelection(scope, board.scene, selection)
    if (!encoded) return
    clipboard = encoded
    try { await navigator.clipboard.writeText(encoded) } catch { /* Same-window paste still works. */ }
  }

  async function pasteFromClipboard() {
    let content = clipboard
    try { content = await navigator.clipboard.readText() || content } catch { /* Clipboard access may be disabled. */ }
    pasteText(content)
  }

  function pasteText(content: string) {
    if (!content || !snapshot?.book || !finishPanel()) return
    const pasted = pasteStorySelection(content, scope, board.scene, canvas.center())
    if (pasted) {
      const { nodes, edges, tags } = pasted
      if (!nodes.length && !edges.length) return
      void commit({ nodes: [...board.scene.nodes, ...nodes], edges: [...board.scene.edges, ...edges], tags }).then((saved) => {
        if (saved) canvas.select([...nodes, ...edges].map(({ id }) => id))
      })
    } else addObject({ ...spawn(), id: crypto.randomUUID(), kind: 'text', width: 220, height: 104, text: content })
  }

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
  window.addEventListener('keydown', (event) => {
    if (event.isComposing || document.querySelector('dialog[open]')) return
    if (event.key === 'Escape') {
      if (canvas.dismiss()) event.preventDefault()
      else if (panel) closePanel()
      else canvas.select([])
      return
    }
    if (textControl(event.target)) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      void stepHistory(event.shiftKey)
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      canvas.select([...board.scene.nodes, ...board.scene.edges].map(({ id }) => id))
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      void stepHistory(true)
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      deleteSelection()
    }
  }, { signal })
  window.addEventListener('beforeunload', (event) => {
    if (!panel?.editing() && !canvas.editingLabel() && !writing) return
    panel?.status(t('story.finishEditing'))
    event.preventDefault()
    event.returnValue = true
  })

  function sidebarTo(mode?: typeof sidebar) {
    sidebar = mode
    displayedTags = ''
    left.hidden = !mode
    for (const [key, control] of [['find', find], ['tags', tags], ['trash', trash]] as const) {
      control.setAttribute('aria-pressed', String(mode === key))
    }
    if (!mode) return
    sidebarTitle.textContent = t(`story.${mode}`)
    sidebarContent.replaceChildren(...(mode === 'find' ? [search, result] : [result]))
    paintSidebar()
    if (mode === 'find') search.focus({ preventScroll: true })
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
      const value = name.value.trim()
      if (!value || (tag && !board.scene.tags.some(({ id }) => id === tag.id))) return
      const next = { id: tag?.id ?? crypto.randomUUID(), name: value, color: color.value }
      const tags = tag ? board.scene.tags.map((row) => row.id === tag.id ? next : row) : [...board.scene.tags, next]
      void commit({ ...board.scene, tags }).then((saved) => {
        if (saved && panel && 'refresh' in panel) panel.refresh(snapshot?.editions ?? [], board.scene.tags)
      })
    }
    return form
  }

  function paintSidebar() {
    if (!sidebar) return
    if (sidebar === 'find') {
      const cards = storyCards(board.scene).filter((card) => matchesStoryCard(card, search.value)).sort((a, b) => a.name.localeCompare(b.name, locale))
      const rows = cards.map((card) => {
        const row = button(card.name, 'story-result')
        if (card.aliases.length) row.append(element('small', '', card.aliases.join(t('story.nameSeparator'))))
        row.onclick = () => {
          if (innerWidth < 800) sidebarTo()
          canvas.select([card.id])
          canvas.fit(card)
        }
        return row
      })
      result.replaceChildren(...(rows.length ? rows : [element('p', 'dialog-help', t('story.noMatch'))]))
    } else if (sidebar === 'tags') {
      const current = JSON.stringify(board.scene.tags)
      if (current !== displayedTags) {
        displayedTags = current
        result.replaceChildren(tagForm(), ...board.scene.tags.map(tagForm))
      }
    } else {
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
        board = emptyStoryBoard(scope)
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
        board = next.board
        canvas.setScene(board.scene)
        undo = redo = []
        opened = true
        if (editedId && !panel?.editing()) {
          if ([...board.scene.nodes, ...board.scene.edges].some(({ id }) => id === editedId)) edit(editedId, false)
          else closePanel()
        }
        report()
      }
      if (panel && 'refresh' in panel) panel.refresh(next.editions, board.scene.tags)
      paintControls()
      paintSidebar()
    } catch (error) {
      if (request === turn) report(error)
    }
  }
  window.addEventListener('focus', () => { void refresh() }, { signal })
  watchStoryChanges(scope, () => { void refresh() }, signal)
  paintControls()
  void refresh()
}
