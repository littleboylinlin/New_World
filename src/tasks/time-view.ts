import { t, locale } from '../i18n'
import { element, button } from '../ui'
import { choices, field } from './forms'
import { localZone, parseTaskDate, scheduleInstant, zonedDate } from './model'
import type { Task, TaskRepeat } from './model'

export function taskTimeFields(
  initial: Partial<Task>,
  title: HTMLInputElement | HTMLTextAreaElement,
  date: HTMLInputElement | HTMLTextAreaElement,
) {
  const key = (name: string) => t('tasks.' + name)
  const time = field(key('time'), 'time', initial.planTime ?? ''),
    zone = field(key('zone'), 'text', initial.zone ?? localZone())
  const fold = choices(
    key('fold'),
    [
      ['earlier', key('earlier')],
      ['later', key('later')],
    ],
    initial.fold ?? 'earlier',
  )
  const deadline = field(key('deadline'), 'date', initial.deadline ?? ''),
    duration = field(key('duration'), 'number', String(initial.durationMinutes ?? ''))
  const repeat = choices(
    key('repeat'),
    [
      ['', key('noRepeat')],
      ...['day', 'week', 'month', 'year'].map((f) => [f, key('repeat.' + f)] as [string, string]),
    ],
    initial.repeat?.frequency ?? '',
  )
  const interval = field(key('interval'), 'number', String(initial.repeat?.interval ?? 1)),
    until = field(key('until'), 'date', initial.repeat?.until ?? '')
  const days = field(key('monthDays'), 'text', initial.repeat?.monthDays?.join(',') ?? '')
  const weekdays = element('fieldset', 'task-label-picks'),
    picks: HTMLInputElement[] = []
  weekdays.append(element('legend', '', key('weekdays')))
  for (let day = 0; day < 7; day++) {
    const label = element('label'),
      input = element('input')
    input.type = 'checkbox'
    input.checked = initial.repeat?.weekdays?.includes(day) ?? false
    label.append(
      input,
      document.createTextNode(
        new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
          new Date(Date.UTC(2026, 10, 15 + day)),
        ),
      ),
    )
    weekdays.append(label)
    picks.push(input)
  }
  const reminder = choices(
    key('reminder'),
    [
      ['', key('noReminder')],
      ...[0, 5, 15, 60, 1440].map(
        (n) => [String(n), t('tasks.beforeMinutes', [n])] as [string, string],
      ),
    ],
    initial.reminderMinutes === undefined ? '' : String(initial.reminderMinutes),
  )
  if (
    initial.reminderMinutes !== undefined &&
    ![0, 5, 15, 60, 1440].includes(initial.reminderMinutes)
  ) {
    const option = element('option', '', t('tasks.beforeMinutes', [initial.reminderMinutes]))
    option.value = String(initial.reminderMinutes)
    reminder.input.append(option)
    reminder.input.value = option.value
  }
  const hint = element('p', 'dialog-help', key('scheduleHint')),
    resolved = element('p', 'dialog-help')
  const refresh = () => {
    weekdays.hidden = repeat.input.value !== 'week'
    days.wrapper.hidden = repeat.input.value !== 'month'
    interval.wrapper.hidden = until.wrapper.hidden = !repeat.input.value
    try {
      const stamp = scheduleInstant({
        planDate: date.value || null,
        planTime: time.input.value || undefined,
        zone: zone.input.value,
        fold: fold.input.value as 'earlier' | 'later',
      })
      resolved.textContent =
        stamp === null
          ? ''
          : new Date(stamp).toLocaleString(locale, { timeZone: zone.input.value }) +
            ' · ' +
            zone.input.value +
            (zone.input.value !== localZone()
              ? ' → ' + new Date(stamp).toLocaleString(locale) + ' · ' + localZone()
              : '')
    } catch {
      resolved.textContent = key('invalidTime')
    }
  }
  for (const input of [date, time.input, zone.input, fold.input, repeat.input])
    input.addEventListener('change', refresh)
  refresh()
  const natural = element('div', 'task-natural'),
    parse = button(key('parseDate'), 'button button-quiet button-small'),
    apply = button(key('applyDate'), 'button button-quiet button-small'),
    preview = element('p', 'dialog-help')
  let proposal: ReturnType<typeof parseTaskDate> = null
  apply.hidden = true
  parse.addEventListener('click', () => {
    try {
      proposal = parseTaskDate(
        title.value,
        new Date(zonedDate(Date.now(), zone.input.value) + 'T12:00:00'),
      )
    } catch {
      proposal = null
    }
    apply.hidden = !proposal
    preview.textContent = proposal
      ? t('tasks.dateProposal', [
          proposal.date,
          proposal.time ?? '',
          proposal.repeat ? key('repeat.' + proposal.repeat.frequency) : '',
        ])
      : key('noDateParsed')
  })
  apply.addEventListener('click', () => {
    if (!proposal) return
    date.value = proposal.date
    time.input.value = proposal.time ?? ''
    repeat.input.value = proposal.repeat?.frequency ?? ''
    interval.input.value = String(proposal.repeat?.interval ?? 1)
    picks.forEach((p, i) => (p.checked = proposal?.repeat?.weekdays?.includes(i) ?? false))
    days.input.value = proposal.repeat?.monthDays?.join(',') ?? ''
    refresh()
    apply.hidden = true
  })
  natural.append(parse, preview, apply)
  return {
    fields: [
      natural,
      time.wrapper,
      zone.wrapper,
      fold.wrapper,
      resolved,
      deadline.wrapper,
      duration.wrapper,
      repeat.wrapper,
      interval.wrapper,
      weekdays,
      days.wrapper,
      until.wrapper,
      reminder.wrapper,
      hint,
    ],
    read(): Partial<Task> {
      let rule: TaskRepeat | undefined
      if (repeat.input.value) {
        const frequency = repeat.input.value as TaskRepeat['frequency']
        rule = {
          frequency,
          interval: Number(interval.input.value),
          anchorDate:
            initial.repeat?.anchorDate &&
            initial.repeat.frequency === frequency &&
            Number(interval.input.value) === initial.repeat.interval &&
            initial.repeat.anchorDate <= date.value
              ? initial.repeat.anchorDate
              : date.value,
        }
        if (frequency === 'week') {
          const chosen = picks.flatMap((p, i) => (p.checked ? [i] : []))
          if (chosen.length) rule.weekdays = chosen
        }
        if (frequency === 'month' && days.input.value.trim())
          rule.monthDays = days.input.value
            .split(/[,，\s]+/)
            .filter(Boolean)
            .map(Number)
        if (until.input.value) rule.until = until.input.value
      }
      return {
        planTime: time.input.value || undefined,
        zone: zone.input.value || undefined,
        fold: fold.input.value as 'earlier' | 'later',
        deadline: deadline.input.value || undefined,
        durationMinutes: duration.input.value === '' ? undefined : Number(duration.input.value),
        repeat: rule,
        reminderMinutes: reminder.input.value === '' ? undefined : Number(reminder.input.value),
      }
    },
  }
}
