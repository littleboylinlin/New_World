import { t } from './i18n'
import { button, element } from './ui'

export interface TipAction { label: string; primary?: boolean; run: () => void | Promise<void> }

/** Notes docked above the footer without taking focus. */
export function cornerTip(kind: string, message: string, actions: TipAction[], onClose: () => void) {
  const stack = document.querySelector<HTMLDivElement>('.corner-tips')!
  stack.querySelector(`[data-tip="${kind}"]`)?.remove()
  const tip = element('section', 'corner-tip')
  tip.dataset.tip = kind
  tip.setAttribute('role', 'status')
  tip.setAttribute('aria-label', message)
  const text = element('p', 'corner-tip-text', message)
  const error = element('p', 'corner-tip-error')
  error.hidden = true
  const row = element('div', 'corner-tip-actions')
  for (const action of actions) {
    const control = button(action.label, action.primary ? 'button button-primary button-small' : 'button button-quiet button-small')
    control.addEventListener('click', async () => {
      for (const item of row.querySelectorAll('button')) item.disabled = true
      error.hidden = true
      try {
        await action.run()
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : String(cause)
        error.hidden = false
      } finally {
        for (const item of row.querySelectorAll('button')) item.disabled = false
      }
    })
    row.append(control)
  }
  const close = button('', 'corner-tip-close', 'close')
  close.setAttribute('aria-label', t('cornerTip.close'))
  close.addEventListener('click', () => { tip.remove(); onClose() })
  tip.append(close, text, row, error)
  stack.append(tip)
  return { remove: () => tip.remove(), say: (value: string) => { text.textContent = value } }
}
