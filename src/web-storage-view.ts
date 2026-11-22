import { t } from './i18n'
import { button, element, link } from './ui'
import { chooseFolder, folderChanges, folderState, folderSupported, forgetFolder, reconnectFolder } from './web-folder'
import { desktopDownloadUrl, persistenceState, requestPersistence } from './web-storage'

function when(time: number) {
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time)
}

/** Web-only part of Settings → Storage: browser persistence and saving works into a local folder. */
export function mountWebStorageSettings(content: HTMLElement) {
  const warning = element('p', 'web-storage-warning', t('webStorage.notice'))
  warning.append(' ', link(desktopDownloadUrl, t('webStorage.getDesktop')))
  warning.querySelector('a')!.target = '_blank'

  const persistence = element('div', 'web-storage-row')
  const persistenceLabel = element('p', 'web-storage-label', t('webStorage.persistence'))
  const persistenceValue = element('p', 'web-storage-value')
  persistenceValue.setAttribute('role', 'status')
  const persist = button(t('webStorage.requestPersistence'), 'button button-quiet button-small')
  persist.hidden = true
  persistence.append(persistenceLabel, persistenceValue, persist)

  const folder = element('div', 'web-storage-row web-storage-folder')
  const folderLabel = element('p', 'web-storage-label', t('webFolder.title'))
  const folderValue = element('p', 'web-storage-value')
  folderValue.setAttribute('role', 'status')
  const folderHelp = element('p', 'dialog-help', folderSupported() ? '' : t('webFolder.unsupported'))
  const choose = button(t('webFolder.choose'), 'button button-primary button-small')
  const reconnect = button(t('webFolder.reconnect'), 'button button-primary button-small')
  const stop = button(t('webFolder.stop'), 'button button-quiet button-small')
  const actions = element('div', 'settings-actions')
  actions.append(choose, reconnect, stop)
  const error = element('p', 'field-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  folder.append(folderLabel, folderValue, folderHelp, actions, error)
  content.append(warning, persistence, folder)

  async function paintPersistence() {
    const granted = await persistenceState()
    persistenceValue.textContent = granted === null ? t('webStorage.persistenceUnsupported') : granted ? t('webStorage.persisted') : t('webStorage.notPersisted')
    persistenceValue.dataset.state = granted ? 'on' : 'off'
    persist.hidden = granted !== false
  }

  function paintFolder() {
    const supported = folderSupported()
    const current = folderState()
    choose.hidden = !supported
    reconnect.hidden = !current.name || current.permission === 'granted'
    stop.hidden = !current.name
    choose.textContent = current.name ? t('webFolder.change') : t('webFolder.choose')
    if (!supported) folderValue.textContent = t('webFolder.browserOnly')
    else if (!current.name) folderValue.textContent = t('webFolder.none')
    else if (current.permission !== 'granted') folderValue.textContent = t('webFolder.needsPermission', [current.name])
    else folderValue.textContent = current.lastWrite ? t('webFolder.savedAt', [current.name, when(current.lastWrite)]) : t('webFolder.saving', [current.name])
    if (current.error) { error.textContent = t('webFolder.failed', [current.error]); error.hidden = false }
  }

  async function run(action: () => Promise<number | void>) {
    error.hidden = true
    for (const control of [choose, reconnect, stop]) control.disabled = true
    try {
      const restored = await action()
      if (restored) folderValue.textContent = t('webFolder.restored', [restored])
      else paintFolder()
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      error.textContent = cause instanceof DOMException && cause.name === 'NotAllowedError' ? t('webFolder.denied') : t('webFolder.failed', [cause instanceof Error ? cause.message : String(cause)])
      error.hidden = false
    } finally {
      for (const control of [choose, reconnect, stop]) control.disabled = false
    }
  }

  persist.addEventListener('click', () => void requestPersistence().then(paintPersistence))
  choose.addEventListener('click', () => void run(chooseFolder))
  reconnect.addEventListener('click', () => void run(reconnectFolder))
  stop.addEventListener('click', () => void run(forgetFolder))
  folderChanges.addEventListener('change', paintFolder)
  void paintPersistence()
  paintFolder()
}
