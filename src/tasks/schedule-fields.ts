import { locale, t } from '../i18n'
import { button, element } from '../ui'
import { addDays, dateKey } from './model'
import type { Task, TaskRepeat } from './model'

const key = (name: string) => t('tasks.' + name)
const legacyValue = '__legacy__'

const weekdayFormatter = () => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })

function shortWeekday(day: number) {
  return weekdayFormatter().format(new Date(Date.UTC(2026, 10, 15 + day)))
}

/** True when a repeat rule uses complex options cut from the UI (monthly/yearly/interval>1/until). */
export function isLegacyRepeat(repeat: TaskRepeat | undefined): boolean {
  if (!repeat) return false
  if (repeat.frequency !== 'day' && repeat.frequency !== 'week') return true
  if (repeat.interval !== 1) return true
  if (repeat.until) return true
  if (repeat.monthDays?.length) return true
  return false
}

/** Human-readable compact summary of any repeat rule (simple or preserved legacy). */
export function describeRepeat(repeat: TaskRepeat): string {
  const parts: string[] = []
  if (repeat.interval === 1) {
    parts.push(key('repeat.' + repeat.frequency))
  } else {
    parts.push(t('tasks.repeatEveryN', [repeat.interval, key('unit.' + repeat.frequency)]))
  }
  if (repeat.frequency === 'week' && repeat.weekdays?.length) {
    const names = [...repeat.weekdays].sort((a, b) => a - b).map(shortWeekday)
    parts.push(names.join('·'))
  }
  if (repeat.until) parts.push(t('tasks.repeatUntilShort', [repeat.until]))
  return parts.join(' ')
}

/** Compact date + simple daily/weekly repeat controls; preserves legacy complex repeat rules untouched. */
export function taskScheduleControls(initial: Partial<Task>, onChange?: () => void) {
  const wrap = element('div', 'task-schedule-controls')

  // Date quick-pills + native calendar input
  const dateRow = element('div', 'task-date-row')
  const dateInput = element('input', 'title-input task-date-input')
  dateInput.type = 'date'
  dateInput.value = initial.planDate ?? ''
  dateInput.setAttribute('aria-label', key('date'))

  const quickDates = element('div', 'task-date-pills')
  const todayBtn = button(key('setToday'), 'task-pill-btn')
  const tomorrowBtn = button(key('setTomorrow'), 'task-pill-btn')
  const clearBtn = button(key('clearDate'), 'task-pill-btn')
  const syncPills = () => {
    const today = dateKey()
    const tomorrow = addDays(today, 1)
    todayBtn.setAttribute('aria-pressed', String(dateInput.value === today))
    tomorrowBtn.setAttribute('aria-pressed', String(dateInput.value === tomorrow))
    clearBtn.hidden = !dateInput.value
  }
  todayBtn.addEventListener('click', () => {
    dateInput.value = dateKey()
    syncPills()
    onChange?.()
  })
  tomorrowBtn.addEventListener('click', () => {
    dateInput.value = addDays(dateKey(), 1)
    syncPills()
    onChange?.()
  })
  clearBtn.addEventListener('click', () => {
    dateInput.value = ''
    if (repeatSelect.value) {
      repeatSelect.value = ''
      syncRepeat()
    }
    syncPills()
    onChange?.()
  })
  dateInput.addEventListener('change', () => {
    if (!dateInput.value && repeatSelect.value) {
      repeatSelect.value = ''
      syncRepeat()
    }
    syncPills()
    onChange?.()
  })
  quickDates.append(todayBtn, tomorrowBtn, clearBtn)
  dateRow.append(dateInput, quickDates)

  // Simple repeat selector: none / daily / weekly (+ preserved legacy rule option if present)
  const repeatRow = element('div', 'task-repeat-row')
  const repeatSelect = element('select', 'editor-select task-repeat-select')
  repeatSelect.setAttribute('aria-label', key('repeat'))
  const legacy = isLegacyRepeat(initial.repeat)
  const options: [string, string][] = [
    ['', key('noRepeat')],
    ['day', key('repeat.day')],
    ['week', key('repeat.week')],
    ...(legacy && initial.repeat ? [[legacyValue, t('tasks.repeatLegacy', [describeRepeat(initial.repeat)])] as [string, string]] : []),
  ]
  for (const [val, text] of options) {
    const opt = element('option', '', text)
    opt.value = val
    repeatSelect.append(opt)
  }
  repeatSelect.value = legacy ? legacyValue : (initial.repeat?.frequency ?? '')

  // 7-day pills (Sun–Sat, ordered Mon..Sun for natural reading while preserving 0=Sun..6=Sat indices)
  const weekdays = element('div', 'task-weekdays')
  weekdays.setAttribute('role', 'group')
  weekdays.setAttribute('aria-label', key('weekdays'))
  const dayOrder = [1, 2, 3, 4, 5, 6, 0]
  const dayChecks = new Map<number, HTMLInputElement>()
  for (const day of dayOrder) {
    const pill = element('label', 'task-weekday-pill')
    const box = element('input')
    box.type = 'checkbox'
    box.checked = initial.repeat?.frequency === 'week' && (initial.repeat.weekdays?.includes(day) ?? false)
    pill.classList.toggle('is-checked', box.checked)
    box.addEventListener('change', () => {
      pill.classList.toggle('is-checked', box.checked)
      onChange?.()
    })
    pill.append(box, element('span', '', shortWeekday(day)))
    weekdays.append(pill)
    dayChecks.set(day, box)
  }
  const legacyNote = element('p', 'task-legacy-note', key('repeatLegacyHint'))
  const syncRepeat = () => {
    weekdays.hidden = repeatSelect.value !== 'week'
    legacyNote.hidden = repeatSelect.value !== legacyValue
  }
  repeatSelect.addEventListener('change', () => {
    if (repeatSelect.value && !dateInput.value) {
      dateInput.value = initial.planDate ?? dateKey()
      syncPills()
    }
    syncRepeat()
    onChange?.()
  })
  repeatRow.append(repeatSelect, weekdays, legacyNote)

  syncPills()
  syncRepeat()
  wrap.append(dateRow, repeatRow)

  return {
    element: wrap,
    dateInput,
    repeatSelect,
    read(): { planDate: string | null; repeat: TaskRepeat | undefined } {
      const mode = repeatSelect.value
      if (!mode) {
        return { planDate: dateInput.value || null, repeat: undefined }
      }
      const planDate = dateInput.value || initial.planDate || dateKey()
      if (mode === legacyValue && initial.repeat) {
        const preserved = structuredClone(initial.repeat)
        if (preserved.anchorDate > planDate) preserved.anchorDate = planDate
        return { planDate, repeat: preserved }
      }
      const frequency = mode as 'day' | 'week'
      const anchorDate =
        initial.repeat?.anchorDate &&
        initial.repeat.frequency === frequency &&
        initial.repeat.interval === 1 &&
        initial.repeat.anchorDate <= planDate
          ? initial.repeat.anchorDate
          : planDate
      const rule: TaskRepeat = { frequency, interval: 1, anchorDate }
      if (frequency === 'week') {
        const chosen = [...dayChecks.entries()].filter(([, box]) => box.checked).map(([day]) => day).sort((a, b) => a - b)
        if (chosen.length) rule.weekdays = chosen
      }
      return { planDate, repeat: rule }
    },
  }
}
