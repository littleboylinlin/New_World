import { t } from './i18n'
import { icon } from './ui'
import type { IconName } from './ui'

// Windows draws its caption buttons in the header instead of the native overlay, so they carry no system hover tooltip.
export function mountWindowControls() {
  const desktop = window.newWorldDesktop
  const actions = document.querySelector<HTMLElement>('.header-actions')
  if (!desktop || desktop.platform === 'darwin' || !actions) return
  const controls = document.createElement('div')
  controls.className = 'window-controls'
  controls.setAttribute('role', 'group')
  controls.setAttribute('aria-label', t('window.controls'))

  const addButton = (label: string, symbol: IconName, onClick: () => void, className = 'window-button') => {
    const control = document.createElement('button')
    control.type = 'button'
    control.className = className
    control.setAttribute('aria-label', label)
    control.append(icon(symbol))
    control.addEventListener('click', onClick)
    controls.append(control)
    return control
  }

  addButton(t('window.minimize'), 'minimize', () => desktop.minimizeWindow())
  const maximize = addButton(t('window.maximize'), 'maximize', () => desktop.toggleMaximizeWindow())
  addButton(t('window.close'), 'close', () => desktop.closeWindow(), 'window-button window-close')

  const showMaximized = (maximized: boolean) => {
    maximize.replaceChildren(icon(maximized ? 'restore' : 'maximize'))
    maximize.setAttribute('aria-label', t(maximized ? 'window.restore' : 'window.maximize'))
  }
  void desktop.isMaximized().then(showMaximized)
  desktop.onMaximizeChange(showMaximized)
  actions.append(controls)
}