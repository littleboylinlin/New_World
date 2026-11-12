import { button, element } from './ui'

export function mountStorageView(
  content: HTMLElement,
  saveBeforeLeaving: () => Promise<boolean>,
  setBusy: (busy: boolean, allowClose?: boolean) => void,
) {
  const desktop = window.newWorldDesktop
  const summary = document.querySelector<HTMLElement>('#storage-location')!

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
  const controls = element('div', 'settings-actions')
  controls.append(change, reset)
  content.append(box, controls, state, error)

  let current: StorageState | null = null
  let busy = false
  let refreshing = false

  function paint() {
    if (!desktop) {
      summary.textContent = '小说与原件保存在当前浏览器'
      badge.textContent = '浏览器托管'
      path.textContent = '当前浏览器'
      change.hidden = reset.hidden = true
      state.textContent = '书库位置由当前浏览器管理'
      return
    }
    change.hidden = reset.hidden = false
    change.disabled = busy || refreshing || !current
    reset.disabled = busy || refreshing || !current?.custom
    if (!current) {
      summary.textContent = '小说与原件保存在本机书库'
      badge.textContent = '本机书库'
      path.textContent = refreshing ? '正在读取存储位置…' : '存储位置暂不可用'
      return
    }
    badge.textContent = current.custom ? '自定义位置' : '默认位置'
    path.textContent = current.path
    summary.textContent = current.custom
      ? `小说与原件保存在 ${current.path}`
      : '小说与原件保存在本机书库'
  }

  async function refresh() {
    if (!desktop) return paint()
    if (busy || refreshing) return
    refreshing = true
    error.hidden = true
    state.textContent = ''
    paint()
    try {
      current = await desktop.getStorageLocation()
      paint()
    } catch {
      error.textContent = '无法读取存储位置，请重新打开设置后重试。'
      error.hidden = false
    } finally {
      refreshing = false
      paint()
    }
  }

  async function apply(action: () => Promise<StorageResult | null>, done: string) {
    if (!desktop || busy || !current) return
    busy = true
    setBusy(true)
    paint()
    error.hidden = true
    state.textContent = ''
    let restarting = false
    try {
      if (!await saveBeforeLeaving()) {
        throw new Error('当前正文尚未保存，请先保存再更改存储位置。')
      }
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
        busy = false
        setBusy(false)
      }
      paint()
    }
  }

  change.addEventListener('click', () => { void apply(() => desktop!.setStorageLocation(), '已更新存储位置') })
  reset.addEventListener('click', () => { void apply(() => desktop!.resetStorageLocation(), '已恢复默认位置') })
  paint()
  void refresh()
  return refresh
}
