import test from 'node:test'
import assert from 'node:assert/strict'
import {
  nextOccurrence,
  wallTimes,
  scheduleInstant,
  parseTaskDate,
  validateSchedule,
  matchesFilter,
} from '../../src/tasks/model.ts'
const task = (date, repeat) => ({
  planDate: date,
  zone: 'UTC',
  repeat: { frequency: 'day', interval: 1, anchorDate: date, ...repeat },
})
const at = (date) => Date.parse(date + 'T12:00Z')
test('anchored recurrence handles overdue, intervals, weekdays, month ends, leap years and inclusive ends', () => {
  assert.equal(nextOccurrence(task('2026-01-01', { interval: 3 }), at('2026-01-09')), '2026-01-10')
  assert.equal(
    nextOccurrence(
      task('2026-01-05', { frequency: 'week', interval: 2, weekdays: [1, 4] }),
      at('2026-01-08'),
    ),
    '2026-01-19',
  )
  const monthly = task('2026-01-31', { frequency: 'month' })
  assert.equal(nextOccurrence(monthly, at('2026-01-31')), '2026-02-28')
  monthly.planDate = '2026-02-28'
  assert.equal(nextOccurrence(monthly, at('2026-02-28')), '2026-03-31')
  assert.equal(
    nextOccurrence(task('2028-02-29', { frequency: 'year' }), at('2028-02-29')),
    '2029-02-28',
  )
  assert.equal(
    nextOccurrence(
      task('2026-01-05', { frequency: 'month', monthDays: [5, 20] }),
      at('2026-01-05'),
    ),
    '2026-01-20',
  )
  assert.equal(
    nextOccurrence(task('2026-01-01', { until: '2026-01-02' }), at('2026-01-01')),
    '2026-01-02',
  )
  assert.equal(nextOccurrence(task('2026-01-01', { until: '2026-01-02' }), at('2026-01-02')), null)
  assert.equal(nextOccurrence({ planDate: '2026-01-01' }, at('2026-01-01')), null)
})
test('IANA time zones reject DST gaps and explicitly select both overlap folds', () => {
  assert.deepEqual(wallTimes('2026-03-08', '02:30', 'America/New_York'), [])
  const folds = wallTimes('2026-11-01', '01:30', 'America/New_York')
  assert.equal(folds.length, 2)
  assert.equal(folds[1] - folds[0], 3600000)
  const scheduled = { planDate: '2026-11-01', planTime: '01:30', zone: 'America/New_York' }
  assert.equal(scheduleInstant(scheduled), folds[0])
  assert.equal(scheduleInstant({ ...scheduled, fold: 'later' }), folds[1])
  assert.throws(() => validateSchedule({ ...scheduled, planDate: '2026-03-08', planTime: '02:30' }))
  assert.equal(
    new Date(
      scheduleInstant({ planDate: '2026-01-01', planTime: '00:30', zone: 'Asia/Shanghai' }),
    ).toISOString(),
    '2025-12-31T16:30:00.000Z',
  )
})
test('Chinese and English date proposals are conservative and keep the source text', () => {
  const now = new Date(2026, 0, 30, 12)
  assert.equal(parseTaskDate('写作 明天下午三点', now).time, '15:00')
  assert.equal(parseTaskDate('明天下午三点', now).date, '2026-01-31')
  assert.deepEqual(parseTaskDate('每周一', now).repeat.weekdays, [1])
  assert.equal(parseTaskDate('下个月 5 号', now).date, '2026-02-05')
  assert.equal(parseTaskDate('day after tomorrow at 3pm', now).date, '2026-02-01')
  assert.equal(parseTaskDate('every 2 weeks', now).repeat.interval, 2)
  assert.equal(parseTaskDate('every week', now).repeat.frequency, 'week')
  for (const text of ['下个月31号', 'tomorrow at 3', '今天明天', 'someday', '明天 25点'])
    assert.equal(parseTaskDate(text, now), null)
})
test('nested filters combine typed conditions without evaluating code', () => {
  const task = {
    title: '写第三章',
    description: '动机',
    notes: '',
    projectId: null,
    labelIds: [],
    priority: 1,
    completedAt: null,
    deletedAt: null,
    planDate: '2026-01-02',
  }
  assert.equal(
    matchesFilter(task, {
      operator: 'all',
      conditions: [
        { field: 'priority', op: 'is', value: '1' },
        {
          operator: 'any',
          conditions: [
            { field: 'text', op: 'is', value: '第三' },
            { field: 'date', op: 'before', value: '2026-01-01' },
          ],
        },
      ],
    }),
    true,
  )
  assert.equal(
    matchesFilter(task, {
      operator: 'any',
      conditions: [
        { field: 'state', op: 'is', value: 'completed' },
        { field: 'priority', op: 'not', value: '1' },
      ],
    }),
    false,
  )
})
test('conservative clock parsing avoids ambiguous Chinese midnight and conflicting times', () => {
  const now = new Date(2026, 0, 1, 12)
  assert.equal(parseTaskDate('明天下午三点半', now).time, '15:30')
  assert.equal(parseTaskDate('明天中午十一点', now).time, '11:00')
  assert.equal(parseTaskDate('明天凌晨十二点', now).time, '00:00')
  for (const input of [
    '明天晚上十二点',
    '明天晚上三点',
    'tomorrow 25:99',
    'tomorrow 3pm 4pm',
    'daily monthly',
  ])
    assert.equal(parseTaskDate(input, now), null)
  assert.doesNotThrow(() =>
    validateSchedule({ planDate: '9999-12-31', planTime: '12:00', zone: 'UTC' }),
  )
})
test('calendar dragging aligns the device day while retaining the scheduled time in another zone', async () => {
  const { planDateForLocalDay, scheduleDay } = await import('../../src/tasks/model.ts'),
    previous = process.env.TZ
  process.env.TZ = 'UTC'
  try {
    const timed = { planDate: '2026-11-17', planTime: '00:30', zone: 'Asia/Shanghai' }
    assert.equal(scheduleDay(timed), '2026-11-16')
    const target = planDateForLocalDay(timed, '2026-11-20')
    assert.equal(target, '2026-11-21')
    assert.equal(scheduleDay({ ...timed, planDate: target }), '2026-11-20')
    assert.equal(planDateForLocalDay({ planDate: '2026-01-01' }, '2026-11-20'), '2026-11-20')
    assert.throws(() =>
      planDateForLocalDay(
        { planDate: '2026-03-07', planTime: '02:30', zone: 'America/New_York' },
        '2026-03-08',
      ),
    )
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})
