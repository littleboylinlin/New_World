import { bookImport } from './book-import-view'
import { formDialog, nameField } from './dialogs'
import { emptyChapter } from './documents/model'
import { createEdition, listEditions } from './documents/store'
import { libraryChanges, listBooks, removeWorkOriginal, storageError } from './library'
import type { Book } from './library'
import { bookPath, breadcrumbs, button, element, fileDetails, link, notice, originalPath } from './ui'
import { stagger } from './motion'
import { offerUndo } from './undo'

export function renderContinuation(root: HTMLElement, id: string, signal: AbortSignal) {
  const panel = element('section', 'reader-page mode-reference')
  const body = element('div')
  body.append(notice('正在读取续写项目…'))
  panel.append(breadcrumbs('reference', true), body)
  root.append(panel)

  let work: Book | undefined
  const heading = element('div', 'page-heading')
  const title = element('h1')
  const headingCopy = element('div')
  headingCopy.append(element('p', 'eyebrow', '续写项目'), title)
  heading.append(headingCopy)
  const lists = element('div', 'continuation-lists')

  const drafts = element('section', 'reader-panel continuation-list')
  const draftHeader = element('div', 'continuation-heading')
  const start = button('新建续写', 'button button-primary button-small', 'plus')
  draftHeader.append(element('h2', '', '续写列表'), start)
  const draftList = element('div')
  drafts.append(draftHeader, draftList)
  start.addEventListener('click', () => {
    if (!work) return
    const current = work
    formDialog(root, { title: '新建续写', action: '开始续写', fields: [nameField('续写名称')] }, async (data) => {
      const edition = await createEdition(current, [emptyChapter()], { source: 'blank' }, String(data.get('name')))
      if (!signal.aborted) location.hash = bookPath('reference', id, edition.id)
    })
  })

  const originals = element('section', 'reader-panel continuation-list')
  const originalHeader = element('div', 'continuation-heading')
  const upload = bookImport('reference', '添加原文', () => { void refresh() }, id)
  originalHeader.append(element('h2', '', '原文列表'), upload.choose, upload.input)
  const originalList = element('div')
  originals.append(originalHeader, upload.progress, originalList)
  lists.append(drafts, originals)

  let request = 0
  let arriving = true
  async function refresh() {
    const current = ++request
    try {
      const [books, editions] = await Promise.all([listBooks('reference'), listEditions('reference', id)])
      if (signal.aborted || current !== request) return
      work = books.find((book) => book.id === id && !book.workId)
      if (!work) {
        body.replaceChildren(notice('这个书库中没有找到该作品。', true))
        return
      }
      title.textContent = work.title
      const chapterList = element('ul', 'book-list')
      chapterList.setAttribute('aria-label', '续写列表')
      for (const edition of editions) {
        const row = element('li', 'book-row')
        const entry = link(bookPath('reference', id, edition.id), edition.name, 'book-link book-title')
        row.append(entry, element('span', 'file-size', `${edition.chapters.length} 章`))
        chapterList.append(row)
      }
      draftList.replaceChildren(editions.length ? (arriving ? stagger(chapterList) : chapterList) : element('p', 'continuation-empty', '还没有续写。新建一篇续写，从第一章开始。'))

      const sourceList = element('ul', 'book-list')
      sourceList.setAttribute('aria-label', '原文列表')
      for (const book of books) {
        if (book.format === 'draft' || (book.workId ?? book.id) !== id) continue
        const row = element('li', 'book-row')
        const entry = link(originalPath(book.id), '', 'book-link')
        entry.setAttribute('aria-label', `查看原文 ${book.title}`)
        const copy = element('div', 'book-copy')
        copy.append(element('strong', 'book-title', book.title), fileDetails(book))
        entry.append(copy)
        const remove = button('移除原文', 'button button-quiet button-small remove-button')
        remove.addEventListener('click', () => formDialog(root, {
          title: '移除这份原文？', action: '确认移除原文', danger: true,
          description: `将把「${book.originalName}」移入回收站。项目内的续写稿会保留。`,
        }, async () => {
          offerUndo(await removeWorkOriginal(id, book.id))
        }))
        row.append(entry, remove)
        sourceList.append(row)
      }
      originalList.replaceChildren(sourceList.childElementCount ? (arriving ? stagger(sourceList) : sourceList) : element('p', 'continuation-empty', '当前没有原文。可以为这个项目添加原文。'))
      if (heading.parentElement !== body) body.replaceChildren(heading, lists)
    } catch (error) {
      if (!signal.aborted && current === request) body.replaceChildren(notice(storageError(error), true))
    }
    if (!signal.aborted && current === request) arriving = false
  }

  libraryChanges.addEventListener('update', () => { void refresh() }, { signal })
  window.addEventListener('focus', () => { void refresh() }, { signal })
  void refresh()
}
