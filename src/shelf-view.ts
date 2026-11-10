import { bookImport } from './book-import-view'
import { formDialog, nameField } from './dialogs'
import { createNovel } from './documents/store'
import { deleteBook, listBooks, maxTitleLength, renameBook, storageError } from './library'
import type { Book, LibraryId } from './library'
import { bookPath, breadcrumbs, button, element, fileDetails, icon, libraries, notice } from './ui'

const changes = new EventTarget()
const libraryIds: LibraryId[] = ['original', 'reference']

function shelfArtwork(library: LibraryId) {
  const container = element('span', 'shelf-artwork')
  container.setAttribute('aria-hidden', 'true')
  container.innerHTML = library === 'original'
    ? `<svg viewBox="0 0 225 192" fill="none">
      <path d="M50 166c0-65 49-119 108-119 21 0 39 7 53 16M79 168c0-47 35-86 78-86 22 0 42 10 56 26" stroke="currentColor" opacity=".36"/>
      <path d="m52 132 41-15 89 13-42 20-88-12c-6-1-5-4 0-6Zm0 6v15l88 14 42-21v-16m-42 20v17M68 112l32-15 76 9-31 17-77-9m0 0v12m77-3v10m31-27v19" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M124 104c-5-25 12-45 45-57-1 24-15 41-42 55m-9 9 35-47m-15 20 13-1M187 75v12m-6-6h12M88 75v8m-4-4h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      <circle cx="108" cy="55" r="2" fill="currentColor"/><circle cx="202" cy="125" r="2" fill="currentColor"/>
    </svg>`
    : `<svg viewBox="0 0 225 192" fill="none">
      <path d="M48 167c0-68 53-121 113-121 20 0 39 6 54 17m-139 106c0-50 38-89 84-89 21 0 40 8 56 24" stroke="currentColor" opacity=".36"/>
      <path d="M55 107c28-11 49-8 72 8 19-17 42-20 70-10v54c-25-9-50-5-70 9-22-15-46-17-72-7Zm72 8v53M66 118c18-5 35-2 49 6m-49 5c18-5 35-2 49 6m-49 5c18-5 35-2 49 6m24-22c13-8 30-11 47-6m-47 17c13-8 30-11 47-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M166 101v40l7-6 7 5v-39m-48-38v17m-9-8.5h18m37 4v10m-5-5h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      <circle cx="90" cy="85" r="2" fill="currentColor"/><circle cx="201" cy="79" r="2" fill="currentColor"/>
    </svg>`
  return container
}

export function renderHome(root: HTMLElement, signal: AbortSignal) {
  const intro = element('section', 'home-intro')
  intro.append(
    element('p', 'eyebrow', 'NOVEL LIBRARY'),
    element('h1', '', '我的小说书库'),
    element('p', 'intro-copy', '在原创库写自己的故事，也可以围绕原作展开续写。'),
  )

  const cards = element('div', 'shelf-grid')
  const counts = new Map<LibraryId, HTMLElement>()
  for (const id of libraryIds) {
    const library = libraries[id]
    const card = element('a', `shelf-card shelf-${id}`)
    card.href = bookPath(id)
    card.setAttribute('aria-label', `进入${library.name}`)
    const top = element('div', 'card-top')
    top.append(element('span', 'card-index', library.index), element('span', '', library.label))
    const copy = element('div', 'card-copy')
    copy.append(element('h2', '', library.name), element('p', '', library.description))
    const bottom = element('div', 'card-bottom')
    const count = element('span', 'card-count', '正在读取')
    const enter = element('span', 'card-enter')
    enter.append('进入书库', icon('arrow'))
    counts.set(id, count)
    bottom.append(count, enter)
    card.append(shelfArtwork(id), top, copy, bottom)
    cards.append(card)
  }

  const local = element('aside', 'local-note')
  const localIcon = element('div', 'local-icon')
  localIcon.append(icon('device'))
  const localCopy = element('div')
  localCopy.append(element('strong', '', '原文件始终可下载'), element('p', '', window.newWorldDesktop ? '导入和阅读都在本机完成。' : '导入和阅读都在当前浏览器完成。'))
  local.append(localIcon, localCopy)
  root.append(intro, cards, local)

  async function refreshCounts() {
    await Promise.all(libraryIds.map(async (id) => {
      const count = counts.get(id)!
      try {
        const books = await listBooks(id)
        if (!signal.aborted) count.textContent = `${books.filter((book) => !book.workId).length} 部作品`
      } catch {
        if (!signal.aborted) count.textContent = '书库暂不可用'
      }
    }))
  }
  changes.addEventListener('update', () => void refreshCounts(), { signal })
  window.addEventListener('focus', () => void refreshCounts(), { signal })
  void refreshCounts()
}

