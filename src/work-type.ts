import { t } from './i18n'
import type { LibraryId } from './library'
import { button, element } from './ui'

export const workType = (library: LibraryId) => t('writing.type.' + library)

export function chooseWorkType(title: string, signal: AbortSignal): Promise<LibraryId | null> {
  if (signal.aborted) return Promise.resolve(null)
  const dialog = element('dialog', 'manage-dialog')
  const body = element('div', 'manage-form')
  const heading = element('h2', '', title)
  const types = element('div', 'type-options')
  dialog.setAttribute('aria-label', title)
  for (const library of ['original', 'reference'] as const) {
    const option = button(workType(library), 'button button-primary mode-' + library, 'book')
    option.onclick = () => dialog.close(library)
    types.append(option)
  }
  const cancel = button(t('common.cancel'), 'button button-quiet')
  cancel.onclick = () => dialog.close()
  body.append(heading, types, cancel)
  dialog.append(body)
  document.body.append(dialog)
  return new Promise((resolve) => {
    const close = () => dialog.close()
    signal.addEventListener('abort', close, { once: true })
    dialog.addEventListener('close', () => {
      signal.removeEventListener('abort', close)
      dialog.remove()
      const value = dialog.returnValue
      resolve(!signal.aborted && (value === 'original' || value === 'reference') ? value : null)
    }, { once: true })
    dialog.showModal()
  })
}
