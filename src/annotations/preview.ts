import type { ImportedBook } from '../library'
import { readingAnnotations } from './view'
import { textSurface } from './surface'

/** Preview decoders and EPUB paging replace articles; retire their UI before mounting the next. */
export function annotateTextPreviews(preview: HTMLElement, book: ImportedBook, signal: AbortSignal) {
  const mounted = new Map<HTMLElement, () => void>()
  const refresh = () => {
    for (const [article, destroy] of mounted) {
      if (!preview.contains(article)) { destroy(); mounted.delete(article) }
    }
    for (const article of preview.querySelectorAll<HTMLElement>('.reading-text')) {
      if (mounted.has(article)) continue
      const tools = document.createElement('div')
      article.before(tools)
      const destroy = readingAnnotations(textSurface(article), tools, {
        kind: 'original', library: book.library, bookId: book.id,
        sectionId: article.dataset.readingSection ?? 'text', sourceRevision: book.digest,
      }, signal)
      mounted.set(article, () => { destroy(); tools.remove() })
    }
  }
  const observer = new MutationObserver(refresh)
  observer.observe(preview, { childList: true, subtree: true })
  signal.addEventListener('abort', () => {
    observer.disconnect()
    for (const destroy of mounted.values()) destroy()
    mounted.clear()
  }, { once: true })
  refresh()
}
