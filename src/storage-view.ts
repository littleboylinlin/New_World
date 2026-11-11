import { button, element } from './ui'

export function mountStorageView(saveBeforeLeaving: () => Promise<boolean>) {
  const desktop = window.newWorldDesktop
  const entry = document.querySelector<HTMLButtonElement>('#storage-location')!

  const title = element('h2', '', '存储位置')
  title.id = 'storage-dialog-title'
  const dialog = element('dialog', 'manage-dialog storage-dialog')
  dialog.id = 'storage-dialog'
  dialog.setAttribute('aria-labelledby', title.id)
  const content = element('div', 'manage-form')

  const box = element('div', 'storage-location-box')
  const badge = element('span', 'storage-badge')
  const path = element('p', 'storage-path')
  box.append(badge, path)

  const state = element('p', 'storage-state')
  state.setAttribute('role', 'status')
  const error = element('p', 'field-error')
  error.setAttribute('role', 'alert')
  error.hidden = true

  const change = button('更改位置', 'button button-primary')
  const reset = button('恢复默认', 'button button-quiet')
  const close = button('关闭', 'button button-quiet')
  const controls = element('div', 'dialog-controls')
  controls.append(change, reset, close)
  content.append(title, box, state, error, controls)
  dialog.append(content)
  document.body.append(dialog)

  let current: StorageState | null = null

  function paint() {
    if (!desktop || !current) {
      entry.textContent = '小说与原件保存在当前浏览器'
      badge.textContent = '浏览器托管'
      path.textContent = '当前浏览器'
      change.hidden = reset.hidden = true
      state.textContent = '书库位置由当前浏览器管理'
      return
    }
    badge.textContent = current.custom ? '自定义位置' : '默认位置'
    path.textContent = current.path
    entry.textContent = current.custom
      ? `小说与原件保存在 ${current.path}`
      : '小说与原件保存在本机书库'
    change.hidden = reset.hidden = false
    reset.disabled = !current.custom
  }

  async function refresh() {
    if (!desktop) return paint()
    try {
      current = await desktop.getStorageLocation()
      paint()
    } catch {
      // Keep the last known state when the location cannot be read.
    }
  }

  async function apply(action: () => Promise<StorageResult | null>, done: string) {
    if (!desktop) return
    error.hidden = true
    if (!await saveBeforeLeaving()) {
      error.textContent = '当前正文尚未保存，请先保存再更改存储位置。'
      error.hidden = false
      return
    }
    change.disabled = reset.disabled = close.disabled = true
    let restarting = false
    try {
      const result = await action()
      if (result) {
        current = { path: result.path, defaultPath: current?.defaultPath ?? result.path, custom: result.custom }
        paint()
        restarting = result.restart
        state.textContent = result.restart ? '正在重启 New World…' : done
      }
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : '更改存储位置失败，请重试。'
      error.hidden = false
    } finally {
      if (!restarting) {
        change.disabled = reset.disabled = close.disabled = false
        if (current) reset.disabled = !current.custom
      } else {
        change.disabled = reset.disabled = close.disabled = true
      }
    }
  }

  entry.addEventListener('click', () => {
    error.hidden = true
    state.textContent = ''
    paint()
    void refresh()
    dialog.showModal()
  })
  close.addEventListener('click', () => dialog.close())
  change.addEventListener('click', () => { void apply(() => desktop!.setStorageLocation(), '已更新存储位置') })
  reset.addEventListener('click', () => { void apply(() => desktop!.resetStorageLocation(), '已恢复默认位置') })
  void refresh()
}
