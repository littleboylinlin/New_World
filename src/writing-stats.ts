import { locale, t } from './i18n'
import { libraryChanges, openDatabase, resultOf } from './library'
import { wordCount } from './documents/model'
import type { ChapterRecord } from './documents/model'
import { element } from './ui'
import { pop } from './motion'

export interface WritingDay {
  date: string
  words: number
}

const heatmapWeeks = 53

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount)
}

export function dayKey(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function parseDay(key: string) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

// Runs inside the chapter save transaction, so a day is credited only when the save actually commits.
export function recordWriting(days: IDBObjectStore, delta: number) {
  const key = dayKey(new Date())
  const request = days.get(key)
  request.onsuccess = () => {
    const existing = request.result as WritingDay | undefined
    days.put({ date: key, words: (existing?.words ?? 0) + delta })
  }
}

export async function readWritingDays() {
  const db = await openDatabase()
  const records: WritingDay[] = await resultOf(db.transaction('writingDays').objectStore('writingDays').getAll())
  return new Map(records.map((record) => [record.date, record.words]))
}

export async function totalLibraryWords() {
  const db = await openDatabase()
  const chapters: ChapterRecord[] = await resultOf(db.transaction('chapters').objectStore('chapters').getAll())
  return chapters.reduce((sum, chapter) => sum + wordCount(chapter.content), 0)
}

// A streak stays alive through today even before today's first save, then counts back over consecutive days.
export function currentStreak(days: Map<string, number>, today = new Date()) {
  let cursor = startOfDay(today)
  if (!(days.get(dayKey(cursor)) ?? 0)) cursor = addDays(cursor, -1)
  let streak = 0
  while ((days.get(dayKey(cursor)) ?? 0) > 0) {
    streak++
    cursor = addDays(cursor, -1)
  }
  return streak
}

function tag() {
  return locale === 'zh-CN' ? 'zh-CN' : 'en-US'
}

function numberOf(value: number) {
  return value.toLocaleString(tag())
}

function dateText(date: Date) {
  return new Intl.DateTimeFormat(tag(), { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
}

function levelOf(words: number, peak: number) {
  if (words <= 0 || peak <= 0) return 0
  return Math.max(1, Math.min(4, Math.ceil((words / peak) * 4)))
}

function dayPhrase(words: number) {
  return words > 0 ? t('writing.wroteWords', [numberOf(words)]) : t('writing.noWriting')
}

export function renderWritingStats(host: HTMLElement, signal: AbortSignal) {
  const panel = element('section', 'writing-stats')
  panel.setAttribute('aria-label', t('writing.title'))

  const heading = element('div', 'stats-heading')
  heading.append(element('span', 'eyebrow', t('writing.eyebrow')), element('h1', '', t('writing.title')))

  const numbers = element('div', 'stats-numbers')
  const streakValue = element('span', 'stat-value', '0')
  const totalValue = element('span', 'stat-value', '0')
  const streakCard = element('div', 'stat-card stat-streak')
  streakCard.append(streakValue, element('span', 'stat-label', t('writing.streakLabel')))
  const totalCard = element('div', 'stat-card stat-total')
  totalCard.append(totalValue, element('span', 'stat-label', t('writing.totalLabel')))
  numbers.append(streakCard, totalCard)

  const top = element('div', 'stats-top')
  top.append(heading, numbers)

  const heatmap = element('div', 'heatmap')
  const body = element('div', 'heatmap-body')
  const weekdays = element('div', 'heatmap-weekdays')
  const gridWrap = element('div', 'heatmap-grid-wrap')
  const scroll = element('div', 'heatmap-scroll')
  const months = element('div', 'heatmap-months')
  const grid = element('div', 'heatmap-grid')
  grid.setAttribute('role', 'group')
  grid.setAttribute('aria-label', t('writing.heatmapLabel'))
  scroll.append(months, grid)
  gridWrap.append(scroll)
  body.append(weekdays, gridWrap)

  const legend = element('div', 'heatmap-legend')
  legend.append(element('span', 'legend-end', t('writing.less')))
  for (let level = 0; level <= 4; level++) {
    const sample = element('span', 'heat-cell legend-cell')
    sample.dataset.level = String(level)
    sample.setAttribute('aria-hidden', 'true')
    legend.append(sample)
  }
  legend.append(element('span', 'legend-end', t('writing.more')))

  const tooltip = element('div', 'heat-tooltip')
  // Use the top layer, as reading annotations do, to escape desktop scroll-container clipping.
  tooltip.setAttribute('popover', 'manual')
  tooltip.setAttribute('aria-hidden', 'true')
  tooltip.hidden = true

  const hint = element('p', 'stats-hint', t('writing.emptyHint'))
  const statsFooter = element('div', 'stats-footer')
  statsFooter.append(hint, legend)

  heatmap.append(body, tooltip)
  panel.append(top, heatmap, statsFooter)
  host.append(panel)

  const today = startOfDay(new Date())
  const todayKey = dayKey(today)
  const dow = (today.getDay() + 6) % 7
  const firstMonday = addDays(today, -dow - (heatmapWeeks - 1) * 7)

  function weekdayLabel(date: Date) {
    return new Intl.DateTimeFormat(tag(), { weekday: 'short' }).format(date)
  }
  for (let row = 0; row < 7; row++) {
    weekdays.append(element('span', 'weekday', row % 2 === 0 ? weekdayLabel(addDays(firstMonday, row)) : ''))
  }

  let active: HTMLElement | undefined
  let pointer: { x: number; y: number } | undefined
  let tipSource: 'pointer' | 'focus' = 'pointer'
  let tipFrame = 0

  function setActive(node: HTMLElement) {
    if (active && active !== node) active.tabIndex = -1
    node.tabIndex = 0
    active = node
  }

  function cellAt(week: number, row: number) {
    if (week < 0 || week >= heatmapWeeks || row < 0 || row > 6) return undefined
    const node = grid.children[week * 7 + row] as HTMLElement | undefined
    return node && !node.classList.contains('future') ? node : undefined
  }

  function showTip(target: HTMLElement) {
    const key = target.dataset.date
    if (!key) return
    const view = window.visualViewport
    const viewport = { left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0, width: view?.width ?? innerWidth, height: view?.height ?? innerHeight }
    const cellRect = target.getBoundingClientRect()
    const gridRect = gridWrap.getBoundingClientRect()
    const pageRect = panel.closest('.page')?.getBoundingClientRect()
    // A focused date may have scrolled behind the desktop header or out of the horizontal grid.
    const leftEdge = Math.max(viewport.left, gridRect.left, pageRect?.left ?? viewport.left)
    const rightEdge = Math.min(viewport.left + viewport.width, gridRect.right, pageRect?.right ?? Infinity)
    const topEdge = Math.max(viewport.top, gridRect.top, pageRect?.top ?? viewport.top)
    const bottomEdge = Math.min(viewport.top + viewport.height, gridRect.bottom, pageRect?.bottom ?? Infinity)
    if (cellRect.right <= leftEdge || cellRect.left >= rightEdge || cellRect.bottom <= topEdge || cellRect.top >= bottomEdge) {
      hideTip()
      return
    }
    const words = Number(target.dataset.words ?? 0)
    const label = key === todayKey ? t('writing.today') : dateText(parseDay(key))
    const text = `${label} · ${dayPhrase(words)}`
    if (tooltip.textContent !== text) tooltip.textContent = text
    tooltip.style.maxWidth = `${Math.max(1, viewport.width - 16)}px`
    tooltip.hidden = false
    if (!tooltip.matches(':popover-open')) tooltip.showPopover()
    const { width, height } = tooltip.getBoundingClientRect()
    const half = width / 2
    const center = cellRect.left + cellRect.width / 2
    const left = Math.max(viewport.left + half + 8, Math.min(center, viewport.left + viewport.width - half - 8))
    const below = cellRect.top - height - 8 < viewport.top + 8
    const bottom = below ? cellRect.bottom + height + 8 : cellRect.top - 8
    tooltip.style.left = `${left}px`
    tooltip.style.top = `${Math.max(viewport.top + height + 8, Math.min(bottom, viewport.top + viewport.height - 8))}px`
    tooltip.dataset.side = below ? 'below' : 'above'
    // Clamp the body to the viewport while keeping the caret aimed at the date.
    const caret = Math.max(12, Math.min(center - (left - half), width - 12))
    tooltip.style.setProperty('--caret-x', `${caret}px`)
  }

  function hideTip() {
    if (tooltip.matches(':popover-open')) tooltip.hidePopover()
    tooltip.hidden = true
  }

  function updateTip() {
    tipFrame = 0
    if (signal.aborted || !panel.isConnected) return
    const focused = document.activeElement
    const target = tipSource === 'focus' && focused instanceof HTMLElement && grid.contains(focused) && focused.dataset.date
      ? focused
      : pointer ? document.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLElement>('.heat-cell[data-date]') : undefined
    if (!target || !grid.contains(target)) { hideTip(); return }
    showTip(target)
    // Entrance animations and the cell's hover transform move the anchor without scroll/resize events.
    for (let node: Element | null = target; !tooltip.hidden && node; node = node.parentElement) {
      if (node.getAnimations().some((animation) => animation.playState === 'running')) { scheduleTip(); break }
    }
  }

  function scheduleTip() {
    if (!tipFrame && !signal.aborted) tipFrame = requestAnimationFrame(updateTip)
  }

  function trackPointer(event: PointerEvent) {
    const moved = !pointer || pointer.x !== event.clientX || pointer.y !== event.clientY
    pointer = { x: event.clientX, y: event.clientY }
    if (moved) tipSource = 'pointer'
    scheduleTip()
  }
  grid.addEventListener('pointerover', trackPointer, { signal })
  grid.addEventListener('pointermove', trackPointer, { signal })
  grid.addEventListener('pointerout', scheduleTip, { signal })
  grid.addEventListener('pointerleave', () => { pointer = undefined; scheduleTip() }, { signal })
  grid.addEventListener('focusin', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.heat-cell:not(.future)')
    if (target) { setActive(target); tipSource = 'focus'; scheduleTip() }
  }, { signal })
  grid.addEventListener('focusout', scheduleTip, { signal })
  grid.addEventListener('keydown', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.heat-cell:not(.future)')
    if (!target) return
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    const next = cellAt(Number(target.dataset.week) + move[0], Number(target.dataset.row) + move[1])
    if (next) { setActive(next); next.focus() }
  }, { signal })
  // Re-read the cell under a stationary pointer after queued auto-scroll, manual scroll or layout changes.
  window.addEventListener('scroll', scheduleTip, { signal, passive: true, capture: true })
  window.addEventListener('resize', scheduleTip, { signal })
  window.visualViewport?.addEventListener('resize', scheduleTip, { signal })
  window.visualViewport?.addEventListener('scroll', scheduleTip, { signal, passive: true })
  signal.addEventListener('abort', () => { cancelAnimationFrame(tipFrame); hideTip() }, { once: true })

  function setValue(node: HTMLElement, value: string) {
    if (node.textContent !== value) {
      node.textContent = value
      pop(node)
    }
  }

  function paint(days: Map<string, number>, total: number) {
    let peak = 0
    for (const words of days.values()) peak = Math.max(peak, words)
    setValue(streakValue, numberOf(currentStreak(days, today)))
    setValue(totalValue, numberOf(total))
    hint.hidden = days.size > 0

    // Refresh values in place: replacing cells drops keyboard focus, hover state and the user's scroll position.
    if (grid.childElementCount) {
      for (const cell of grid.querySelectorAll<HTMLElement>('.heat-cell[data-date]')) {
        const key = cell.dataset.date!
        const words = days.get(key) ?? 0
        cell.dataset.words = String(words)
        cell.dataset.level = String(levelOf(words, peak))
        cell.setAttribute('aria-label', `${key === todayKey ? t('writing.today') : dateText(parseDay(key))} · ${dayPhrase(words)}`)
      }
      scheduleTip()
      return
    }
    months.replaceChildren()
    grid.replaceChildren()
    active = undefined
    let lastMonth = -1
    let todayCell: HTMLElement | undefined
    for (let week = 0; week < heatmapWeeks; week++) {
      const monday = addDays(firstMonday, week * 7)
      const monthTag = element('span', 'month')
      if (monday.getMonth() !== lastMonth) {
        monthTag.textContent = new Intl.DateTimeFormat(tag(), { month: 'short' }).format(monday)
        lastMonth = monday.getMonth()
      }
      months.append(monthTag)
      for (let row = 0; row < 7; row++) {
        const date = addDays(monday, row)
        const key = dayKey(date)
        const words = days.get(key) ?? 0
        const future = date > today
        const cellNode = element('span', future ? 'heat-cell future' : 'heat-cell')
        cellNode.dataset.level = String(future ? 0 : levelOf(words, peak))
        cellNode.dataset.week = String(week)
        cellNode.dataset.row = String(row)
        if (future) {
          cellNode.setAttribute('aria-hidden', 'true')
        } else {
          cellNode.dataset.date = key
          cellNode.dataset.words = String(words)
          cellNode.tabIndex = -1
          const label = key === todayKey ? t('writing.today') : dateText(date)
          cellNode.setAttribute('aria-label', `${label} · ${dayPhrase(words)}`)
          if (key === todayKey) { todayCell = cellNode; cellNode.classList.add('today') }
        }
        grid.append(cellNode)
      }
    }
    const fallback = grid.querySelector<HTMLElement>('.heat-cell:not(.future)')
    const initial = todayCell ?? fallback
    if (initial) setActive(initial)
    gridWrap.scrollLeft = gridWrap.scrollWidth
  }

  let requestNumber = 0
  async function refresh() {
    const current = ++requestNumber
    try {
      const [days, total] = await Promise.all([readWritingDays(), totalLibraryWords()])
      if (!signal.aborted && current === requestNumber) paint(days, total)
    } catch {
      if (!signal.aborted && current === requestNumber) panel.hidden = true
    }
  }
  libraryChanges.addEventListener('update', () => void refresh(), { signal })
  window.addEventListener('focus', () => void refresh(), { signal })
  void refresh()
}
