import { formats } from './formats'
import type { Book, LibraryId } from './library'

export const libraries = {
  original: {
    name: '原创库', index: '01', label: '自己的作品',
    description: '收好你写下的故事，随时翻看草稿与成稿。',
    empty: '还没有原创作品',
  },
  reference: {
    name: '续写／仿写库', index: '02', label: '参考原作',
    description: '单独收藏准备续写或仿写的原作，查阅时随手可得。',
    empty: '还没有参考原作',
  },
} as const

const paths = {
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  back: 'M20 12H5m6-6-6 6 6 6',
  plus: 'M12 5v14M5 12h14',
  book: 'M12 6a9 9 0 0 0-8-2v14a9 9 0 0 1 8 2 9 9 0 0 1 8-2V4a9 9 0 0 0-8 2Zm0 0v14',
  file: 'M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9Zm0 0v6h6M8 13h8m-8 4h6',
  download: 'M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4',
  device: 'M4 5h16v11H4zM2 20h20m-13-8 2 2 4-4',
} as const

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', label?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (label !== undefined) node.textContent = label
  return node
}

export function icon(name: keyof typeof paths) {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.65')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS(namespace, 'path')
  path.setAttribute('d', paths[name])
  svg.append(path)
  return svg
}

export function button(label: string, className = 'button', symbol?: keyof typeof paths) {
  const control = element('button', className)
  control.type = 'button'
  if (symbol) control.append(icon(symbol))
  control.append(label)
  return control
}

export function link(href: string, label: string, className = '') {
  const anchor = element('a', className, label)
  anchor.href = href
  return anchor
}

export function bookPath(library: LibraryId, id?: string, editionId?: string) {
  return `#/${library}${id ? `/${id}` : ''}${editionId ? `/${editionId}` : ''}`
}

export function breadcrumbs(library: LibraryId, inReader = false) {
  const nav = element('nav', 'breadcrumbs')
  nav.setAttribute('aria-label', '当前位置')
  nav.append(link('#/', '书库首页'), element('span', 'crumb-separator', '/'))
  if (inReader) {
    nav.append(link(bookPath(library), libraries[library].name), element('span', 'crumb-separator', '/'))
  }
  const current = element('span', '', inReader ? '作品详情' : libraries[library].name)
  current.setAttribute('aria-current', 'page')
  nav.append(current)
  return nav
}

export function fileDetails(book: Book) {
  const details = element('div', 'file-details')
  if (book.format === 'draft') {
    details.append(element('span', 'file-format', '内建文档'), element('span', '', '在 New World 中创建'))
    return details
  }
  const size = book.size < 1024 ? `${book.size} B`
    : book.size < 1024 * 1024 ? `${(book.size / 1024).toFixed(1)} KiB`
    : `${(book.size / 1024 / 1024).toFixed(1)} MiB`
  details.append(element('span', 'file-format', formats[book.format].label), element('span', 'filename', book.originalName), element('span', 'file-size', size))
  return details
}

export function downloadFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }))
  const anchor = element('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function notice(message: string, error = false) {
  const panel = element('p', error ? 'notice notice-error' : 'notice', message)
  panel.setAttribute('role', error ? 'alert' : 'status')
  return panel
}
