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
  heading.append(element('span', 'eyebrow', t('writing.eyebrow')), element('h2', '', t('writing.title')))

  const numbers = element('div', 'stats-numbers')
  const streakValue = element('span', 'stat-value', '0')
  const totalValue = element('span', 'stat-value', '0')
  const streakCard = element('div', 'stat-card stat-streak')
  streakCard.append(streakValue, element('span', 'stat-label', t('writing.streakLabel')))
  const totalCard = element('div', 'stat-card stat-total')
  totalCard.append(totalValue, element('span', 'stat-label', t('writing.totalLabel')))
  numbers.append(streakCard, totalCard)

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
  tooltip.setAttribute('aria-hidden', 'true')
  tooltip.hidden = true

  const hint = element('p', 'stats-hint', t('writing.emptyHint'))

  heatmap.append(body, legend, tooltip)
  panel.append(heading, numbers, heatmap, hint)
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
    const words = Number(target.dataset.words ?? 0)
    const label = key === todayKey ? t('writing.today') : dateText(parseDay(key))
    tooltip.textContent = `${label} · ${dayPhrase(words)}`
    tooltip.hidden = false
    const heatRect = heatmap.getBoundingClientRect()
    const cellRect = target.getBoundingClientRect()
    const width = tooltip.getBoundingClientRect().width
    const half = width / 2
    const center = cellRect.left - heatRect.left + cellRect.width / 2
    const left = Math.max(half + 2, Math.min(center, heatRect.width - half - 2))
    tooltip.style.left = `${left}px`
    tooltip.style.top = `${cellRect.top - heatRect.top - 8}px`
    // The body clamps at the container edges, so the caret keeps pointing at the cell independently.
    const caret = Math.max(12, Math.min(center - (left - half), width - 12))
    tooltip.style.setProperty('--caret-x', `${caret}px`)
  }

  function hideTip() {
    tooltip.hidden = true
  }

  grid.addEventListener('pointerover', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.heat-cell:not(.future)')
    if (target) showTip(target)
  }, { signal })
  grid.addEventListener('pointerout', (event) => {
    const target = (event.target as HTMLElement).closest('.heat-cell')
    if (target && !target.contains(event.relatedTarget as Node)) hideTip()
  }, { signal })
  grid.addEventListener('focusin', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.heat-cell:not(.future)')
    if (target) { setActive(target); showTip(target) }
  }, { signal })
  grid.addEventListener('focusout', hideTip, { signal })
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
  gridWrap.addEventListener('scroll', hideTip, { signal, passive: true })

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