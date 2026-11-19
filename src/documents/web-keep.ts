import { t } from '../i18n'
import { formDialog } from '../dialogs'
import { addIdea } from '../ideas'
import type { LibraryId } from '../library'
import { element } from '../ui'
import { showNotice } from '../undo'
import { readKeepLink, saveKeepLink } from '../web-search'

export interface WebPassage { text: string; title: string; url: string }

/** The kept text with where it came from: the page's title always, its address only when asked. */
export function passageText(entry: WebPassage, withLink: boolean) {
  const source = [entry.title ? t('web.from', [entry.title]) : '', withLink ? entry.url : ''].filter(Boolean).join('\n')
  return source ? `${entry.text}\n\n${source}` : entry.text
}

/**
 * Asks before keeping text selected in a web page as an idea or a task of the work being written.
 * "Include the link" starts unticked; whatever the writer picks is used next time.
 */
export function keepFromWeb(kind: 'idea' | 'task', entry: WebPassage, work: { library: LibraryId; bookId: string; title: string }) {
  const preview = element('blockquote', 'web-keep-preview', entry.text.length > 600 ? `${entry.text.slice(0, 600)}…` : entry.text)
  const source = element('p', 'dialog-help web-keep-source', entry.title ? t('web.from', [entry.title]) : t('web.untitled'))
  const label = element('label', 'appearance-check web-keep-link')
  const withLink = element('input')
  withLink.type = 'checkbox'
  withLink.name = 'with-link'
  withLink.checked = readKeepLink()
  withLink.disabled = !entry.url
  label.append(withLink, t('web.withLink'))
  let readable = entry.url
  try { readable = decodeURI(entry.url) } catch { /* Shown as it is. */ }
  const address = element('p', 'dialog-help web-keep-url', readable)
  formDialog(document.body, {
    title: kind === 'idea' ? t('web.toIdea') : t('web.toTask'),
    action: kind === 'idea' ? t('web.keepIdea') : t('web.keepTask'),
    fields: [preview, source, label, address],
  }, async () => {
    const linked = withLink.checked && Boolean(entry.url)
    if (entry.url) saveKeepLink(withLink.checked)
    if (kind === 'idea') {
      await addIdea(passageText(entry, linked), { library: work.library, bookId: work.bookId })
      showNotice(t('web.keptIdea'))
      return
    }
    const { addTask } = await import('../tasks/store')
    const firstLine = entry.text.split(/\n+/).map((line) => line.trim()).find(Boolean) ?? entry.text
    const title = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
    await addTask(title, {
      description: passageText(entry, linked).slice(0, 20000),
      link: { library: work.library, bookId: work.bookId, title: work.title.slice(0, 500) },
    })
    showNotice(t('web.keptTask'))
  })
}

const webAddress = /https?:\/\/[^\s<>"'，。；、）」』】]+/g

/**
 * Text with its web addresses as links. On the desktop a link opens in a web pane (`open`); in a
 * browser it opens in a new tab.
 */
export function linkedText(text: string, open?: (url: string) => void) {
  const fragment = document.createDocumentFragment()
  let last = 0
  for (const match of text.matchAll(webAddress)) {
    const url = match[0].replace(/[.,;:!?)\]]+$/, '')
    fragment.append(text.slice(last, match.index))
    const link = element('a', 'idea-link', url)
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    if (open) link.addEventListener('click', (event) => { event.preventDefault(); open(url) })
    fragment.append(link)
    last = match.index + url.length
  }
  fragment.append(text.slice(last))
  return fragment
}
