import { button, element } from './ui'
import { checkForUpdate, runningVersion } from './updates'
import type { UpdateResult } from './updates'

export function mountUpdateView(reloadAfterSave: () => Promise<boolean>) {
  const help = document.querySelector<HTMLButtonElement>('#update-help')!
  const banner = document.querySelector<HTMLElement>('#update-banner')!
  document.querySelector('#app-version')!.textContent = runningVersion

  const title = element('h2', '', '帮助与更新')
  title.id = 'update-help-title'
  const dialog = element('dialog', 'manage-dialog update-dialog')
  dialog.id = 'update-help-dialog'
  dialog.setAttribute('aria-labelledby', title.id)
  const content = element('div', 'manage-form')
  const currentVersion = element('p', 'update-version', `当前运行版本 ${runningVersion}`)
  const state = element('p', 'update-state', '可查询 GitHub 上的正式发行版。')
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
  const reload = button('重新加载当前网页', 'button button-quiet')
  const releaseActions = element('div', 'update-actions')
  releaseActions.append(releaseLink, reload)
  const reloadHint = element('p', 'update-hint', '刷新会加载当前站点已部署的版本。本地运行时，请先更新代码并重新启动服务。')
  const reloadError = element('p', 'field-error')
  reloadError.setAttribute('role', 'alert')
  reloadError.hidden = true
  release.append(element('h3', '', '更新说明'), notes, releaseActions, reloadHint, reloadError)
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
  let offeredTag: string | undefined
  let ignoredTag: string | undefined

  function openHelp() {
    if (!dialog.open) dialog.showModal()
  }

  function present(result: UpdateResult) {
    state.classList.toggle('update-state-error', result.kind === 'failed')
    release.hidden = result.kind !== 'available'
    reloadError.hidden = true
    offeredTag = result.kind === 'available' ? result.tag : undefined
    banner.hidden = !offeredTag || offeredTag === ignoredTag
    switch (result.kind) {
      case 'available':
        state.textContent = `发现新版本 ${result.tag}`
        bannerMessage.textContent = state.textContent
        notes.textContent = result.notes || '此发行版未填写更新说明。'
        releaseLink.href = result.url
        break
      case 'current': state.textContent = '当前已是最新版本。'; break
      case 'ahead': state.textContent = `当前版本高于 GitHub 最新正式发行版 ${result.tag}。`; break
      case 'unpublished': state.textContent = 'GitHub 暂未提供可比较的正式发行版。'; break
      case 'failed': state.textContent = result.message; break
    }
  }

  async function runCheck() {
    if (checking) return
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
  check.addEventListener('click', () => { void runCheck() })
  ignore.addEventListener('click', () => {
    ignoredTag = offeredTag
    banner.hidden = true
    help.focus()
  })
  reload.addEventListener('click', async () => {
    reload.disabled = true
    reloadError.hidden = true
    try {
      if (await reloadAfterSave()) return
      reloadError.textContent = '当前正文尚未保存。请先保存或另存，再重新加载网页。'
    } catch {
      reloadError.textContent = '未能确认保存状态。请先检查正文，再重新加载网页。'
    }
    reloadError.hidden = false
    reload.disabled = false
  })

  window.setTimeout(() => { if (!started) void runCheck() }, 0)
}
