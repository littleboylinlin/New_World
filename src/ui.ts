import { t } from './i18n'
import { formats } from './formats'
import type { Book, LibraryId } from './library'

export const libraries = {
  original: {
    name: t('libraries.original'), index: '01', label: t('ui.yourOwnWorks'),
    empty: t('ui.noOriginalWorksYet'),
  },
  reference: {
    name: t('libraries.reference'), index: '02', label: t('ui.continuationWriting'),
    empty: t('ui.noSourceWorksYet'),
  },
} as const

const paths = {
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  back: 'M20 12H5m6-6-6 6 6 6',
  plus: 'M12 5v14M5 12h14',
  book: 'M12 6a9 9 0 0 0-8-2v14a9 9 0 0 1 8 2 9 9 0 0 1 8-2V4a9 9 0 0 0-8 2Zm0 0v14',
  file: 'M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9Zm0 0v6h6M8 13h8m-8 4h6',
  download: 'M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4',
  up: 'M12 19V5m-6 6 6-6 6 6',
  down: 'M12 5v14m-6-6 6 6 6-6',
  edit: 'M4 20h4L19 9l-4-4L4 16v4Zm10-14 4 4',
  trash: 'M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13m-7 4v6m4-6v6',
  archive: 'M3 4h18v4H3zm2 4v12h14V8M10 12h4',
  chevron: 'm6 9 6 6 6-6',
  unarchive: 'M3 4h18v4H3zm2 4v12h14V8m-7 3v6m-3-3 3-3 3 3',
  backup: 'M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3',
  check: 'm5 12 5 5 9-10',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 4 4',
  close: 'M6 6l12 12M18 6 6 18',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01m-.01 6h.01m-.01 6h.01',
  ordered: 'M10 6h10m-10 6h10m-10 6h10M4 5h1v4m-1 0h2m-2 6h2l-2 3h2',
  quote: 'M5 17c2-1 3-3 3-6H5V6h5v5c0 4-2 6-5 6Zm9 0c2-1 3-3 3-6h-3V6h5v5c0 4-2 6-5 6Z',
  rule: 'M3 12h18M8 6h8M8 18h8',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'm15 14 5-5-5-5m5 5H10a6 6 0 0 0 0 12h3',
  image: 'M4 5h16v14H4zm0 11 5-5 4 4 3-3 4 4M15 9.5h.01',
  focus: 'M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5',
} as const

export type IconName = keyof typeof paths

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', label?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (label !== undefined) node.textContent = label
  return node
}

export function icon(name: IconName) {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS(namespace, 'path')
  path.setAttribute('d', paths[name])
  svg.append(path)
  return svg
}

export function button(label: string, className = 'button', symbol?: IconName) {
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

export function originalPath(id: string) {
  return `${bookPath('reference', id)}/original`
}

export function breadcrumbs(library: LibraryId, inReader = false) {
  const nav = element('nav', 'breadcrumbs')
  nav.setAttribute('aria-label', t('trash.currentLocation'))
  nav.append(link('#/', t('navigation.home')), element('span', 'crumb-separator', '/'))
  if (inReader) {
    nav.append(link(bookPath(library), libraries[library].name), element('span', 'crumb-separator', '/'))
  }
  const current = element('span', '', inReader ? t('navigation.workDetails') : libraries[library].name)
  current.setAttribute('aria-current', 'page')
  nav.append(current)
  return nav
}

export function fileDetails(book: Book) {
  const details = element('div', 'file-details')
  if (book.format === 'draft') {
    details.append(element('span', 'file-format', t('ui.builtInDocument')))
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
