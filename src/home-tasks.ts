import { locale, t } from './i18n'
import { button, element, icon, link, notice } from './ui'
import { storageError } from './library'
import { listEditions } from './documents/store'
import { stagger } from './motion'
import { offerActionUndo, showNotice } from './undo'
import { addDays, dateKey, scheduleDay, scheduleInstant } from './tasks/model'
import type { Task, TaskData } from './tasks/model'
import { completeTasks, readTasks, taskChanges, undoTaskChange } from './tasks/store'
import { openTaskLink } from './tasks/links'
import { taskDialog } from './tasks/view'

/** How many tasks the home card lists before it points to the task page. */
export const homeTaskLimit = 8
/** How far ahead the card looks for due dates and reminders. */
const lookAhead = 7

type Group = 'overdue' | 'today' | 'soon'
interface Entry { task: Task; group: Group; at: number; reminder: number | null }

/** The moment a task is due: its scheduled time, or the end of its planned day. */
function dueAt(task: Task) {
  try {
    const instant = scheduleInstant(task)
    if (instant !== null) return instant
  } catch { /* A wall time that does not exist falls back to its day. */ }
  return task.planDate ? new Date(`${task.planDate}T23:59:59`).getTime() : null
}

function archivedProjects(data: TaskData) {
  const archived = new Set<string>()
  const isArchived = (id: string | null, depth = 0): boolean => {
    if (!id || depth > 32) return false
    const project = data.taskProjects.find((item) => item.id === id)
    return Boolean(project && (project.archivedAt !== null || isArchived(project.parentId, depth + 1)))
  }
  for (const project of data.taskProjects) if (isArchived(project.id)) archived.add(project.id)
  return archived
}

/**
 * Open tasks that are overdue, due today, due within a week, or whose reminder falls within a
 * week, soonest first. Tasks in archived projects stay out, as on the task page.
 */
export function homeTasks(data: TaskData, now = Date.now()): Entry[] {
  const today = dateKey(new Date(now))
  const horizon = addDays(today, lookAhead)
  const archived = archivedProjects(data)
  const entries: Entry[] = []
  for (const task of data.tasks) {
    if (task.deletedAt !== null || task.completedAt !== null) continue
    if (task.projectId && archived.has(task.projectId)) continue
    let day: string | null = null
    try { day = scheduleDay(task) } catch { day = task.planDate }
    const due = dueAt(task)
    const reminder = task.reminderMinutes !== undefined && due !== null && task.planTime ? due - task.reminderMinutes * 60000 : null
    const late = (task.planTime ? due !== null && due < now : day !== null && day < today) || Boolean(task.deadline && task.deadline < today)
    let group: Group | undefined
    if (late) group = 'overdue'
    else if (day === today || task.deadline === today) group = 'today'
    else if ((day && day <= horizon) || (task.deadline && task.deadline <= horizon) || (reminder !== null && reminder <= now + lookAhead * 86400000)) group = 'soon'
    if (!group) continue
    const deadlineAt = task.deadline ? new Date(`${task.deadline}T23:59:59`).getTime() : Infinity
    entries.push({ task, group, at: Math.min(due ?? Infinity, deadlineAt), reminder })
  }
  const order: Record<Group, number> = { overdue: 0, today: 1, soon: 2 }
  return entries.sort((a, b) => order[a.group] - order[b.group] || a.at - b.at || a.task.priority - b.task.priority || a.task.order - b.task.order)
}

function when(entry: Entry) {
  const { task } = entry
  const parts: string[] = []
  if (task.planDate) {
    const date = new Date(`${task.planDate}T00:00:00`)
    parts.push(date.toLocaleDateString(locale, { month: 'short', day: 'numeric', weekday: 'short' }))
    if (task.planTime) parts.push(task.planTime)
  }
  if (task.deadline) parts.push(t('home.deadline', [task.deadline]))
  return parts.join(' · ')
}

/** Chapter titles of the works the listed tasks point at, so a row can say where it leads. */
async function chapterTitles(entries: Entry[]) {
  const titles = new Map<string, string>()
  const works = new Map<string, { library: 'original' | 'reference'; bookId: string }>()
  for (const { task } of entries) {
    if (task.link?.chapterId && !task.link.unconfirmed) works.set(task.link.library + ':' + task.link.bookId, task.link)
  }
  await Promise.all([...works.values()].map(async ({ library, bookId }) => {
    try {
      for (const edition of await listEditions(library, bookId))
        for (const chapter of edition.chapters) titles.set(`${library}:${bookId}:${edition.id}:${chapter.id}`, chapter.title)
    } catch { /* The row still names the work. */ }
  }))
  return titles
}

/**
 * The home page's "Reminders and tasks" card: what is overdue, due today or coming up within a
 * week. A row opens the linked work at its chapter and passage, or the task's details; its box
 * completes the task, which can be undone from the notice.
 */
