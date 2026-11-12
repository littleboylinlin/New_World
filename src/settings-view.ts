import { button, element } from './ui'
import { mountStorageView } from './storage-view'
import { mountUpdateView } from './update-view'

const choices: { value: CloseBehavior; label: string }[] = [
  { value: 'quit', label: '完全退出' },
  { value: 'background', label: '留后台' },
]

export function mountSettingsView(saveBeforeLeaving: () => Promise<boolean>) {
  const desktop = window.newWorldDesktop
  const entry = document.querySelector<HTMLButtonElement>('#settings')!

  const title = element('h2', '', '设置')
  title.id = 'settings-dialog-title'
  const dialog = element('dialog', 'manage-dialog settings-dialog')
  dialog.id = 'settings-dialog'
  dialog.setAttribute('aria-labelledby', title.id)
  const content = element('div', 'manage-form')

  const fields = element('fieldset', 'settings-fields')
  const scroll = element('div', 'settings-scroll')
  const list = element('ul', 'settings-list')
  list.setAttribute('aria-label', '主要设置')
  function section(name: string, id: string) {
    const item = element('li')
    const panel = element('section', 'settings-section')
    const heading = element('h3', 'settings-heading', name)
    heading.id = id
    heading.tabIndex = -1
    panel.setAttribute('aria-labelledby', id)
    panel.append(heading)
    item.append(panel)
    list.append(item)
    return panel
  }
  const windowSection = section('关闭窗口时', 'window-settings-title')
  const storageSection = section('存储位置', 'storage-settings-title')
  const updateSection = section('帮助与更新', 'update-settings-title')
  const options = element('div', 'settings-options')
  options.setAttribute('role', 'radiogroup')
  options.setAttribute('aria-label', '关闭窗口时')
  const inputs: HTMLInputElement[] = []
  for (const choice of choices) {
    const item = element('label', 'settings-option')
    const input = element('input')
    input.type = 'radio'
    input.name = 'close-behavior'
    input.value = choice.value
    item.append(input, element('span', '', choice.label))
    options.append(item)
    inputs.push(input)
  }

  const badge = element('span', 'settings-badge', '浏览器托管')
  const state = element('p', 'settings-state')
  state.setAttribute('role', 'status')
  const error = element('p', 'field-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  const close = button('关闭', 'button button-quiet')
  const controls = element('div', 'dialog-controls')
  controls.append(close)
  windowSection.append(options, badge, state, error)
  fields.append(list)
  scroll.append(fields)
  content.append(title, scroll, controls)
  dialog.append(content)
  document.body.append(dialog)

  let behavior: CloseBehavior = 'quit'
  let busy = false
  let locked = false
  let loaded = false

  function setBusy(value: boolean, allowClose = false) {
    busy = fields.disabled = value
    locked = close.disabled = value && !allowClose
  }

  function open(section?: HTMLElement) {
    if (!busy) {
      state.textContent = ''
      void refresh()
      void refreshStorage()
    }
    if (!dialog.open) dialog.showModal()
    if (section) {
      section.scrollIntoView({ block: 'start' })
      section.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true })
    } else {
      scroll.scrollTop = 0
    }
  }

  const refreshStorage = mountStorageView(storageSection, saveBeforeLeaving, setBusy)
  mountUpdateView(updateSection, saveBeforeLeaving, () => open(updateSection), setBusy)

  function paint() {
    if (!desktop) {
      options.hidden = true
      badge.hidden = false
      state.textContent = '关闭窗口由当前浏览器管理'
      return
    }
    options.hidden = false
    badge.hidden = true
    for (const input of inputs) {
      input.checked = loaded && input.value === behavior
      input.disabled = !loaded
    }
  }

  async function refresh() {
    if (!desktop) return paint()
    loaded = false
    error.hidden = true
    paint()
    try {
      behavior = await desktop.getCloseBehavior()
      loaded = true
    } catch {
      error.textContent = '无法读取关闭方式，请重新打开设置后重试。'
      error.hidden = false
    }
    paint()
  }

  async function save(mode: CloseBehavior) {
    if (!desktop || busy || !loaded) return
    setBusy(true)
    error.hidden = true
    state.textContent = ''
    try {
      behavior = await desktop.setCloseBehavior(mode)
      state.textContent = '已保存'
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : '设置未能保存，请重试。'
      error.hidden = false
    } finally {
      paint()
      setBusy(false)
    }
  }

  for (const input of inputs) {
    input.addEventListener('change', () => { void save(input.value as CloseBehavior) })
  }
  entry.addEventListener('click', () => open())
  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('cancel', (event) => { if (locked) event.preventDefault() })
  paint()
}
