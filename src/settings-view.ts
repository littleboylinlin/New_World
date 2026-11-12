import { button, element } from './ui'

const choices: { value: CloseBehavior; label: string }[] = [
  { value: 'quit', label: '完全退出' },
  { value: 'background', label: '留后台' },
]

export function mountSettingsView() {
  const desktop = window.newWorldDesktop
  const entry = document.querySelector<HTMLButtonElement>('#settings')!

  const title = element('h2', '', '设置')
  title.id = 'settings-dialog-title'
  const dialog = element('dialog', 'manage-dialog settings-dialog')
  dialog.id = 'settings-dialog'
  dialog.setAttribute('aria-labelledby', title.id)
  const content = element('div', 'manage-form')

  const heading = element('p', 'settings-heading', '关闭窗口时')
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
  content.append(title, heading, options, badge, state, error, controls)
  dialog.append(content)
  document.body.append(dialog)

  let behavior: CloseBehavior = 'quit'
  let busy = false

  function paint() {
    if (!desktop) {
      options.hidden = true
      badge.hidden = false
      state.textContent = '关闭窗口由当前浏览器管理'
      return
    }
    options.hidden = false
    badge.hidden = true
    for (const input of inputs) input.checked = input.value === behavior
  }

  async function refresh() {
    if (!desktop) return paint()
    try {
      behavior = await desktop.getCloseBehavior()
    } catch {
      behavior = 'quit'
    }
    paint()
  }

  async function save(mode: CloseBehavior) {
    if (!desktop || busy) return
    busy = true
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
      busy = false
    }
  }

  for (const input of inputs) {
    input.addEventListener('change', () => { void save(input.value as CloseBehavior) })
  }
  entry.addEventListener('click', () => {
    error.hidden = true
    state.textContent = ''
    void refresh()
    dialog.showModal()
  })
  close.addEventListener('click', () => dialog.close())
  paint()
}
