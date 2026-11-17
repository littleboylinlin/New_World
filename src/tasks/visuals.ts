import { t, locale } from '../i18n'
import { element, button } from '../ui'
import { showNotice } from '../undo'
import { storageError } from '../library'
import { addDays, dateKey, scheduleDay, planDateForLocalDay } from './model'
import type { Task, TaskData, TaskView } from './model'
import { editTask, moveTasks } from './store'

const key = (name: string) => t('tasks.' + name)
export const taskMime = 'application/x-newworld-task'
function drop(target: HTMLElement, action: (id: string) => Promise<unknown>) {
  target.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes(taskMime)) e.preventDefault()
  })
  target.addEventListener('drop', (e) => {
    const id = e.dataTransfer?.getData(taskMime)
    if (!id) return
    e.preventDefault()
    e.stopPropagation()
    void action(id).catch((e) => showNotice(storageError(e)))
  })
}
/** Views receive the same persisted records. Only explicit store actions mutate them. */
export function taskVisuals(
  data: TaskData,
  tasks: Task[],
  view: TaskView,
  projectId: string | null,
  row: (task: Task, flat?: boolean) => HTMLElement,
  calendarDate: string,
  changeDate: (date: string) => void,
) {
  const body = element('div', 'task-visuals task-' + view.mode)
  const flat = (task: Task) => {
    const list = element('ul', 'task-list')
    list.append(row(task, true))
    return list
  }
  if (view.mode === 'board') {
    const sections = projectId
      ? [
          { id: null, name: key('unsectioned') },
          ...data.taskSections
            .filter(
              (s) =>
                s.projectId === projectId &&
                (s.deletedAt === null || tasks.some((t) => t.sectionId === s.id)),
            )
            .sort((a, b) => a.order - b.order),
        ]
      : [
          { id: null, name: key('inbox') },
          ...data.taskProjects
            .filter((p) => p.deletedAt === null || tasks.some((t) => t.projectId === p.id))
            .map((p) => ({ id: p.id, name: p.name })),
        ]
    for (const section of sections) {
      const column = element('section', 'task-board-column')
      column.dataset.sectionId = section.id ?? ''
      column.append(element('h3', '', section.name))
      drop(column, (id) => moveTasks([id], projectId ?? section.id, projectId ? section.id : null))
      for (const task of tasks.filter(
        (task) => (projectId ? task.sectionId : task.projectId) === section.id,
      ))
        column.append(flat(task))
      body.append(column)
    }
  } else if (view.mode === 'table') {
    const table = element('table', 'task-table'),
      head = element('tr')
    for (const name of ['title', 'project', 'section', 'priority', 'date', 'deadline', 'duration'])
      head.append(element('th', '', key(name)))
    table.append(head)
    for (const task of tasks) {
      const tr = element('tr')
      const cell = element('td')
      cell.append(flat(task))
      tr.append(cell)
      for (const value of [
        data.taskProjects.find((p) => p.id === task.projectId)?.name ?? key('inbox'),
        data.taskSections.find((s) => s.id === task.sectionId)?.name ?? '',
        `P${task.priority}`,
        `${task.planDate ?? ''} ${task.planTime ?? ''}`,
        task.deadline ?? '',
        task.durationMinutes === undefined ? '' : String(task.durationMinutes),
      ])
        tr.append(element('td', '', value))
      table.append(tr)
    }
    body.append(table)
  } else {
    const pivot = new Date(calendarDate + 'T12:00:00Z'),
      week = view.calendar === 'week'
    const start = week
      ? addDays(calendarDate, -((pivot.getUTCDay() + 6) % 7))
      : addDays(
          calendarDate.slice(0, 8) + '01',
          -((new Date(calendarDate.slice(0, 8) + '01T12:00Z').getUTCDay() + 6) % 7),
        )
    const toolbar = element('div', 'task-toolbar'),
      previous = button('‹', 'button button-quiet'),
      next = button('›', 'button button-quiet'),
      today = button(key('today'), 'button button-quiet')
    const shift = (direction: number) => {
      if (week) changeDate(addDays(calendarDate, 7 * direction))
      else {
        const d = new Date(calendarDate.slice(0, 8) + '01T12:00Z')
        d.setUTCMonth(d.getUTCMonth() + direction)
        changeDate(d.toISOString().slice(0, 10))
      }
    }
    previous.setAttribute('aria-label', key('previousPeriod'))
    next.setAttribute('aria-label', key('nextPeriod'))
    previous.onclick = () => shift(-1)
    next.onclick = () => shift(1)
    today.onclick = () => changeDate(dateKey())
    toolbar.append(
      previous,
      element(
        'strong',
        '',
        new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(
          pivot,
        ),
      ),
      next,
      today,
    )
    body.append(toolbar)
    body.append(element('p', 'dialog-help', key('calendarHint')))
    const grid = element('div', 'task-calendar-grid')
    for (let i = 0; i < (week ? 7 : 42); i++) {
      const date = addDays(start, i),
        cell = element('section', 'task-calendar-day')
      cell.dataset.date = date
      cell.append(
        element(
          'h3',
          '',
          new Intl.DateTimeFormat(locale, {
            month: 'short',
            day: 'numeric',
            weekday: 'short',
            timeZone: 'UTC',
          }).format(new Date(date + 'T12:00Z')),
        ),
      )
      if (date === dateKey()) cell.classList.add('is-today')
      drop(cell, async (id) => {
        const task = data.tasks.find((t) => t.id === id)
        if (task) await editTask(id, task.revision, { planDate: planDateForLocalDay(task, date) })
      })
      for (const task of tasks.filter((t) => scheduleDay(t) === date)) cell.append(flat(task))
      grid.append(cell)
    }
    body.append(grid)
    const undated = tasks.filter((t) => !t.planDate)
    if (undated.length) {
      body.append(element('h3', '', key('undated')))
      for (const task of undated) body.append(flat(task))
    }
  }
  return body
}
