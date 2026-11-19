import { t } from '../i18n'
import { draggableEntry } from '../shell/drag-open'
import { menuButton } from '../shell/popover'
import type { ShellMenuItem } from '../shell/popover'
import { button, element } from '../ui'
import { showNotice } from '../undo'
import { addressFor } from '../web-search'
import type { OpenPlacement, PaneSource } from './compare'

/**
 * The side panel's 网页 tab (desktop only): an address field that opens a private web page beside
 * the text, and a 新网页 entry that can be dragged into the text area like any other entry.
 * There is no history and there are no bookmarks: nothing typed here is kept.
 */
export function webTab(open: (url?: string, where?: OpenPlacement) => void, openItems: (source: () => PaneSource | undefined) => ShellMenuItem[], signal: AbortSignal) {
  const panel = element('section', 'web-panel')
  panel.setAttribute('aria-label', t('web.tab'))
  const form = element('form')
  const field = element('input', 'title-input web-panel-address')
  field.type = 'text'
  field.autocomplete = 'off'
  field.spellcheck = false
  field.placeholder = t('web.addressHint')
  field.setAttribute('aria-label', t('web.address'))
  const go = button(t('web.go'), 'button button-primary button-small')
  go.type = 'submit'
  form.append(field, go)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const target = addressFor(field.value)
    if (!target) { open(); return }
    if ('blocked' in target) { showNotice(t('web.blocked')); return }
    open(target.url)
    field.value = ''
  }, { signal })

  const row = element('div', 'compare-entry web-new-entry')
  const entry = button('', 'compare-entry-open')
  entry.append(element('span', 'compare-entry-label', t('web.newPage')))
  entry.title = t('compare.entryHint')
  entry.addEventListener('click', () => open(), { signal })
  const more = button('', 'compare-entry-more', 'more')
  more.setAttribute('aria-label', t('compare.entryMenu', [t('web.newPage')]))
  more.tabIndex = -1
  more.setAttribute('aria-hidden', 'true')
  menuButton(more, t('web.newPage'), () => openItems(() => ({ kind: 'web' })).filter((item) => item.icon !== 'window'))
  row.addEventListener('contextmenu', (event) => { event.preventDefault(); more.click() }, { signal })
  draggableEntry(entry, { label: () => t('web.newPage'), payload: () => ({ source: { kind: 'web' } }), menu: () => more.click(), signal })
  row.append(entry, more)

  panel.append(form, element('p', 'dialog-help', t('web.private')), row)
  return panel
}
