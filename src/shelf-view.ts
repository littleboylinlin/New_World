import { bookImport } from './book-import-view'
import { formDialog, nameField } from './dialogs'
import { createNovel } from './documents/store'
import { deleteBook, libraryChanges, listBooks, maxTitleLength, renameBook, storageError } from './library'
import type { Book, LibraryId } from './library'
import { bookPath, breadcrumbs, button, element, fileDetails, icon, libraries, notice } from './ui'
import { stagger } from './motion'
import { offerUndo } from './undo'

const changes = libraryChanges
const libraryIds: LibraryId[] = ['original', 'reference']

export function renderHome(root: HTMLElement, signal: AbortSignal) {
  const home = element('section', 'home')
  const intro = element('header', 'home-intro')
  intro.append(
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
    const copy = element('div', 'card-copy')
    copy.append(element('h2', '', library.name), element('p', '', library.description))
    const bottom = element('div', 'card-bottom')
    const count = element('span', 'card-count', '正在读取')
    const enter = element('span', 'card-enter')
    enter.append('进入书库', icon('arrow'))
    counts.set(id, count)
    bottom.append(count, enter)
    card.append(element('span', 'card-index', library.index), copy, bottom)
    cards.append(card)
  }

  const local = element('p', 'local-note')
  local.append(icon('device'), element('strong', '', '原文件始终可下载'), window.newWorldDesktop ? '导入和阅读都在本机完成。' : '导入和阅读都在当前浏览器完成。')
  home.append(intro, stagger(cards), local)
  root.append(home)

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
    message.append('将把「', element('strong', '', book.title), book.library === 'reference' ? '」及项目内全部续写和原文移入回收站。' : '」及其全部编辑版本和本地原件移入回收站。')
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
      if (isRename) {
        await renameBook(book.library, book.id, input.value)
        changes.dispatchEvent(new Event('update'))
      } else {
        offerUndo(await deleteBook(book.library, book.id))
      }
      dialog.close()
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

// Covers stay the same for a book across visits because the variant comes from its id.
function coverVariant(id: string) {
  let sum = 0
  for (const char of id) sum = (sum * 31 + char.charCodeAt(0)) >>> 0
  return sum % 4
}

function bookCard(root: HTMLElement, book: Book) {
  const row = element('li', 'book-card')
  const open = element('a', 'book-link')
  open.href = bookPath(book.library, book.id)
  open.setAttribute('aria-label', `查看 ${book.title}`)
  open.title = book.title
  const cover = element('span', `book-cover cover-${coverVariant(book.id)}`)
  const length = Array.from(book.title).length
  cover.append(element('strong', length > 14 ? 'book-title book-title-long' : length > 6 ? 'book-title book-title-medium' : 'book-title', book.title))
  open.append(cover, book.library === 'reference'
    ? element('span', 'file-details', '续写项目 · 查看续写和原文') : fileDetails(book))
  const controls = element('div', 'book-controls')
  const rename = button('重命名', 'button button-quiet button-small', 'edit')
  const remove = button('删除', 'button button-quiet button-small remove-button', 'trash')
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
  // Only the first render animates in. Later refreshes swap the list quietly.
  let arriving = true
  async function refresh() {
    const current = ++requestNumber
    try {
      const books = (await listBooks(id)).filter((book) => !book.workId)
      if (signal.aborted || current !== requestNumber) return
      count.textContent = `${books.length} 部`
      if (books.length) {
        const list = element('ul', 'book-list book-grid')
        list.setAttribute('aria-label', '全部作品')
        list.append(...books.map((book) => bookCard(root, book)))
        content.replaceChildren(arriving ? stagger(list) : list)
      } else {
        const empty = element('div', arriving ? 'empty-shelf arrive' : 'empty-shelf')
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
    if (!signal.aborted && current === requestNumber) arriving = false
  }

  changes.addEventListener('update', () => void refresh(), { signal })
  window.addEventListener('focus', () => void refresh(), { signal })
  void refresh()
}