function manageBook(root: HTMLElement, book: Book, mode: 'rename' | 'delete') {
  const isRename = mode === 'rename'
  const dialog = element('dialog', 'manage-dialog')
  const form = element('form', 'manage-form')
  const title = element('h2', '', isRename ? '重命名作品' : '删除作品？')
  title.id = 'manage-title'
  dialog.setAttribute('aria-labelledby', title.id)
  form.append(title)
  const input = element('input', 'title-input')
  if (isRename) {
    const label = element('label', 'field-label', '作品名')
    input.type = 'text'
    input.name = 'title'
    input.maxLength = maxTitleLength
    input.value = book.title
    label.append(input)
    form.append(label)
    if (book.format !== 'draft') form.append(element('p', 'dialog-help', `原文件名 · ${book.originalName}`))
  } else {
    const message = element('p', 'dialog-help')
    message.append('将从此书库移除「', element('strong', '', book.title), book.library === 'reference' ? '」及项目内全部续写和原文。' : '」及其全部编辑版本和本地原件。')
    form.append(message)
  }

  const error = element('p', 'field-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  const controls = element('div', 'dialog-controls')
  const cancel = button('取消', 'button button-quiet')
  const submit = button(isRename ? '保存名称' : '确认删除', isRename ? 'button button-primary' : 'button button-danger')
  submit.type = 'submit'
  controls.append(cancel, submit)
  form.append(error, controls)
  dialog.append(form)
  root.append(dialog)
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  dialog.addEventListener('cancel', (event) => {
    if (submit.disabled) event.preventDefault()
  })
  cancel.addEventListener('click', () => dialog.close())
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (submit.disabled) return
    submit.disabled = true
    cancel.disabled = true
    error.hidden = true
    try {
      if (isRename) await renameBook(book.library, book.id, input.value)
      else await deleteBook(book.library, book.id)
      dialog.close()
      changes.dispatchEvent(new Event('update'))
    } catch (reason) {
      error.textContent = storageError(reason)
      error.hidden = false
      submit.disabled = false
      cancel.disabled = false
    }
  })
  dialog.showModal()
  if (isRename) {
    input.focus()
    input.select()
  } else {
    cancel.focus()
  }
}

function bookRow(root: HTMLElement, book: Book) {
  const row = element('li', 'book-row')
  const open = element('a', 'book-link')
  open.href = bookPath(book.library, book.id)
  open.setAttribute('aria-label', `查看 ${book.title}`)
  const fileIcon = element('span', 'book-icon')
  fileIcon.append(icon('file'))
  const copy = element('div', 'book-copy')
  copy.append(element('strong', 'book-title', book.title), book.library === 'reference'
    ? element('span', 'file-details', '续写项目 · 查看续写和原文') : fileDetails(book))
  open.append(fileIcon, copy)
  const controls = element('div', 'book-controls')
  const rename = button('重命名', 'button button-quiet button-small')
  const remove = button('删除', 'button button-quiet button-small remove-button')
  rename.addEventListener('click', () => manageBook(root, book, 'rename'))
  remove.addEventListener('click', () => manageBook(root, book, 'delete'))
  controls.append(rename, remove)
  row.append(open, controls)
  return row
}

export function renderShelf(root: HTMLElement, id: LibraryId, signal: AbortSignal) {
  const library = libraries[id]
  const panel = element('section', `shelf-page mode-${id}`)
  const header = element('div', 'page-heading')
  const heading = element('div')
  heading.append(element('p', 'eyebrow', `${library.index} / ${library.label}`), element('h1', '', library.name), element('p', 'intro-copy', library.description))
  const { choose, input, progress } = bookImport(id, id === 'reference' ? '导入原作建立项目' : '导入文件', () => changes.dispatchEvent(new Event('update')))
  const create = button('新建小说', 'button button-quiet', 'plus')
  const controls = element('div', 'shelf-actions')
  create.addEventListener('click', () => formDialog(root, { title: '新建小说', action: '创建小说', fields: [nameField('作品名')] }, async (data) => {
    void navigator.storage?.persist?.().catch(() => {})
    const { book, edition } = await createNovel(id, String(data.get('name')))
    changes.dispatchEvent(new Event('update'))
    location.hash = bookPath(id, book.id, edition.id)
  }))
  if (id === 'original') controls.append(create)
  controls.append(choose, input)
  header.append(heading, controls)

  const listHeader = element('div', 'list-heading')
  const listTitle = element('h2', '', id === 'reference' ? '按原作分组' : '全部作品')
  const count = element('span', 'list-count')
  listHeader.append(listTitle, count)
  const content = element('div', 'shelf-content')
  content.append(notice('正在读取本地书库…'))
  panel.append(breadcrumbs(id), header, progress, listHeader, content)
  root.append(panel)

  let requestNumber = 0
  async function refresh() {
    const current = ++requestNumber
    try {
      const books = (await listBooks(id)).filter((book) => !book.workId)
      if (signal.aborted || current !== requestNumber) return
      count.textContent = `${books.length} 部`
      if (books.length) {
        const list = element('ul', 'book-list')
        list.setAttribute('aria-label', '全部作品')
        list.append(...books.map((book) => bookRow(root, book)))
        content.replaceChildren(list)
      } else {
        const empty = element('div', 'empty-shelf')
        const emptyIcon = element('div', 'empty-icon')
        emptyIcon.append(icon('book'))
        empty.append(emptyIcon, element('h3', '', library.empty), element('p', '', id === 'reference' ? '导入原作后进入项目，就能开始续写。' : '导入 TXT、PDF、EPUB、DOCX 等小说文件。'))
        content.replaceChildren(empty)
      }
    } catch (error) {
      if (!signal.aborted && current === requestNumber) {
        count.textContent = ''
        content.replaceChildren(notice(storageError(error), true))
      }
    }
  }

  changes.addEventListener('update', () => void refresh(), { signal })
  window.addEventListener('focus', () => void refresh(), { signal })
  void refresh()
}
