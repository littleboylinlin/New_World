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
  home: 'm3 10 9-7 9 7M5 9v12h14V9M10 21v-7h4v7',
  sidebar: 'M3 4h18v16H3zM9 4v16',
  menu: 'M3 6h18M3 12h18M3 18h18',
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  connect: 'M5 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM19 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM7 17 17 7',
  back: 'M20 12H5m6-6-6 6 6 6',
  plus: 'M12 5v14M5 12h14',
  book: 'M12 6a9 9 0 0 0-8-2v14a9 9 0 0 1 8 2 9 9 0 0 1 8-2V4a9 9 0 0 0-8 2Zm0 0v14',
  cards: 'M7 3h13v14H7zM4 7v14h13M10 7h7m-7 4h5',
  pointer: 'M6 3l12 8.5-5.2 1.3 3 5.6-2.3 1.2-3-5.6L6 18z',
  hand: 'M12 3v18M3 12h18M12 3 9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5',
  arrowTool: 'M5 19 19 5m-9 0h9v9',
  frame: 'M7 3v18M17 3v18M3 7h18M3 17h18',
  eraser: 'M9 20h11M4.6 14.4l9-9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 18H8.2l-3.6-3.6M9 10l5 5',
  file: 'M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9Zm0 0v6h6M8 13h8m-8 4h6',
  download: 'M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4',
  up: 'M12 19V5m-6 6 6-6 6 6',
  down: 'M12 5v14m-6-6 6 6 6-6',
  edit: 'M4 20h4L19 9l-4-4L4 16v4Zm10-14 4 4',
  trash: 'M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13m-7 4v6m4-6v6',
  archive: 'M3 4h18v4H3zm2 4v12h14V8M10 12h4',
  chevron: 'm6 9 6 6 6-6',
  idea: 'M9 18h6m-5 3h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z',
  unarchive: 'M3 4h18v4H3zm2 4v12h14V8m-7 3v6m-3-3 3-3 3 3',
  backup: 'M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3',
  check: 'm5 12 5 5 9-10',
  bell: 'M6 9a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9Zm4.3 11a2 2 0 0 0 3.4 0',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 4 4',
  close: 'M6 6l12 12M18 6 6 18',
  minimize: 'M5 12h14',
  maximize: 'M5 5h14v14H5z',
  restore: 'M8 8V4h12v12h-4M4 8h12v12H4z',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01m-.01 6h.01m-.01 6h.01',
  ordered: 'M10 6h10m-10 6h10m-10 6h10M4 5h1v4m-1 0h2m-2 6h2l-2 3h2',
  quote: 'M5 17c2-1 3-3 3-6H5V6h5v5c0 4-2 6-5 6Zm9 0c2-1 3-3 3-6h-3V6h5v5c0 4-2 6-5 6Z',
  rule: 'M3 12h18M8 6h8M8 18h8',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'm15 14 5-5-5-5m5 5H10a6 6 0 0 0 0 12h3',
  image: 'M4 5h16v14H4zm0 11 5-5 4 4 3-3 4 4M15 9.5h.01',
  focus: 'M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5m4-1v5l3 2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-1.5a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V20a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H4a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H10a1.65 1.65 0 0 0 1-1.51V4a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V10a1.65 1.65 0 0 0 1.51 1H20a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
  general: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  appearance: 'M12 21a9 9 0 1 1 0-18c4.97 0 9 3.58 9 8 0 2.2-1.8 4-4 4h-1.5a1.5 1.5 0 0 0-1.5 1.5c0 .39.15.76.41 1.04.29.3.41.73.24 1.13A2 2 0 0 1 12 21ZM8 11.5h.01M10.5 8h.01M15 9.5h.01',
  storage: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  ai: 'M9 7h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm0-4v2m6-2v2M9 19v2m6-2v2M3 9h2m-2 6h2m14-6h2m-2 6h2',
  more: 'M5.5 12h.5M11.75 12h.5M18 12h.5',
  splitRight: 'M3 4h18v16H3zM12 4v16',
  splitDown: 'M3 4h18v16H3zM3 12h18',
  window: 'M4 5h16v14H4zM4 9h16',
  swap: 'M7 7h13m-4-4 4 4-4 4M17 17H4m4-4-4 4 4 4',
  compare: 'M3 5h7v14H3zm11 0h7v14h-7',
  reload: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
  panel: 'M3 4h18v16H3zM15 4v16',
  note: 'M4 5h16v11h-9l-5 4v-4H4z',
  strike: 'M4 12h16M16 6.5C15 5 13.6 4.5 12 4.5c-2.5 0-4 1.3-4 3.2 0 1.4.8 2.3 2.4 2.9m3.4 3.3c1.4.6 2.2 1.5 2.2 2.8 0 2-1.7 3.3-4.2 3.3-1.9 0-3.5-.7-4.3-2.2',
  code: 'm8 8-4 4 4 4m8-8 4 4-4 4m-6 2 4-12',
  codeBlock: 'M4 4h16v16H4zm5 6-2 2 2 2m6-4 2 2-2 2',
  format: 'M4 7V5h16v2M9 19h6M12 5v14',
  updates: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v4m0 4h.01',
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

/**
 * A status line for work that takes a while, with a spinner. The spinner turns on the compositor,
 * so it keeps moving even while the page is busy laying out a long chapter.
 */
export function progressNotice(message: string) {
  const panel = element('p', 'notice progress-notice')
  panel.setAttribute('role', 'status')
  const text = element('span', 'progress-text', message)
  panel.append(element('span', 'progress-spinner'), text)
  return { element: panel, set(next: string) { text.textContent = next } }
}

/** Resolves once the browser has painted what is on screen now. */
export const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve)))

export function notice(message: string, error = false) {
  const panel = element('p', error ? 'notice notice-error' : 'notice', message)
  panel.setAttribute('role', error ? 'alert' : 'status')
  return panel
}
