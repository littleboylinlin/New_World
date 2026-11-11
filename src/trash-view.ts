import { formDialog } from './dialogs'
import { libraryChanges, storageError } from './library'
import { emptyTrash, listTrash, restoreTrash, trashDays } from './trash'
import type { TrashItem } from './trash'
import { button, element, icon, libraries, link, notice } from './ui'
import { stagger } from './motion'
import { trashKinds } from './undo'

const day = 24 * 60 * 60 * 1000

function trashRow(root: HTMLElement, { entry, place }: TrashItem, report: (message: string, error?: boolean) => void) {
  const row = element('li', 'book-row trash-row')
  const copy = element('div', 'book-copy')
  const details = element('div', 'file-details')
  const left = Math.max(1, Math.ceil((entry.deletedAt + trashDays * day - Date.now()) / day))
  const deleted = new Date(entry.deletedAt).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  details.append(
    element('span', 'file-format', trashKinds[entry.kind]),
    element('span', 'filename', place ? `${libraries[entry.library].name} · ${place}` : libraries[entry.library].name),
    element('span', 'file-size', `${deleted} 删除 · 还剩 ${left} 天`),
  )
  copy.append(element('strong', 'book-title', entry.title), details)
  const controls = element('div', 'book-controls')
  const restore = button('恢复', 'button button-primary button-small', 'undo')
  const remove = button('彻底删除', 'button button-quiet button-small remove-button', 'trash')
  restore.addEventListener('click', async () => {
    restore.disabled = remove.disabled = true
    try {
      await restoreTrash(entry.id)
      report(`已恢复「${entry.title}」。`)
    } catch (error) {
      report(storageError(error), true)
      restore.disabled = remove.disabled = false
    }
  })
  remove.addEventListener('click', () => formDialog(root, {
    title: '彻底删除？', action: '确认彻底删除', danger: true, description: `将永久删除「${entry.title}」，之后无法恢复。`,
  }, async () => {
    await emptyTrash(entry.id)
    report(`已彻底删除「${entry.title}」。`)
  }))
  controls.append(restore, remove)
  row.append(copy, controls)
  return row
}

export function renderTrash(root: HTMLElement, signal: AbortSignal) {
  const panel = element('section', 'trash-page')
  const nav = element('nav', 'breadcrumbs')
  nav.setAttribute('aria-label', '当前位置')
  const current = element('span', '', '回收站')
  current.setAttribute('aria-current', 'page')
  nav.append(link('#/', '书库首页'), element('span', 'crumb-separator', '/'), current)

  const header = element('div', 'page-heading')
  const heading = element('div')
  heading.append(element('p', 'eyebrow', 'TRASH'), element('h1', '', '回收站'),
    element('p', 'intro-copy', `删除的作品、原文、编辑版本和章节会在这里保留 ${trashDays} 天，可以恢复到原来的位置。`))
  const clear = button('清空回收站', 'button button-quiet remove-button', 'trash')
  header.append(heading, clear)
  const message = element('div', 'version-message')
  const content = element('div')
  content.append(notice('正在读取回收站…'))
  panel.append(nav, header, message, content)
  root.append(panel)

  function report(text: string, error = false) {
    message.replaceChildren(notice(text, error))
  }

  let request = 0
  let arriving = true
  async function refresh() {
    const turn = ++request
    try {
      const items = await listTrash()
      if (signal.aborted || turn !== request) return
      clear.disabled = !items.length
      if (items.length) {
        const list = element('ul', 'book-list')
        list.setAttribute('aria-label', '回收站内容')
        list.append(...items.map((item) => trashRow(root, item, report)))
        content.replaceChildren(arriving ? stagger(list) : list)
      } else {
        const empty = element('div', arriving ? 'empty-shelf arrive' : 'empty-shelf')
        const emptyIcon = element('div', 'empty-icon')
        emptyIcon.append(icon('trash'))
        empty.append(emptyIcon, element('h3', '', '回收站是空的'), element('p', '', '删除的内容会先放到这里。'))
        content.replaceChildren(empty)
      }
    } catch (error) {
      if (!signal.aborted && turn === request) content.replaceChildren(notice(storageError(error), true))
    }
    if (!signal.aborted && turn === request) arriving = false
  }

  clear.addEventListener('click', () => formDialog(root, {
    title: '清空回收站？', action: '确认清空', danger: true, description: '将永久删除回收站里的全部内容，之后无法恢复。',
  }, async () => {
    await emptyTrash()
    report('回收站已清空。')
  }))
  libraryChanges.addEventListener('update', () => { void refresh() }, { signal })
  window.addEventListener('focus', () => { void refresh() }, { signal })
  void refresh()
}
