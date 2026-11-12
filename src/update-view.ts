import { t } from './i18n'
import { button, element } from './ui'
import { checkForUpdate, runningVersion } from './updates'
import type { UpdateResult } from './updates'

export function mountUpdateView(
  content: HTMLElement,
  saveBeforeLeaving: () => Promise<boolean>,
  openHelp: () => void,
  setBusy: (busy: boolean, allowClose?: boolean) => void,
) {
  const desktop = window.newWorldDesktop
  const settings = document.querySelector<HTMLButtonElement>('#settings')!
  const banner = document.querySelector<HTMLElement>('#update-banner')!
  document.querySelector('#app-version')!.textContent = runningVersion

  const currentVersion = element('p', 'update-version', t('update.runningVersion', [runningVersion, desktop ? ' · Windows x64' : '']))
  const state = element('p', 'update-state', desktop ? t('update.checksWindowsStableReleasesOnGithub') : t('update.checksStableReleasesOnGithub'))
  state.setAttribute('role', 'status')
  const check = button(t('update.checkForUpdates'), 'button button-primary')
  const controls = element('div', 'update-actions')
  controls.append(check)

  const release = element('section', 'update-release')
  release.hidden = true
  const notes = element('p', 'update-notes')
  const releaseLink = element('a', 'button button-quiet', t('update.viewGithubRelease'))
  releaseLink.target = '_blank'
  releaseLink.rel = 'noopener noreferrer'
  const update = button(desktop ? t('update.updateAndRestart') : t('update.reloadThisPage'), desktop ? 'button button-primary' : 'button button-quiet')
  const releaseActions = element('div', 'update-actions')
  releaseActions.append(releaseLink, update)
  const updateHint = element('p', 'update-hint', desktop
    ? t('update.youCanKeepWritingDuringTheDownloadAfter')
    : t('update.reloadingLoadsTheVersionCurrentlyDeployedToThis'))
  const updateError = element('p', 'field-error')
  updateError.setAttribute('role', 'alert')
  updateError.hidden = true
  const progress = element('progress', 'update-progress')
  progress.setAttribute('aria-label', t('update.installerDownloadProgress'))
  progress.hidden = true
  release.append(element('h4', '', t('update.releaseNotes')), notes, releaseActions, updateHint, progress, updateError)
  content.append(currentVersion, controls, state, release)

  const bannerMessage = element('p', 'update-banner-message')
  bannerMessage.setAttribute('role', 'status')
  const bannerActions = element('div', 'update-actions')
  const details = button(t('update.viewUpdate'), 'button button-primary button-small')
  const ignore = button(t('update.ignoreForNow'), 'button button-quiet button-small')
  bannerActions.append(details, ignore)
  banner.append(bannerMessage, bannerActions)

  let started = false
  let checking = false
  let updating = false
  let applying = false
  let offeredTag: string | undefined
  let installerTag: string | undefined
  let ignoredTag: string | undefined

  function present(result: UpdateResult) {
    state.classList.toggle('update-state-error', result.kind === 'failed')
    release.hidden = result.kind !== 'available'
    updateError.hidden = true
    offeredTag = result.kind === 'available' ? result.tag : undefined
    installerTag = result.kind === 'available' && result.windows ? result.tag : undefined
    banner.hidden = !offeredTag || offeredTag === ignoredTag
    switch (result.kind) {
      case 'available':
        state.textContent = t('update.newVersionAvailable', [result.tag])
        bannerMessage.textContent = state.textContent
        notes.textContent = result.notes || t('update.thisReleaseHasNoReleaseNotes')
        releaseLink.href = result.url
        break
      case 'current': state.textContent = t('update.youAreUsingTheLatestVersion'); break
      case 'ahead': state.textContent = t('update.theRunningVersionIsNewerThanTheLatest', [desktop ? ' Windows ' : '', result.tag]); break
      case 'unpublished': state.textContent = desktop ? t('update.noVerifiableWindowsX64StableInstallerIsAvailable') : t('update.noComparableStableReleaseIsAvailableOnGithub'); break
      case 'failed': state.textContent = result.message; break
    }
  }

  async function runCheck() {
    if (checking || updating) return
    started = true
    checking = check.disabled = true
    release.hidden = true
    state.classList.remove('update-state-error')
    state.textContent = t('update.checkingForUpdates')
    try {
      present(await checkForUpdate())
    } finally {
      checking = check.disabled = false
    }
  }

  details.addEventListener('click', openHelp)
  check.addEventListener('click', () => { void runCheck() })
  ignore.addEventListener('click', () => {
    ignoredTag = offeredTag
    banner.hidden = true
    settings.focus()
  })
  function updateStatus(message: string) {
    state.textContent = bannerMessage.textContent = message
  }

  desktop?.onUpdateProgress(({ tag, received, total }) => {
    if (!updating || applying || tag !== installerTag) return
    progress.max = total
    progress.value = received
    updateStatus(t('update.downloading', [tag, Math.floor(100 * received / total)]))
  })

  update.addEventListener('click', async () => {
    const tag = installerTag
    if (updating || checking || (desktop && !tag)) return
    updating = check.disabled = update.disabled = ignore.disabled = true
    setBusy(true, true)
    updateError.hidden = true
    let restarting = false
    try {
      if (!await saveBeforeLeaving()) {
        throw new Error(desktop ? t('update.theCurrentTextIsNotSavedSaveIt') : t('update.theCurrentTextIsNotSavedSaveIt396'))
      }
      if (!desktop) {
        window.location.reload()
        return
      }
      banner.hidden = false
      progress.hidden = false
      progress.removeAttribute('value')
      updateStatus(t('update.preparingToDownload', [tag]))
      const downloaded = await desktop.downloadUpdate(tag!)
      if (!downloaded.ok) throw new Error(downloaded.message)

      applying = true
      setBusy(true)
      openHelp()
      progress.hidden = true
      updateStatus(t('update.installerVerifiedSavingTextAndInstalling'))
      if (!await saveBeforeLeaving()) throw new Error(t('update.theCurrentTextIsNotSavedTheInstaller'))
      const installed = await desktop.installUpdate(tag!)
      if (!installed.ok) throw new Error(installed.message)
      restarting = true
      updateStatus(t('update.updatingAndRestartingNewWorld'))
    } catch (error) {
      updateError.textContent = error instanceof Error ? error.message : t('update.theUpdateFailedTryAgainLater')
      updateError.hidden = false
      if (desktop && tag) updateStatus(t('update.newVersionAvailable', [tag]))
    } finally {
      if (!restarting) {
        applying = updating = check.disabled = update.disabled = ignore.disabled = false
        setBusy(false)
        progress.hidden = true
        banner.hidden = !offeredTag || offeredTag === ignoredTag
      }
    }
  })

  window.setTimeout(() => { if (!started) void runCheck() }, 0)
}
