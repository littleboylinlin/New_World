import { t } from '../i18n'
import { button, element, icon } from '../ui'
import type { IconName } from '../ui'
import { optionsList, storyInput } from './card-editor'
import { clamp } from './geometry'
import { storyDirections, storyStrokes } from './model'
import type { Point, Rect, StoryEdge } from './model'

type EdgeChange = Partial<Pick<StoryEdge, 'name' | 'direction' | 'stroke'>>
interface OverlayOptions {
  connect: (id: string) => void
  prepareEdit: () => boolean
  name: (id: string) => void
  change: (id: string, change: EdgeChange) => void
  remove: (id: string) => void
}

function control(key: string, symbol: IconName, extra = '') {
  const item = button('', `button button-small button-quiet story-square ${extra}`, symbol)
  const label = t(`story.${key}`)
  item.setAttribute('aria-label', label)
  item.title = label
  return item
}

function picker(key: string, symbol: IconName, values: readonly string[]) {
  const label = t(`story.${key}`)
  const wrapper = element('label', 'button button-small button-quiet story-square story-edge-picker')
  wrapper.title = label
  const field = optionsList(label, values, values[0], `story.${key}.`)
  wrapper.append(icon(symbol), field)
  return { wrapper, field }
}

export function storyCanvasOverlays(surface: HTMLElement, options: OverlayOptions) {
  let selectedCard: string | undefined
  let selectedEdge: StoryEdge | undefined
  let menu: { id: string; anchor: Point } | undefined
  let editor: { edge: StoryEdge; form: HTMLFormElement } | undefined
  let deleteTouch: { pointerId: number; start: Point; edgeId: string } | undefined
  let handledDeleteTouch = false
  const more = control('cardActions', 'more', 'story-canvas-control story-card-more')
  more.setAttribute('aria-expanded', 'false')
  const menuPanel = element('div', 'story-canvas-control story-canvas-popup story-card-menu')
  menuPanel.setAttribute('role', 'group')
  menuPanel.setAttribute('aria-label', t('story.cardActions'))
  const connect = button(t('story.connectTo'), 'button button-small button-quiet', 'connect')
  menuPanel.append(connect)
  const tools = element('div', 'story-canvas-control story-canvas-popup story-edge-tools')
  tools.setAttribute('role', 'group')
  tools.setAttribute('aria-label', t('story.relationActions'))
  const name = control('renameEdge', 'edit')
  name.append(t('story.renameEdge'))
  const direction = picker('direction', 'swap', storyDirections)
  const stroke = picker('stroke', 'rule', storyStrokes)
  const remove = control('deleteEdge', 'trash', 'remove-button')
  tools.append(name, direction.wrapper, stroke.wrapper, remove)
  for (const item of [more, menuPanel, tools]) item.hidden = true
  surface.append(more, menuPanel, tools)

  const margin = 6
  function place(item: HTMLElement, across: number, down: number) {
    const left = clamp(across, margin, Math.max(margin, surface.clientWidth - item.offsetWidth - margin))
    const top = clamp(down, margin, Math.max(margin, surface.clientHeight - item.offsetHeight - margin))
    item.style.left = `${left}px`
    item.style.top = `${top}px`
  }

  function near(item: HTMLElement, point: Point, above: boolean, gap: number) {
    const higher = point.y - item.offsetHeight - gap
    const lower = point.y + gap
    const top = above ?
      (higher >= margin ? higher : lower) :
      (lower + item.offsetHeight <= surface.clientHeight - margin ? lower : higher)
    place(item, point.x - item.offsetWidth / 2, top)
  }

  function hideMenu(restoreFocus = false) {
    if (!menu) return false
    menu = undefined
    menuPanel.hidden = true
    more.setAttribute('aria-expanded', 'false')
    if (restoreFocus && !more.hidden) more.focus({ preventScroll: true })
    return true
  }

  function openMenu(id: string, anchor: Point, focus = false) {
    menu = { id, anchor }
    more.setAttribute('aria-expanded', 'true')
    menuPanel.hidden = false
    near(menuPanel, anchor, false, 8)
    if (focus) connect.focus({ preventScroll: true })
  }

  more.onclick = (event) => {
    if (hideMenu() || !selectedCard) return
    openMenu(selectedCard, { x: more.offsetLeft + more.offsetWidth / 2, y: more.offsetTop + more.offsetHeight }, event.detail === 0)
  }
  connect.onclick = () => {
    const id = menu?.id
    hideMenu()
    if (id) options.connect(id)
  }
  name.onclick = () => { if (selectedEdge) options.name(selectedEdge.id) }
  direction.field.onchange = () => {
    if (!selectedEdge) return
    const value = direction.field.value as StoryEdge['direction']
    direction.field.value = selectedEdge.direction
    if (value !== selectedEdge.direction && options.prepareEdit()) options.change(selectedEdge.id, { direction: value })
  }
  stroke.field.onchange = () => {
    if (!selectedEdge) return
    const value = stroke.field.value as StoryEdge['stroke']
    stroke.field.value = selectedEdge.stroke
    if (value !== selectedEdge.stroke && options.prepareEdit()) options.change(selectedEdge.id, { stroke: value })
  }
  // A tap can follow a captured canvas drag before the browser synthesizes a
  // fresh click. Recognize it on the delete control itself and keep keyboard
  // and mouse activation on the native click path.
  remove.onpointerdown = (event) => {
    handledDeleteTouch = false
    deleteTouch = event.pointerType === 'touch' && selectedEdge
      ? { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, edgeId: selectedEdge.id }
      : undefined
  }
  remove.onpointercancel = () => { deleteTouch = undefined }
  remove.onpointerup = (event) => {
    const touch = deleteTouch
    if (touch?.pointerId !== event.pointerId) return
    deleteTouch = undefined
    handledDeleteTouch = true
    if (Math.hypot(event.clientX - touch.start.x, event.clientY - touch.start.y) > 9 ||
        !remove.contains(document.elementFromPoint(event.clientX, event.clientY))) return
    if (selectedEdge?.id === touch.edgeId) options.remove(touch.edgeId)
  }
  remove.onclick = (event) => {
    if (event.detail && handledDeleteTouch) return
    if (selectedEdge) options.remove(selectedEdge.id)
  }

  function clearEditor() {
    const form = editor?.form
    editor = undefined
    form?.remove()
  }

  function editName(edge: StoryEdge, point: Point) {
    clearEditor()
    const form = element('form', 'story-canvas-control story-canvas-popup story-label-editor')
    const field = storyInput(edge.name)
    field.classList.add('story-inline-label')
    field.setAttribute('aria-label', t('story.relationName'))
    field.enterKeyHint = 'done'
    const save = control('save', 'check')
    save.type = 'submit'
    form.append(field, save)
    editor = { edge, form }
    surface.append(form)
    tools.hidden = true
    near(form, point, true, 8)
    const finish = (save: boolean, focus: boolean) => {
      if (editor?.form !== form) return
      clearEditor()
      if (selectedEdge?.id === edge.id) tools.hidden = false
      if (focus) surface.focus({ preventScroll: true })
      const value = field.value.trim()
      if (save && value !== edge.name) options.change(edge.id, { name: value })
    }
    form.onsubmit = (event) => { event.preventDefault(); finish(true, true) }
    form.addEventListener('focusout', (event) => {
      if (!(event.relatedTarget instanceof Node) || !form.contains(event.relatedTarget)) finish(true, false)
    })
    field.onkeydown = (event) => {
      if (event.isComposing || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      finish(false, true)
    }
    // Retain the field and its keyboard in Safari when the save button is tapped.
    save.onpointerdown = (event) => event.preventDefault()
    field.focus({ preventScroll: true })
    field.select()
  }

  return {
    openMenu, hideMenu, editName, clearEditor,
    editing: () => editor?.edge.id,
    render(card?: { id: string; rect: Rect }, relation?: { edge: StoryEdge; point: Point }, namePoint?: Point) {
      selectedCard = card?.id
      selectedEdge = relation?.edge
      if (menu && selectedCard !== menu.id) hideMenu()
      more.hidden = !card
      tools.hidden = !relation || Boolean(editor)
      if (card) place(more, card.rect.x + card.rect.width - more.offsetWidth, card.rect.y - more.offsetHeight - 4)
      if (relation) {
        direction.field.value = relation.edge.direction
        stroke.field.value = relation.edge.stroke
        if (!tools.hidden) near(tools, relation.point, true, 16)
      }
      if (editor && namePoint) near(editor.form, namePoint, true, 8)
    },
  }
}
