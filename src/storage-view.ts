import { t } from './i18n'
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

  const change = button(t('storage.changeLocation'), 'button button-primary')
  const reset = button(t('storage.restoreDefault'), 'button button-quiet')
  const controls = element('div', 'settings-actions')
  controls.append(change, reset)
  content.append(box, controls, state, error)

  let current: StorageState | null = null
  let busy = false
  let refreshing = false

  function paint() {
    if (!desktop) {
      summary.textContent = t('storage.novelsAndOriginalsAreStoredInThisBrowser')
      badge.textContent = t('settings.browserManaged')
      path.textContent = t('storage.thisBrowser')
      change.hidden = reset.hidden = true
      state.textContent = t('storage.theLibraryLocationIsManagedByYourBrowser')
      return
    }
    change.hidden = reset.hidden = false
    change.disabled = busy || refreshing || !current
    reset.disabled = busy || refreshing || !current?.custom
    if (!current) {
      summary.textContent = t('storage.novelsAndOriginalsAreStoredInTheLocal')
      badge.textContent = t('storage.localLibrary')
      path.textContent = refreshing ? t('storage.readingStorageLocation') : t('storage.storageLocationUnavailable')
      return
    }
    badge.textContent = current.custom ? t('storage.customLocation') : t('storage.defaultLocation')
    path.textContent = current.path
    summary.textContent = current.custom
      ? t('storage.novelsAndOriginalsAreStoredIn', [current.path])
      : t('storage.novelsAndOriginalsAreStoredInTheLocal')
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
      error.textContent = t('storage.theStorageLocationCouldNotBeReadReopen')
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
        throw new Error(t('storage.theCurrentTextIsNotSavedSaveIt'))
      }
      const result = await action()
      if (result) {
        current = { path: result.path, defaultPath: current?.defaultPath ?? result.path, custom: result.custom }
        paint()
        restarting = result.restart
        state.textContent = result.restart ? t('storage.restartingNewWorld') : done
      }
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : t('storage.theStorageLocationCouldNotBeChangedTry')
      error.hidden = false
    } finally {
      if (!restarting) {
        busy = false
        setBusy(false)
      }
      paint()
    }
  }

  change.addEventListener('click', () => { void apply(() => desktop!.setStorageLocation(), t('storage.storageLocationUpdated')) })
  reset.addEventListener('click', () => { void apply(() => desktop!.resetStorageLocation(), t('storage.defaultLocationRestored')) })
  paint()
  void refresh()
  return refresh
}
