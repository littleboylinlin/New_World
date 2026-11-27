import { t } from '../i18n'
import { storageError } from '../library'
import { element, link, notice } from '../ui'
import { linksChapter } from './model'
import type { ChapterTarget, ForeshadowingWork } from './model'
import { foreshadowingPath } from './route'
import { listForeshadowing } from './store'
import './foreshadowing.css'

export function chapterForeshadowing(work: ForeshadowingWork, target: () => ChapterTarget & { title: string }, signal: AbortSignal) {
  const panel = element('section', 'foreshadowing-chapter-panel')
  const title = element('h2', '', t('foreshadowing.thisChapter'))
  const manage = link(foreshadowingPath(work), t('foreshadowing.manageChapter'), 'button button-quiet button-small')
  const chapterTitle = element('p', 'dialog-help')
  const contents = element('div')
  panel.append(title, chapterTitle, contents, manage)
  let request = 0

  async function refresh() {
    const current = ++request
    const chapter = target()
    const href = foreshadowingPath(work, chapter)
    if (manage.getAttribute('href') !== href) contents.replaceChildren()
    manage.href = href
    chapterTitle.textContent = chapter.title
    try {
      const all = await listForeshadowing(work)
      if (signal.aborted || current !== request) return
      const entries = all.filter((row) => linksChapter(row, chapter))
      if (!entries.length) {
        contents.replaceChildren(element('p', 'dialog-help', t('foreshadowing.noChapterEntries')))
        return
      }
      const list = element('ul', 'foreshadowing-chapter-list')
      for (const entry of entries) {
        const item = element('li')
        const head = element('div', 'foreshadowing-entry-head')
        head.append(element('strong', '', entry.title), element('span', 'file-format', t(entry.resolved ? 'foreshadowing.resolved' : 'foreshadowing.unresolved')))
        item.append(head)
        if (entry.description) item.append(element('p', 'foreshadowing-copy', entry.description))
        list.append(item)
      }
      contents.replaceChildren(list)
    } catch (error) {
      if (!signal.aborted && current === request) contents.replaceChildren(notice(storageError(error), true))
    }
  }
  return { element: panel, refresh }
}
