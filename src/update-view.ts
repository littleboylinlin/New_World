import { button, element } from './ui'
import { checkForUpdate, runningVersion } from './updates'
import type { UpdateResult } from './updates'

export function mountUpdateView(saveBeforeLeaving: () => Promise<boolean>) {
  const desktop = window.newWorldDesktop
  const help = document.querySelector<HTMLButtonElement>('#update-help')!
  const banner = document.querySelector<HTMLElement>('#update-banner')!
  document.querySelector('#app-version')!.textContent = runningVersion

  const title = element('h2', '', '帮助与更新')
  title.id = 'update-help-title'
  const dialog = element('dialog', 'manage-dialog update-dialog')
  dialog.id = 'update-help-dialog'
  dialog.setAttribute('aria-labelledby', title.id)
  const content = element('div', 'manage-form')
  const currentVersion = element('p', 'update-version', `当前运行版本 ${runningVersion}${desktop ? ' · Windows x64' : ''}`)
  const state = element('p', 'update-state', desktop ? '可查询 GitHub 上的 Windows 正式发行版。' : '可查询 GitHub 上的正式发行版。')
  state.setAttribute('role', 'status')
  const check = button('检查更新', 'button button-primary')
  const close = button('关闭', 'button button-quiet')
  const controls = element('div', 'update-actions')
  controls.append(check, close)

  const release = element('section', 'update-release')
  release.hidden = true
  const notes = element('p', 'update-notes')
  const releaseLink = element('a', 'button button-quiet', '查看 GitHub 发布页')
  releaseLink.target = '_blank'
  releaseLink.rel = 'noopener noreferrer'
  const update = button(desktop ? '更新并重启' : '重新加载当前网页', desktop ? 'button button-primary' : 'button button-quiet')
  const releaseActions = element('div', 'update-actions')
  releaseActions.append(releaseLink, update)
  const updateHint = element('p', 'update-hint', desktop
    ? '下载时可以继续写作。下载校验完成后会保存正文、覆盖安装并自动重启。'
    : '刷新会加载当前站点已部署的版本。本地运行时，请先更新代码并重新启动服务。')
  const updateError = element('p', 'field-error')
  updateError.setAttribute('role', 'alert')
  updateError.hidden = true
  const progress = element('progress', 'update-progress')
  progress.setAttribute('aria-label', '安装包下载进度')
  progress.hidden = true
  release.append(element('h3', '', '更新说明'), notes, releaseActions, updateHint, progress, updateError)
  content.append(title, currentVersion, controls, state, release)
  dialog.append(content)
  document.body.append(dialog)

  const bannerMessage = element('p', 'update-banner-message')
  bannerMessage.setAttribute('role', 'status')
  const bannerActions = element('div', 'update-actions')
  const details = button('查看更新', 'button button-primary button-small')
  const ignore = button('本次忽略', 'button button-quiet button-small')
  bannerActions.append(details, ignore)
  banner.append(bannerMessage, bannerActions)

  let started = false
  let checking = false
  let updating = false
  let applying = false
  let offeredTag: string | undefined
  let installerTag: string | undefined
  let ignoredTag: string | undefined

  function openHelp() {
    if (!dialog.open) dialog.showModal()
  }

  function present(result: UpdateResult) {
    state.classList.toggle('update-state-error', result.kind === 'failed')
    release.hidden = result.kind !== 'available'
    updateError.hidden = true
    offeredTag = result.kind === 'available' ? result.tag : undefined
    installerTag = result.kind === 'available' && result.windows ? result.tag : undefined
    banner.hidden = !offeredTag || offeredTag === ignoredTag
    switch (result.kind) {
      case 'available':
        state.textContent = `发现新版本 ${result.tag}`
        bannerMessage.textContent = state.textContent
        notes.textContent = result.notes || '此发行版未填写更新说明。'
        releaseLink.href = result.url
        break
      case 'current': state.textContent = '当前已是最新版本。'; break
      case 'ahead': state.textContent = `当前版本高于 GitHub 最新${desktop ? ' Windows ' : ''}正式发行版 ${result.tag}。`; break
      case 'unpublished': state.textContent = desktop ? 'GitHub 暂未提供可校验的 Windows x64 正式安装包。' : 'GitHub 暂未提供可比较的正式发行版。'; break
      case 'failed': state.textContent = result.message; break
    }
  }

  async function runCheck() {
    if (checking || updating) return
    started = true
    checking = check.disabled = true
    release.hidden = true
    state.classList.remove('update-state-error')
    state.textContent = '正在检查更新…'
    try {
      present(await checkForUpdate())
    } finally {
      checking = check.disabled = false
    }
  }

  help.addEventListener('click', openHelp)
  details.addEventListener('click', openHelp)
  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('cancel', (event) => { if (applying) event.preventDefault() })
  check.addEventListener('click', () => { void runCheck() })
  ignore.addEventListener('click', () => {
    ignoredTag = offeredTag
    banner.hidden = true
    help.focus()
  })
  function updateStatus(message: string) {
    state.textContent = bannerMessage.textContent = message
  }

  desktop?.onUpdateProgress(({ tag, received, total }) => {
    if (!updating || applying || tag !== installerTag) return
    progress.max = total
    progress.value = received
    updateStatus(`正在下载 ${tag} · ${Math.floor(100 * received / total)}%`)
  })

  update.addEventListener('click', async () => {
    const tag = installerTag
    if (updating || checking || (desktop && !tag)) return
    updating = check.disabled = update.disabled = ignore.disabled = true
    updateError.hidden = true
    let restarting = false
    try {
      if (!await saveBeforeLeaving()) {
        throw new Error(desktop ? '当前正文尚未保存。请先保存或另存，再更新。' : '当前正文尚未保存。请先保存或另存，再重新加载网页。')
      }
      if (!desktop) {
        window.location.reload()
        return
      }
      banner.hidden = false
      progress.hidden = false
      progress.removeAttribute('value')
      updateStatus(`正在准备下载 ${tag}…`)
      const downloaded = await desktop.downloadUpdate(tag!)
      if (!downloaded.ok) throw new Error(downloaded.message)

      applying = close.disabled = true
      openHelp()
      progress.hidden = true
      updateStatus('安装包校验通过，正在保存正文并安装…')
      if (!await saveBeforeLeaving()) throw new Error('当前正文尚未保存。安装包已下载，保存或另存正文后可以继续更新。')
      const installed = await desktop.installUpdate(tag!)
      if (!installed.ok) throw new Error(installed.message)
      restarting = true
      updateStatus('正在更新并重启 New World…')
    } catch (error) {
      updateError.textContent = error instanceof Error ? error.message : '更新失败，请稍后重试。'
      updateError.hidden = false
      if (desktop && tag) updateStatus(`发现新版本 ${tag}`)
    } finally {
      if (!restarting) {
        applying = updating = check.disabled = update.disabled = close.disabled = ignore.disabled = false
        progress.hidden = true
        banner.hidden = !offeredTag || offeredTag === ignoredTag
      }
    }
  })

  window.setTimeout(() => { if (!started) void runCheck() }, 0)
}
