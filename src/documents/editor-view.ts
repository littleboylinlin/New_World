import { Editor } from '@tiptap/core'
import { formDialog, nameField } from '../dialogs'
import { storageError } from '../library'
import type { Book } from '../library'
import { bookPath, button, element, icon } from '../ui'
import type { IconName } from '../ui'
import { offerUndo } from '../undo'
import { exportEdition, outputFormats } from './export'
import type { OutputFormat } from './export'
import { cleanMarkup, inertMarkup, rasterData } from './markup'
import { wordCount } from './model'
import type { ChapterInput, ChapterRecord, DocumentContent, Edition } from './model'
import { checkDocument, documentExtensions } from './schema'
import { replaceMatches, revealMatch, SearchHighlight, searchState, setSearch } from './search'
import { changeChapters, chapterWordCounts, createEdition, deleteEdition, readBundle, readChapter, saveChapter } from './store'
import './editor.css'

export type RegisterLeave = (callback: () => Promise<boolean>) => void

export async function renderEdition(
  host: HTMLElement, root: HTMLElement, book: Book, initial: Edition, signal: AbortSignal, registerLeave: RegisterLeave,
) {
  let edition = initial
  let chapter = await readChapter(edition, edition.chapters[0].id)
  signal.throwIfAborted()
  let editor: Editor
  let editing = true
  let change = 0
  let saved = 0
  let timer: number | undefined
  let pending: Promise<boolean> | undefined
  let selectionRequest = 0
  let activeMatch = 0
  let refreshFrame = 0
  // Word counts of the other chapters are read once. The open chapter is counted as it changes.
  let words: Map<string, number> | undefined
  const wordLabels = new Map<string, HTMLElement>()
  const number = (value: number) => value.toLocaleString('zh-CN')

  const workspace = element('section', 'edition-workspace')
  const top = element('header', 'edition-header')
  const about = element('div', 'edition-about')
  const origin = { original: '由原文件转换', blank: '在编辑器中创建', copy: '独立编辑副本' }[edition.source]
  about.append(element('p', 'eyebrow', origin), element('h2', '', edition.name))
  const commands = element('div', 'edition-commands')
  const status = element('span', 'save-status', '已保存')
  status.setAttribute('role', 'status')
  const save = button('手动保存', 'button button-primary button-small', 'check')
  save.title = 'Ctrl / ⌘ + S'
  const mode = button('', 'button button-quiet button-small', 'book')
  const modeLabel = element('span', '', '阅读模式')
  mode.append(modeLabel)
  const saveCopy = button('另存为独立版本', 'button button-quiet button-small', 'copy')
  const exportButton = button('导出', 'button button-quiet button-small', 'download')
  const removeVersion = button('删除版本', 'button button-quiet button-small remove-button', 'trash')
  commands.append(status, save, mode, saveCopy, exportButton, removeVersion)
  top.append(about, commands)

  const error = element('p', 'notice notice-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  const recover = button('放弃本章未保存改动', 'button button-quiet button-small')
  recover.hidden = true
  const information = element('details', 'conversion-info')
  information.append(element('summary', '', '查看转换说明'))
  const details = element('ul')
  for (const note of edition.notes) details.append(element('li', '', note))
  information.append(details)
  information.hidden = !edition.notes.length

  const layout = element('div', 'edition-layout')
  const navigation = element('details', 'chapter-navigation')
  navigation.open = matchMedia('(min-width: 780px)').matches
  const navLabel = element('summary', '', '章节目录')
  const chapterList = element('ol', 'chapter-list')
  chapterList.setAttribute('aria-label', '章节')
  const chapterActions = element('div', 'chapter-actions')
  const add = button('新建章节', 'button button-quiet button-small', 'plus')
  const rename = button('重命名章节', 'button button-quiet button-small', 'edit')
  const up = button('上移', 'button button-quiet button-small', 'up')
  const down = button('下移', 'button button-quiet button-small', 'down')
  const remove = button('删除章节', 'button button-quiet button-small remove-button', 'trash')
  chapterActions.append(add, rename, up, down, remove)
  const outline = element('nav', 'chapter-outline')
  outline.setAttribute('aria-label', '本章小节')
  navigation.append(navLabel, chapterList, chapterActions, outline)

  const writing = element('section', 'writing-panel')
  const chapterHeader = element('header', 'writing-header')
  const chapterTitle = element('h3')
  const count = element('span', 'word-count')
  const total = element('span', 'word-total')
  total.hidden = true
  const counts = element('div', 'word-counts')
  counts.append(count, total)
  chapterHeader.append(chapterTitle, counts)
  const toolbar = element('div', 'format-toolbar')
  toolbar.setAttribute('role', 'group')
  toolbar.setAttribute('aria-label', '正文格式')
  const heading = element('select', 'editor-select')
  heading.setAttribute('aria-label', '段落样式')
  for (const [value, label] of ['段落', '一级标题', '二级标题', '三级标题', '四级标题', '五级标题', '六级标题'].entries()) {
    const option = element('option', '', label)
    option.value = String(value)
    heading.append(option)
  }
  heading.addEventListener('change', () => {
    const command = editor.chain().focus()
    if (heading.value === '0') command.setParagraph().run()
    else command.setHeading({ level: Number(heading.value) as 1 | 2 | 3 | 4 | 5 | 6 }).run()
  })
  toolbar.append(heading)

  const markControls: { node: HTMLButtonElement; active: string }[] = []
  // Toolbar buttons show a glyph or an icon. The label stays as the accessible name and tooltip.
  function tool(label: string, symbol: IconName | { glyph: string }, invoke: () => void, active?: string, shortcut?: string) {
    const node = button('', 'format-button')
    if (typeof symbol === 'string') node.append(icon(symbol))
    else node.append(element('span', `format-glyph format-${active}`, symbol.glyph))
    node.setAttribute('aria-label', label)
    node.title = shortcut ? `${label}（${shortcut}）` : label
    node.addEventListener('mousedown', (event) => event.preventDefault())
    node.addEventListener('click', invoke)
    if (active) markControls.push({ node, active })
    toolbar.append(node)
    return node
  }
  const divider = () => toolbar.append(element('span', 'format-divider'))
  divider()
  tool('加粗', { glyph: 'B' }, () => editor.chain().focus().toggleBold().run(), 'bold', 'Ctrl / ⌘ + B')
  tool('斜体', { glyph: 'I' }, () => editor.chain().focus().toggleItalic().run(), 'italic', 'Ctrl / ⌘ + I')
  tool('下划线', { glyph: 'U' }, () => editor.chain().focus().toggleUnderline().run(), 'underline', 'Ctrl / ⌘ + U')
  divider()
  tool('无序列表', 'list', () => editor.chain().focus().toggleBulletList().run(), 'bulletList')
  tool('有序列表', 'ordered', () => editor.chain().focus().toggleOrderedList().run(), 'orderedList')
  tool('引用', 'quote', () => editor.chain().focus().toggleBlockquote().run(), 'blockquote')
  tool('分隔线', 'rule', () => editor.chain().focus().setHorizontalRule().run())
  divider()
  const undo = tool('撤销', 'undo', () => editor.chain().focus().undo().run(), undefined, 'Ctrl / ⌘ + Z')
  const redo = tool('重做', 'redo', () => editor.chain().focus().redo().run(), undefined, 'Ctrl / ⌘ + Shift + Z')
  divider()
  const imageInput = element('input')
  imageInput.type = 'file'
  imageInput.accept = 'image/png,image/jpeg,image/gif,image/webp'
  imageInput.hidden = true
  imageInput.setAttribute('aria-label', '选择插图')
  let imageTarget: Editor | undefined
  tool('插图', 'image', () => { imageTarget = editor; imageInput.click() })
  imageInput.addEventListener('change', async () => {
    const target = imageTarget
    imageTarget = undefined
    const file = imageInput.files?.[0]
    imageInput.value = ''
    if (!file) return
    try {
      const src = await rasterData(file)
      if (!src) throw new Error('请选择不超过 4 MiB 的 PNG、JPEG、GIF 或 WebP 图片。')
      if (target === editor && editing && !signal.aborted) editor.chain().focus().setImage({ src, alt: file.name.slice(0, 255) }).run()
    } catch (cause) { report(cause) }
  })

  const findButton = button('查找／替换', 'format-button find-toggle', 'search')
  findButton.title = 'Ctrl / ⌘ + F'
  const toolsRow = element('div', 'editor-tools-row')
  toolsRow.append(toolbar, findButton, imageInput)

  const searchBar = element('div', 'search-panel')
  searchBar.hidden = true
  const query = element('input', 'title-input')
  query.type = 'search'
  query.setAttribute('aria-label', '查找文字')
  query.placeholder = '查找本章'
  query.maxLength = 512
  const replacement = element('input', 'title-input')
  replacement.setAttribute('aria-label', '替换为')
  replacement.placeholder = '替换为'
  const nextMatch = button('下一处', 'format-button')
  const previousMatch = button('上一处', 'format-button')
  const replace = button('替换', 'format-button')
  const replaceAll = button('全部替换', 'format-button')
  const matchCount = element('span', 'match-count')
  matchCount.setAttribute('role', 'status')
  const closeSearch = button('关闭查找', 'format-button')
  searchBar.append(query, previousMatch, nextMatch, matchCount, replacement, replace, replaceAll, closeSearch)
  const paper = element('div', 'editor-paper')
  writing.append(chapterHeader, toolsRow, searchBar, paper)
  layout.append(navigation, writing)
  workspace.append(top, error, recover, information, layout)
  host.replaceChildren(workspace)

  function report(cause: unknown, saving = false) {
    error.textContent = `${saving ? '保存失败。' : ''}${storageError(cause)}`
    error.hidden = false
    recover.hidden = !saving || change === saved
    if (saving) status.textContent = '未保存 · 失败'
  }

  function scheduleSave() {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => { void flush() }, 700)
  }

  function unsaved(event: BeforeUnloadEvent) {
    event.preventDefault()
    event.returnValue = ''
  }

  async function flush() {
    window.clearTimeout(timer)
    while (change !== saved || pending) {
      if (!pending) {
        if (editor.view.composing) {
          status.textContent = '输入完成后保存'
          return false
        }
        const snapshot = editor.getJSON() as DocumentContent
        const checkpoint = change
        status.textContent = '正在保存…'
        pending = saveChapter(edition, chapter, snapshot).then((stored) => {
          chapter = stored
          saved = checkpoint
          status.textContent = change === saved ? '已保存' : '未保存'
          error.hidden = recover.hidden = true
          if (change === saved) window.removeEventListener('beforeunload', unsaved)
          return true
        }, (cause) => { report(cause, true); return false }).finally(() => { pending = undefined })
      }
      if (!await pending) return false
    }
    return true
  }

  function chapterInfo() {
    return edition.chapters.find((entry) => entry.id === chapter.id) ?? { id: chapter.id, title: chapterTitle.textContent || '已移除章节' }
  }

  const liveCount = () => Array.from(editor.state.doc.textContent.replace(/\s/gu, '')).length

  function refreshWords(everyChapter = true) {
    if (!words) return
    let sum = 0
    for (const { id } of edition.chapters) sum += words.get(id) ?? 0
    total.textContent = `全书 ${number(sum)} 字`
    total.hidden = false
    for (const [id, label] of everyChapter ? wordLabels : [[chapter.id, wordLabels.get(chapter.id)] as const]) {
      if (label) label.textContent = number(words.get(id) ?? 0)
    }
  }

  function refreshContents() {
    const current = liveCount()
    count.textContent = `本章 ${number(current)} 字`
    words?.set(chapter.id, current)
    refreshWords(false)
    outline.replaceChildren()
    const links = element('ul')
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'heading' && node.textContent.trim()) {
        const item = element('li')
        const jump = button(node.textContent.slice(0, 100), 'outline-jump')
        jump.addEventListener('click', () => (editor.view.nodeDOM(position) as Element | null)?.scrollIntoView({ block: 'start' }))
        item.append(jump)
        links.append(item)
      }
    })
    if (links.childNodes.length) outline.append(element('strong', '', '本章小节'), links)
    refreshSearch()
  }

  function refreshFormat() {
    for (const { node, active } of markControls) node.setAttribute('aria-pressed', String(editor.isActive(active)))
    heading.value = editor.isActive('heading') ? String(editor.getAttributes('heading').level) : '0'
    undo.disabled = !editor.can().undo()
    redo.disabled = !editor.can().redo()
  }

  function refreshSearch(reveal = false) {
    const { matches, overflow } = searchState(editor)
    activeMatch = Math.min(activeMatch, Math.max(0, matches.length - 1))
    matchCount.textContent = matches.length ? `${activeMatch + 1} / ${overflow ? '≥' : ''}${matches.length}` : query.value ? '没有匹配' : ''
    previousMatch.disabled = nextMatch.disabled = !matches.length
    replacement.hidden = replace.hidden = replaceAll.hidden = !editing
    replace.disabled = !matches.length
    replaceAll.disabled = !matches.length || overflow
    if (reveal && matches.length) revealMatch(editor, matches[activeMatch])
  }

  function refreshChapters() {
    chapterTitle.textContent = chapterInfo().title
    navLabel.textContent = `章节目录 · ${edition.chapters.length}`
    wordLabels.clear()
    chapterList.replaceChildren(...edition.chapters.map(({ id, title }) => {
      const item = element('li')
      const jump = button(title, 'chapter-jump')
      if (id === chapter.id) jump.setAttribute('aria-current', 'true')
      jump.addEventListener('click', () => { void switchChapter(id) })
      const label = element('span', 'chapter-words')
      label.title = '本章字数'
      wordLabels.set(id, label)
      item.append(jump, label)
      return item
    }))
    refreshWords()
    const index = edition.chapters.findIndex((entry) => entry.id === chapter.id)
    up.disabled = index === 0
    down.disabled = index === edition.chapters.length - 1
  }

  function applyMode() {
    editor.setEditable(editing, false)
    editor.view.dom.setAttribute('role', editing ? 'textbox' : 'document')
    modeLabel.textContent = editing ? '阅读模式' : '编辑正文'
    mode.setAttribute('aria-pressed', String(!editing))
    toolbar.hidden = chapterActions.hidden = save.hidden = !editing
    workspace.classList.toggle('edition-reading', !editing)
    refreshSearch()
  }

  function mountChapter(next: ChapterRecord) {
    checkDocument(next.content)
    editor?.destroy()
    paper.replaceChildren()
    chapter = next
    change = saved = 0
    activeMatch = 0
    status.textContent = '已保存'
    error.hidden = recover.hidden = true
    editor = new Editor({
      element: paper, extensions: [...documentExtensions, SearchHighlight], content: next.content, editable: editing,
      editorProps: {
        attributes: { class: 'novel-body', 'aria-label': '章节正文', 'aria-multiline': 'true', spellcheck: 'false' },
        transformPastedHTML: (markup) => {
          if (markup.length <= 36 * 1024 * 1024) return cleanMarkup(inertMarkup(markup))
          report(new Error('剪贴板的富文本内容过大。可分段粘贴或使用纯文本粘贴。'))
          return ''
        },
        handleDrop: (_, event, _slice, moved) => {
          if (!moved && event.dataTransfer?.files.length) { event.preventDefault(); return true }
          return false
        },
      },
      onUpdate: () => {
        change++
        status.textContent = '未保存'
        window.addEventListener('beforeunload', unsaved)
        scheduleSave()
        window.cancelAnimationFrame(refreshFrame)
        refreshFrame = window.requestAnimationFrame(refreshContents)
      },
    })
    editor.on('transaction', refreshFormat)
    editor.view.dom.addEventListener('compositionend', () => { if (change !== saved) scheduleSave() })
    setSearch(editor, query.value)
    applyMode()
    refreshChapters()
    refreshContents()
  }

  async function switchChapter(id: string) {
    const request = ++selectionRequest
    if (id === chapter.id) return
    try {
      if (!await flush()) return
      const next = await readChapter(edition, id)
      if (!await flush() || signal.aborted || request !== selectionRequest) return
      mountChapter(next)
      if (matchMedia('(max-width: 779px)').matches) navigation.open = false
    } catch (cause) { report(cause) }
  }

  async function alter(changeRequest: Parameters<typeof changeChapters>[1]) {
    if (!await flush()) throw new Error('请先处理未保存的正文。')
    const result = await changeChapters(edition, changeRequest)
    edition = result.edition
    if (result.selected !== chapter.id) await switchChapter(result.selected)
    else refreshChapters()
    if (result.trashed) offerUndo(result.trashed, (restored) => {
      if (signal.aborted || !restored.edition) return
      const [record] = restored.entry.chapters
      edition = restored.edition
      words?.set(record.id, wordCount(record.content))
      refreshChapters()
    })
  }

  async function currentChapters(selectedIds?: Set<string>): Promise<ChapterInput[]> {
    if (editor.view.composing) throw new Error('请先完成当前输入。')
    const visible = { title: chapterInfo().title, content: editor.getJSON() as DocumentContent }
    const bundle = await readBundle(edition)
    const infos = bundle.edition.chapters
    const index = infos.findIndex((entry) => entry.id === chapter.id)
    if (index < 0) return [...bundle.chapters, visible]
    if (change !== saved) bundle.chapters[index] = { ...bundle.chapters[index], content: visible.content }
    if (!selectedIds) return bundle.chapters
    return bundle.chapters.filter((_, i) => selectedIds.has(infos[i]?.id))
  }

  function changeMatch(offset: number) {
    const length = searchState(editor).matches.length
    if (!length) return
    activeMatch = (activeMatch + offset + length) % length
    refreshSearch(true)
  }

  findButton.addEventListener('click', () => { searchBar.hidden = false; query.focus(); query.select() })
  query.addEventListener('input', () => { activeMatch = 0; setSearch(editor, query.value); refreshSearch(true) })
  query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); changeMatch(event.shiftKey ? -1 : 1) }
    if (event.key === 'Escape') closeSearch.click()
  })
  nextMatch.addEventListener('click', () => changeMatch(1))
  previousMatch.addEventListener('click', () => changeMatch(-1))
  closeSearch.addEventListener('click', () => { searchBar.hidden = true; query.value = ''; setSearch(editor, ''); findButton.focus() })
  replace.addEventListener('click', () => {
    const match = searchState(editor).matches[activeMatch]
    if (editing && match) { replaceMatches(editor, [match], replacement.value); refreshSearch() }
  })
  replaceAll.addEventListener('click', () => {
    const { matches, overflow } = searchState(editor)
    if (editing && !overflow) { replaceMatches(editor, matches, replacement.value); refreshSearch() }
  })

  save.addEventListener('click', () => { void flush() })
  mode.addEventListener('click', async () => { if (await flush()) { editing = !editing; applyMode() } })
  add.addEventListener('click', () => formDialog(root, { title: '新建章节', action: '创建章节', fields: [nameField('章节名')] },
    async (data) => alter({ type: 'add', title: String(data.get('name')) })))
  rename.addEventListener('click', () => formDialog(root, { title: '重命名章节', action: '保存章节名', fields: [nameField('章节名', chapterInfo().title)] },
    async (data) => alter({ type: 'rename', id: chapter.id, title: String(data.get('name')) })))
  up.addEventListener('click', () => { void alter({ type: 'move', id: chapter.id, offset: -1 }).catch(report) })
  down.addEventListener('click', () => { void alter({ type: 'move', id: chapter.id, offset: 1 }).catch(report) })
  remove.addEventListener('click', () => formDialog(root, { title: '删除章节？', action: '确认删除章节', danger: true, description: `将把「${chapterInfo().title}」及其正文移入回收站。删除最后一章后会创建空白章节。` },
    async () => alter({ type: 'delete', id: chapter.id })))
  removeVersion.addEventListener('click', () => formDialog(root, { title: '删除编辑版本？', action: '确认删除版本', danger: true, description: `将把「${edition.name}」及其全部章节移入回收站。其他版本和原文件仍可使用。` }, async () => {
    if (!await flush()) throw new Error('请先保存或另存当前改动。')
    const entry = await deleteEdition(edition)
    location.hash = bookPath(book.library, book.id)
    offerUndo(entry, (restored) => {
      if (restored.edition) location.hash = bookPath(book.library, book.id, restored.edition.id)
    })
  }))
  recover.addEventListener('click', () => formDialog(root, { title: '放弃未保存的改动？', action: '放弃并返回书库', danger: true, description: '将舍弃当前未保存正文，保留已提交的内容。' }, async () => {
    window.clearTimeout(timer)
    if (pending) await pending
    saved = change
    window.removeEventListener('beforeunload', unsaved)
    location.hash = bookPath(book.library)
  }))
  saveCopy.addEventListener('click', () => formDialog(root, { title: '另存为独立版本', action: '保存独立版本', fields: [nameField('版本名', `${edition.name} 副本`)] }, async (data) => {
    await flush()
    const copy = await createEdition(book, await currentChapters(), { source: 'copy', copiedFrom: edition.id, notes: edition.notes, originalId: edition.originalId }, String(data.get('name')))
    window.clearTimeout(timer)
    saved = change
    window.removeEventListener('beforeunload', unsaved)
    location.hash = bookPath(book.library, book.id, copy.id)
  }))
  exportButton.addEventListener('click', () => {
    const formats = element('div', 'export-formats')
    formats.setAttribute('role', 'radiogroup')
    formats.setAttribute('aria-label', '导出格式')
    for (const [value, label] of Object.entries(outputFormats)) {
      const item = element('label', 'export-format')
      const radio = element('input')
      radio.type = 'radio'
      radio.name = 'format'
      radio.value = value
      radio.checked = value === 'txt'
      item.append(radio, element('span', '', label))
      formats.append(item)
    }
    const chapterBox = element('div', 'export-chapters')
    chapterBox.setAttribute('role', 'group')
    chapterBox.setAttribute('aria-label', '选择章节')
    const allRow = element('label', 'export-chapter export-chapter-all')
    const allInput = element('input')
    allInput.type = 'checkbox'
    allInput.checked = true
    allRow.append(allInput, element('span', '', '全选'))
    chapterBox.append(allRow)
    const boxes: HTMLInputElement[] = []
    for (const info of edition.chapters) {
      const row = element('label', 'export-chapter')
      const box = element('input')
      box.type = 'checkbox'
      box.name = 'chapter'
      box.value = info.id
      box.checked = true
      row.append(box, element('span', '', info.title))
      chapterBox.append(row)
      boxes.push(box)
    }
    allInput.addEventListener('change', () => {
      for (const box of boxes) box.checked = allInput.checked
    })
    chapterBox.addEventListener('change', (event) => {
      if (event.target === allInput) return
      allInput.checked = boxes.length > 0 && boxes.every((box) => box.checked)
      allInput.indeterminate = !allInput.checked && boxes.some((box) => box.checked)
    })

    formDialog(root, { title: '导出编辑稿', action: '开始导出', fields: [formats, chapterBox] }, async (data) => {
      const ids = new Set(data.getAll('chapter').map(String))
      if (!ids.size) throw new Error('请至少选择一章。')
      const chapters = ids.size === edition.chapters.length ? await currentChapters() : await currentChapters(ids)
      await exportEdition(String(data.get('format')) as OutputFormat, `${book.title} - ${edition.name}`, chapters)
    })
  })

  window.addEventListener('keydown', (event) => {
    if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.isComposing || document.querySelector('dialog[open]')) return
    if (event.key.toLowerCase() === 's') { event.preventDefault(); void flush() }
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); findButton.click() }
  }, { signal })
  document.addEventListener('visibilitychange', () => { if (document.hidden) void flush() }, { signal })
  window.addEventListener('pagehide', () => { void flush() }, { signal })
  signal.addEventListener('abort', () => {
    window.clearTimeout(timer)
    window.cancelAnimationFrame(refreshFrame)
    window.removeEventListener('beforeunload', unsaved)
    editor?.destroy()
  }, { once: true })
  mountChapter(chapter)
  registerLeave(flush)
  void chapterWordCounts(edition).then((stored) => {
    if (signal.aborted) return
    stored.set(chapter.id, liveCount())
    words = stored
    refreshWords()
  }, () => {})
}