export function renderHomeTasks(signal: AbortSignal) {
  const card = element('section', 'home-tasks')
  card.setAttribute('aria-labelledby', 'home-tasks-title')
  const head = element('div', 'home-tasks-head')
  const title = element('h2', '', t('home.tasksTitle'))
  title.id = 'home-tasks-title'
  const all = link('#/notes/tasks/today', t('home.allTasks'), 'home-tasks-all')
  head.append(title, all)
  const body = element('div', 'home-tasks-body')
  card.append(head, body)

  let data: TaskData | undefined
  let request = 0
  let shown = false
  const leaving = new Set<string>()

  function row(entry: Entry, titles: Map<string, string>) {
    const { task } = entry
    const item = element('li', `home-task home-task-${entry.group}`)
    item.dataset.taskId = task.id
    const check = button('', 'home-task-check')
    check.setAttribute('role', 'checkbox')
    check.setAttribute('aria-checked', 'false')
    check.setAttribute('aria-label', t('home.completeTask', [task.title]))
    check.append(icon('check'))
    check.addEventListener('click', () => {
      if (leaving.has(task.id)) return
      leaving.add(task.id)
      check.setAttribute('aria-checked', 'true')
      item.classList.add('done')
      void completeTasks([task.id], true, { id: task.id, revision: task.revision })
        .then(() => offerActionUndo(t('home.taskDone', [task.title]), () => undoTaskChange()))
        .catch((error) => {
          item.classList.remove('done')
          check.setAttribute('aria-checked', 'false')
          showNotice(storageError(error))
        })
        .finally(() => { leaving.delete(task.id) })
    })

    const open = button('', 'home-task-open')
    const name = element('span', 'home-task-title', task.title)
    const meta = element('span', 'home-task-meta')
    const date = when(entry)
    if (entry.group === 'overdue') meta.append(element('span', 'home-task-flag', t('tasks.overdue')))
    if (date) meta.append(element('span', 'home-task-when', date))
    if (entry.reminder !== null) {
      const bell = element('span', 'home-task-reminder')
      bell.append(icon('bell'))
      bell.setAttribute('aria-label', t('home.hasReminder'))
      bell.title = t('home.hasReminder')
      meta.append(bell)
    }
    const target = task.link && !task.link.unconfirmed ? task.link : undefined
    if (target) {
      const chapter = target.editionId && target.chapterId
        ? titles.get(`${target.library}:${target.bookId}:${target.editionId}:${target.chapterId}`) : undefined
      const work = element('span', 'home-task-work')
      work.append(icon('book'), element('span', '', chapter ? `${target.title} · ${chapter}` : target.title))
      meta.append(work)
      open.setAttribute('aria-label', t('home.openTaskWork', [task.title, target.title]))
    } else open.setAttribute('aria-label', t('home.openTask', [task.title]))
    open.append(name, meta)
    open.addEventListener('click', () => {
      if (target) { void openTaskLink(target); return }
      if (data) void taskDialog(data, task).catch((error) => showNotice(storageError(error)))
    })
    item.append(check, open)
    return item
  }

  async function refresh() {
    const turn = ++request
    try {
      const current = await readTasks()
      const entries = homeTasks(current)
      const titles = await chapterTitles(entries.slice(0, homeTaskLimit))
      if (signal.aborted || turn !== request) return
      data = current
      const visible = entries.slice(0, homeTaskLimit)
      const hidden = entries.length - visible.length
      all.textContent = hidden > 0 ? t('home.allTasksCount', [String(entries.length)]) : t('home.allTasks')
      // The link leads to where the tasks left out of the card are listed.
      const later = entries.slice(homeTaskLimit)
      all.setAttribute('href', later.length && later.every((entry) => entry.group === 'soon') ? '#/notes/tasks/upcoming' : '#/notes/tasks/today')
      if (!visible.length) {
        const empty = element('p', 'home-tasks-empty')
        empty.append(icon('check'), element('span', '', t('home.noTasks')))
        body.replaceChildren(empty)
      } else {
        const groups = element('div', 'home-task-groups')
        for (const group of ['overdue', 'today', 'soon'] as const) {
          const rows = visible.filter((entry) => entry.group === group)
          if (!rows.length) continue
          const section = element('div', `home-task-group home-task-group-${group}`)
          const label = element('h3', '', t(`home.group.${group}`))
          label.id = `home-tasks-${group}`
          const list = element('ul', 'home-task-list')
          list.setAttribute('aria-labelledby', label.id)
          list.append(...rows.map((entry) => row(entry, titles)))
          section.append(label, shown ? list : stagger(list))
          groups.append(section)
        }
        body.replaceChildren(groups)
      }
      shown = true
    } catch (error) {
      if (!signal.aborted && turn === request) body.replaceChildren(notice(storageError(error), true))
    }
  }

  taskChanges.addEventListener('update', () => { void refresh() }, { signal })
  window.addEventListener('focus', () => { void refresh() }, { signal })
  // Due dates move from "soon" to "today" to "overdue" as time passes.
  const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 60000)
  signal.addEventListener('abort', () => window.clearInterval(timer), { once: true })
  void refresh()
  return card
}
