import { locale, t } from '../i18n'
import { button, downloadFile, element, icon, link, notice } from '../ui'
import { openMenu } from '../menu'
import type { MenuItem } from '../menu'
import { offerActionUndo, showNotice } from '../undo'
import { listBooks, readBook, storageError } from '../library'
import type { Book } from '../library'
import { field, taskForm } from './forms'
import {
  addDays,
  dateKey,
  emptyTasks,
  scheduleDay,
  scheduleInstant,
  taskMatches,
} from './model'
import type { Task, TaskAttachment, TaskData, TaskWorkLink } from './model'
import {
  addTask,
  completeTasks,
  copyTask,
  deleteTasks,
  editTask,
  moveTasks,
  readTasks,
  reopenCompletion,
  restoreTaskGroup,
  taskChanges,
  undoTaskChange,
} from './store'
import { openTaskLink, taskLinkFields, workTaskPath } from './links'
import { reminderControls } from './reminders'
import { describeRepeat, taskScheduleControls } from './schedule-fields'
import { taskTransferControls } from './transfer-view'
import './tasks.css'

const labelKey = (key: string) => t('tasks.' + key)
const svgNs = 'http://www.w3.org/2000/svg'

const b = (key: string, action: () => unknown, cls = 'button button-quiet button-small') => {
  const node = button(labelKey(key), cls)
  node.addEventListener('click', () => {
    void Promise.resolve()
      .then(action)
      .catch((e) => showNotice(storageError(e)))
  })
  return node
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatShortDate(day: string, today: string): string {
  if (day === today) return labelKey('setToday')
  if (day === addDays(today, 1)) return labelKey('setTomorrow')
  const date = new Date(day + 'T00:00:00')
  const sameYear = day.slice(0, 4) === today.slice(0, 4)
  return date.toLocaleDateString(locale, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Things 3-style compact completion pie chart beside each work. */
function workPieSvg(done: number, total: number): SVGSVGElement {
  const svg = document.createElementNS(svgNs, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('task-work-pie')
  const ring = document.createElementNS(svgNs, 'circle')
  ring.setAttribute('cx', '8')
  ring.setAttribute('cy', '8')
  ring.setAttribute('r', '6.5')
  ring.setAttribute('fill', 'none')
  ring.setAttribute('stroke', 'currentColor')
  ring.setAttribute('stroke-width', '1.4')
  ring.classList.add('task-work-pie-ring')
  svg.append(ring)

  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0
  if (ratio >= 1) {
    const fill = document.createElementNS(svgNs, 'circle')
    fill.setAttribute('cx', '8')
    fill.setAttribute('cy', '8')
    fill.setAttribute('r', '4.75')
    fill.classList.add('task-work-pie-fill')
    svg.append(fill)
  } else if (ratio > 0) {
    const r = 4.75
    const angle = ratio * Math.PI * 2 - Math.PI / 2
    const x = 8 + r * Math.cos(angle)
    const y = 8 + r * Math.sin(angle)
    const largeArc = ratio > 0.5 ? 1 : 0
    const wedge = document.createElementNS(svgNs, 'path')
    wedge.setAttribute('d', `M 8 8 L 8 ${8 - r} A ${r} ${r} 0 ${largeArc} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`)
    wedge.classList.add('task-work-pie-fill')
    svg.append(wedge)
  }
  return svg
}

/** Flattens all non-deleted descendants of a task into 1-level pre-order checklist items without altering stored parentId. */
function collectChecklist(tasks: Task[], rootId: string): Task[] {
  const byParent = new Map<string, Task[]>()
  for (const item of tasks) {
    if (item.deletedAt !== null || !item.parentId) continue
    const list = byParent.get(item.parentId) ?? []
    list.push(item)
    byParent.set(item.parentId, list)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order)
  const out: Task[] = []
  const seen = new Set<string>([rootId])
  const walk = (id: string) => {
    for (const child of byParent.get(id) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      out.push(child)
      walk(child.id)
    }
  }
  walk(rootId)
  return out
}

/** Read-only display for legacy data (description, comments, attachments) so old user data is never hidden. */
function buildLegacyExtras(task: Partial<Task>, attachments: TaskAttachment[]): HTMLElement | null {
  const description = (task.description ?? '').trim()
  const comments = (task.comments ?? []).filter((c) => c.deletedAt === null)
  if (!description && !comments.length && !attachments.length) return null

  const box = element('div', 'task-legacy-box')
  if (description) {
    const sec = element('div', 'task-legacy-section')
    sec.append(
      element('span', 'task-legacy-title', labelKey('legacyDescription')),
      element('p', 'task-legacy-text', description),
    )
    box.append(sec)
  }
  if (comments.length) {
    const sec = element('div', 'task-legacy-section')
    sec.append(element('span', 'task-legacy-title', labelKey('legacyComments')))
    const list = element('ul', 'task-legacy-list')
    for (const comment of comments) {
      const li = element('li', 'task-legacy-comment')
      li.append(
        element('p', 'task-legacy-text', comment.text),
        element('span', 'task-legacy-meta', new Date(comment.createdAt).toLocaleString(locale)),
      )
      list.append(li)
    }
    sec.append(list)
    box.append(sec)
  }
  if (attachments.length) {
    const sec = element('div', 'task-legacy-section')
    sec.append(element('span', 'task-legacy-title', labelKey('legacyAttachments')))
    const list = element('ul', 'task-legacy-list')
    for (const att of attachments) {
      const li = element('li', 'task-legacy-attachment')
      const info = element('span', 'task-legacy-att-name', `${att.name} · ${formatBytes(att.bytes)}`)
      const dl = button(labelKey('downloadAttachment'), 'button button-quiet button-small', 'download')
      dl.addEventListener('click', () => downloadFile(att.content, att.name))
      li.append(info, dl)
      list.append(li)
    }
    sec.append(list)
    box.append(sec)
  }
  return box
}

function isDueTodayOrOverdue(task: Task, today: string): boolean {
  const day = scheduleDay(task)
  return (day !== null && day <= today) || Boolean(task.deadline && task.deadline <= today)
}

function isUpcoming(task: Task, today: string): boolean {
  if (isDueTodayOrOverdue(task, today)) return false
  const day = scheduleDay(task)
  return (day !== null && day > today) || Boolean(task.deadline && task.deadline > today)
}

function isOverdue(task: Task, today: string): boolean {
  if (task.completedAt !== null) return false
  const instant = scheduleInstant(task)
  const lateSchedule = instant === null ? Boolean(task.planDate && task.planDate < today) : instant < Date.now()
  return lateSchedule || Boolean(task.deadline && task.deadline < today)
}

/** Streamlined dialog used by Home, Ideas-to-Task, Editor chapter-task creation, and Reader work controls. */
export async function taskDialog(
  data: TaskData,
  task?: Task,
  patch: Partial<Task> = {},
  onCreated?: (task: Task) => void,
) {
  const initial: Partial<Task> = task ?? {
    title: '',
    description: '',
    notes: '',
    priority: 4,
    labelIds: [],
    projectId: null,
    sectionId: null,
    parentId: null,
    planDate: null,
    ...patch,
  }
  const title = field(labelKey('title'), 'text', initial.title ?? '')
  title.input.required = true
  title.input.maxLength = 500

  const notes = field(labelKey('notes'), 'textarea', initial.notes ?? '')
  notes.input.maxLength = 20000
  notes.input.placeholder = labelKey('notesPlaceholder')

  const schedule = taskScheduleControls(initial)
  const association = await taskLinkFields(initial.link)
  const attachments = task ? data.taskAttachments.filter((a) => a.taskId === task.id) : []
  const legacyExtras = buildLegacyExtras(initial, attachments)

  const fields: HTMLElement[] = [
    title.wrapper,
    notes.wrapper,
    schedule.element,
    ...association.fields,
    ...(legacyExtras ? [legacyExtras] : []),
  ]

  taskForm(
    {
      title: labelKey(task ? 'edit' : 'add'),
      action: labelKey('save'),
      fields,
    },
    async () => {
      const { planDate, repeat } = schedule.read()
      const linkValue = association.read()
      const corePatch: Partial<Task> = {
        title: title.input.value.trim(),
        notes: notes.input.value,
        planDate,
        repeat,
        link: linkValue,
      }
      if (task) {
        // Only patch streamlined fields so all legacy/hidden fields stay 100% preserved.
        await editTask(task.id, task.revision, corePatch)
      } else {
        const created = await addTask(corePatch.title!, {
          ...patch,
          ...corePatch,
        })
        onCreated?.(created)
      }
    },
  )
}

/**
 * The task list shown somewhere else than the tasks page (the editor's side panel): the same rows,
 * in-place expansion and quick-add, without the page's sidebar navigation and transfer tools.
 */
export interface TaskEmbed {
  /** The work tasks added here belong to. */
  link: () => TaskWorkLink
  /** The chapter being written: its tasks come first. */
  chapter: () => { editionId: string; chapterId: string } | undefined
  /** The work's open tasks, after every change. */
  onCount?: (open: number) => void
}

interface ActiveCardState {
  id: string
  revision: number
  isDirty: () => boolean
  refreshChecklist: (nextData: TaskData) => void
}

export function renderTasks(root: HTMLElement, signal: AbortSignal, currentRoute: string, embed?: TaskEmbed) {
  const page = element('section', embed ? 'task-workspace task-embedded' : 'task-workspace')
  const nav = element('nav', 'task-nav')
  const content = element('div', 'task-content')
  const layout = element('div', 'task-layout')
  if (embed) layout.append(content)
  else layout.append(nav, content)
  page.append(layout)
  root.append(page)

  let data = emptyTasks()
  let books: Book[] = []
  let request = 0
  let clockDay = dateKey()
  let ready = false
  let contextLink: TaskWorkLink | undefined
  let displayLimit = 200
  let rendered = 0
  let historyExpanded = false
  let workCompletedExpanded = false
  let expandedId: string | null = null
  let activeCard: ActiveCardState | null = null
  const completingIds = new Set<string>()
  let siblingIndex = new Map<string, Task[]>()
  const locationKey = (task: Task) => [task.projectId, task.sectionId, task.parentId].join(':')

  // Search box (stays mounted across repaints to preserve focus & IME composition)
  const searchInput = element('input', 'title-input task-search-input')
  searchInput.type = 'search'
  searchInput.setAttribute('aria-label', labelKey('search'))
  searchInput.placeholder = labelKey('searchHint')
  searchInput.addEventListener('input', (event) => {
    if (!(event as InputEvent).isComposing) paintContent()
  })
  searchInput.addEventListener('compositionend', () => paintContent())

  // Quick-add form
  const quick = element('form', 'task-quick')
  const input = element('input', 'title-input')
  input.required = true
  input.maxLength = 500
  input.setAttribute('aria-label', labelKey('quick'))
  input.placeholder = labelKey('quick')
  const addBtn = button(labelKey('add'), 'button button-primary')
  addBtn.type = 'submit'
  quick.append(input, addBtn)
  if (embed) {
    quick.append(
      b('addDetailed', () =>
        taskDialog(data, undefined, {
          title: input.value.trim(),
          ...(contextLink ? { link: contextLink } : {}),
        }),
      ),
    )
  }
  quick.addEventListener('submit', (event) => {
    event.preventDefault()
    const rawTitle = input.value.trim()
    if (!rawTitle) return
    addBtn.disabled = true
    const route = normalizedRoute()
    const planDate =
      route === 'today' ? dateKey()
      : route === 'upcoming' ? addDays(dateKey(), 1)
      : null
    void addTask(rawTitle, {
      planDate,
      ...(contextLink ? { link: contextLink } : {}),
    })
      .then(
        () => {
          input.value = ''
          input.focus()
        },
        (e) => showNotice(storageError(e)),
      )
      .finally(() => {
        addBtn.disabled = false
      })
  })

  function normalizedRoute(): string {
    if (!currentRoute || currentRoute === 'inbox') return currentRoute === 'inbox' ? 'later' : 'today'
    return currentRoute
  }

  function confirmDelete(ids: string[]) {
    taskForm(
      {
        title: labelKey('delete'),
        action: labelKey('delete'),
        description: labelKey('deleteHint'),
        danger: true,
      },
      async () => {
        await deleteTasks(ids)
        if (expandedId && ids.includes(expandedId)) {
          expandedId = null
          activeCard = null
        }
      },
    )
  }

  function toggleComplete(task: Task) {
    if (completingIds.has(task.id)) return
    completingIds.add(task.id)
    const markingDone = task.completedAt === null
    void completeTasks([task.id], markingDone, { id: task.id, revision: task.revision })
      .then(() => {
        if (markingDone && expandedId === task.id) {
          expandedId = null
          activeCard = null
        }
        if (markingDone) {
          offerActionUndo(t('home.taskDone', [task.title]), () => undoTaskChange())
        }
      })
      .catch((e) => showNotice(storageError(e)))
      .finally(() => {
        completingIds.delete(task.id)
      })
  }

  function computeWorkSummaries() {
    const map = new Map<string, { library: 'original' | 'reference'; bookId: string; title: string; open: number; done: number }>()
    const bookTitles = new Map(books.map((book) => [`${book.library}:${book.id}`, book.title]))
    for (const task of data.tasks) {
      if (task.deletedAt !== null || !task.link || task.link.unconfirmed) continue
      const key = `${task.link.library}:${task.link.bookId}`
      let entry = map.get(key)
      if (!entry) {
        entry = {
          library: task.link.library,
          bookId: task.link.bookId,
          title: bookTitles.get(key) ?? task.link.title,
          open: 0,
          done: 0,
        }
        map.set(key, entry)
      }
      if (task.completedAt === null) entry.open++
      else entry.done++
    }
    return [...map.values()].sort((a, b) => (b.open > 0 ? 1 : 0) - (a.open > 0 ? 1 : 0) || b.open - a.open || a.title.localeCompare(b.title))
  }

  function paintNav() {
    nav.replaceChildren()
    nav.setAttribute('aria-label', labelKey('workspace'))
    const route = normalizedRoute()
    const today = dateKey()
    const activeRoots = data.tasks.filter((task) => {
      if (task.deletedAt !== null || task.completedAt !== null) return false
      if (task.parentId) {
        const parent = data.tasks.find((p) => p.id === task.parentId)
        if (parent && parent.deletedAt === null && parent.completedAt === null) return false
      }
      return true
    })
    const todayList = activeRoots.filter((task) => isDueTodayOrOverdue(task, today))
    const overdueCount = todayList.filter((task) => isOverdue(task, today)).length
    const upcomingCount = activeRoots.filter((task) => isUpcoming(task, today)).length
    const laterCount = activeRoots.filter((task) => !isDueTodayOrOverdue(task, today) && !isUpcoming(task, today)).length
    const trashCount = data.tasks.filter((task) => task.deletedAt !== null && (!task.parentId || !data.tasks.some((p) => p.id === task.parentId && p.deletedAt !== null))).length

    const addNavLink = (
      href: string,
      label: string,
      active: boolean,
      count?: number,
      countTone?: 'overdue' | 'muted',
      prefix?: Node,
      ariaLabel?: string,
    ) => {
      const item = link(href, '', 'task-nav-item')
      if (active) item.setAttribute('aria-current', 'page')
      if (ariaLabel) item.setAttribute('aria-label', ariaLabel)
      if (prefix) item.append(prefix)
      item.append(element('span', 'task-nav-label', label))
      if (count !== undefined && count > 0) {
        item.append(element('span', `task-nav-count${countTone === 'overdue' ? ' is-overdue' : ''}`, String(count)))
      }
      nav.append(item)
      return item
    }

    addNavLink('#/notes/tasks/today', labelKey('today'), route === 'today', todayList.length, overdueCount > 0 ? 'overdue' : 'muted')
    addNavLink('#/notes/tasks/upcoming', labelKey('upcoming'), route === 'upcoming', upcomingCount, 'muted')
    addNavLink('#/notes/tasks/later', labelKey('someday'), route === 'later', laterCount, 'muted')

    // Per-work section with Things 3-style completion pie charts
    const works = computeWorkSummaries()
    if (works.length) {
      nav.append(element('h2', 'task-nav-heading', labelKey('worksGroup')))
      for (const work of works) {
        const total = work.open + work.done
        const pie = workPieSvg(work.done, total)
        const workRoute = `work/${work.library}/${work.bookId}`
        const item = addNavLink(
          workTaskPath(work.library, work.bookId),
          work.title,
          route === workRoute,
          work.open,
          'muted',
          pie,
          t('tasks.workProgress', [work.title, work.done, total]),
        )
        item.classList.add('task-nav-work')
        if (work.open === 0 && work.done > 0) {
          item.append(element('span', 'task-nav-count is-done', `${work.done}/${total}`))
        }
      }
    }

    const divider = element('hr', 'task-nav-divider')
    nav.append(divider)
    addNavLink('#/notes/tasks/completed', labelKey('completed'), route === 'completed')
    addNavLink('#/notes/tasks/trash', labelKey('trash'), route === 'trash', trashCount, 'muted')
  }

  function visibleTasks(): Task[] {
    const route = normalizedRoute()
    const today = dateKey()
    return data.tasks
      .filter((task) => {
        if (!taskMatches(task, searchInput.value)) return false
        if (route.startsWith('item/')) return task.id === route.slice(5)
        if (embed && (task.deletedAt !== null || task.completedAt !== null)) return false
        if (route.startsWith('work/')) {
          const [, lib, id] = route.split('/')
          return (
            task.deletedAt === null &&
            !task.link?.unconfirmed &&
            task.link?.library === lib &&
            task.link?.bookId === id
          )
        }
        if (route === 'trash') return task.deletedAt !== null
        if (task.deletedAt !== null) return false
        if (route === 'completed') return task.completedAt !== null
        if (task.completedAt !== null) return false
        if (route === 'today') return isDueTodayOrOverdue(task, today)
        if (route === 'upcoming') return isUpcoming(task, today)
        if (route === 'later') return !isDueTodayOrOverdue(task, today) && !isUpcoming(task, today)
        return true
      })
      .sort((a, b) => {
        if (route === 'today') {
          const aOver = isOverdue(a, today) ? 0 : 1
          const bOver = isOverdue(b, today) ? 0 : 1
          return aOver - bOver || (a.planDate ?? '').localeCompare(b.planDate ?? '') || a.order - b.order
        }
        if (route === 'upcoming') {
          return (scheduleDay(a) ?? a.deadline ?? '9999').localeCompare(scheduleDay(b) ?? b.deadline ?? '9999') || a.order - b.order
        }
        if (route === 'completed') {
          return (b.completedAt ?? 0) - (a.completedAt ?? 0) || a.order - b.order
        }
        return a.order - b.order
      })
  }

  function buildRowMenuItems(task: Task, isExpanded: boolean): MenuItem[] {
    const items: MenuItem[] = []
    if (task.deletedAt !== null) {
      items.push({
        label: labelKey('restore'),
        icon: 'undo',
        action: () => void restoreTaskGroup(task.deletionId!).catch((e) => showNotice(storageError(e))),
      })
      return items
    }
    items.push({
      label: labelKey(isExpanded ? 'collapseCard' : 'expandCard'),
      icon: 'edit',
      action: () => {
        expandedId = isExpanded ? null : task.id
        if (isExpanded) activeCard = null
        paintContent()
      },
    })
    if (task.completedAt === null) {
      const today = dateKey()
      const tomorrow = addDays(today, 1)
      if (task.planDate !== today) {
        items.push({
          label: labelKey('setToday'),
          icon: 'check',
          action: () => void editTask(task.id, task.revision, { planDate: today }).catch((e) => showNotice(storageError(e))),
        })
      }
      if (task.planDate !== tomorrow) {
        items.push({
          label: labelKey('setTomorrow'),
          icon: 'arrow',
          action: () => void editTask(task.id, task.revision, { planDate: tomorrow }).catch((e) => showNotice(storageError(e))),
        })
      }
      if (task.planDate) {
        items.push({
          label: labelKey('clearDate'),
          icon: 'close',
          action: () => void editTask(task.id, task.revision, { planDate: null, repeat: undefined }).catch((e) => showNotice(storageError(e))),
        })
      }
    }
    if (task.link && !task.link.unconfirmed) {
      items.push({
        label: t('tasks.openWork', [task.link.title]),
        icon: 'book',
        action: () => void openTaskLink(task.link!),
      })
    }
    items.push({
      label: labelKey('copy'),
      icon: 'copy',
      action: () => void copyTask(task.id).catch((e) => showNotice(storageError(e))),
    })
    const siblings = siblingIndex.get(locationKey(task)) ?? []
    const index = siblings.findIndex((s) => s.id === task.id)
    if (index > 0) {
      items.push({
        label: labelKey('up'),
        icon: 'up',
        action: () =>
          void moveTasks([task.id], task.projectId, task.sectionId, task.parentId, siblings[index - 1]?.id)
            .catch((e) => showNotice(storageError(e))),
      })
    }
    if (index >= 0 && index < siblings.length - 1) {
      items.push({
        label: labelKey('down'),
        icon: 'down',
        action: () =>
          void moveTasks([task.id], task.projectId, task.sectionId, task.parentId, siblings[index + 2]?.id)
            .catch((e) => showNotice(storageError(e))),
      })
    }
    items.push({
      label: labelKey('delete'),
      icon: 'trash',
      danger: true,
      action: () => confirmDelete([task.id]),
    })
    return items
  }

  /** Renders the Things 3-style in-place expanded card inside the task's `<li>` row. */
  function buildExpandedCard(task: Task, row: HTMLElement) {
    const latest = () => data.tasks.find((item) => item.id === task.id) ?? task
    const baseRevision = task.revision
    let dirty = false
    const markDirty = () => { dirty = true }

    row.classList.add('is-expanded')
    const card = element('div', 'task-card')

    // Card header: circular checkbox + editable title + collapse ×
    const head = element('div', 'task-card-head')
    const check = button('', 'task-check')
    check.setAttribute('role', 'checkbox')
    check.setAttribute('aria-checked', String(task.completedAt !== null))
    check.setAttribute('aria-label', labelKey(task.completedAt !== null ? 'reopen' : 'complete'))
    check.append(icon('check'))
    check.addEventListener('click', () => toggleComplete(latest()))

    const titleInput = element('input', 'task-card-title')
    titleInput.type = 'text'
    titleInput.value = task.title
    titleInput.maxLength = 500
    titleInput.required = true
    titleInput.setAttribute('aria-label', labelKey('title'))
    titleInput.addEventListener('input', markDirty)

    const closeBtn = button('', 'task-icon-btn task-card-close', 'close')
    closeBtn.setAttribute('aria-label', labelKey('collapseCard'))
    closeBtn.title = labelKey('collapseCard')
    closeBtn.addEventListener('click', () => {
      expandedId = null
      activeCard = null
      paintContent()
    })
    head.append(check, titleInput, closeBtn)

    // Notes textarea
    const notesInput = element('textarea', 'title-input task-card-notes')
    notesInput.rows = 2
    notesInput.maxLength = 20000
    notesInput.value = task.notes
    notesInput.placeholder = labelKey('notesPlaceholder')
    notesInput.setAttribute('aria-label', labelKey('notes'))
    notesInput.addEventListener('input', markDirty)

    // Date & simple daily/weekly repeat (preserves legacy complex repeat rules untouched)
    const schedule = taskScheduleControls(task, markDirty)

    // Work + chapter link controls (loaded async without blocking card open)
    const linkHost = element('div', 'task-card-link')
    let linkController: Awaited<ReturnType<typeof taskLinkFields>> | undefined
    let linkError: unknown
    void taskLinkFields(task.link).then(
      (ctrl) => {
        if (signal.aborted || !card.isConnected) return
        linkController = ctrl
        for (const node of ctrl.fields) {
          node.addEventListener('change', markDirty)
        }
        linkHost.replaceChildren(...ctrl.fields)
      },
      (err) => {
        linkError = err
      },
    )

    // 1-level flattened subtask checklist
    const checklistSection = element('div', 'task-checklist-section')
    const checklistTitle = element('span', 'task-card-section-label', labelKey('checklist'))
    const checklistList = element('ul', 'task-checklist')
    const addSubForm = element('form', 'task-checklist-add')
    const addSubInput = element('input', 'title-input task-checklist-input')
    addSubInput.type = 'text'
    addSubInput.maxLength = 500
    addSubInput.placeholder = labelKey('addChecklistPlaceholder')
    addSubInput.setAttribute('aria-label', labelKey('addChecklistItem'))
    const addSubBtn = button('', 'button button-quiet button-small task-checklist-submit', 'plus')
    addSubBtn.type = 'submit'
    addSubBtn.setAttribute('aria-label', labelKey('addChecklistItem'))
    addSubForm.append(addSubInput, addSubBtn)
    addSubForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const text = addSubInput.value.trim()
      if (!text) return
      addSubBtn.disabled = true
      void addTask(text, { parentId: task.id })
        .then(
          () => {
            addSubInput.value = ''
            addSubInput.focus()
          },
          (e) => showNotice(storageError(e)),
        )
        .finally(() => {
          addSubBtn.disabled = false
        })
    })
    checklistSection.append(checklistTitle, checklistList, addSubForm)

    function paintChecklist(sourceData: TaskData) {
      const subs = collectChecklist(sourceData.tasks, task.id)
      checklistList.replaceChildren()
      for (const sub of subs) {
        const li = element('li', sub.completedAt !== null ? 'task-sub-item is-done' : 'task-sub-item')
        li.dataset.taskId = sub.id
        const subCheck = button('', 'task-check task-sub-check')
        subCheck.setAttribute('role', 'checkbox')
        subCheck.setAttribute('aria-checked', String(sub.completedAt !== null))
        subCheck.setAttribute('aria-label', labelKey(sub.completedAt !== null ? 'reopen' : 'complete'))
        subCheck.append(icon('check'))
        subCheck.addEventListener('click', () => toggleComplete(sub))

        const subTitle = element('input', 'task-sub-title')
        subTitle.type = 'text'
        subTitle.value = sub.title
        subTitle.maxLength = 500
        subTitle.setAttribute('aria-label', labelKey('title'))
        const commitSubTitle = () => {
          const next = subTitle.value.trim()
          if (!next) {
            subTitle.value = sub.title
            return
          }
          if (next === sub.title) return
          void editTask(sub.id, sub.revision, { title: next }).catch((e) => showNotice(storageError(e)))
        }
        subTitle.addEventListener('blur', commitSubTitle)
        subTitle.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            subTitle.blur()
          }
        })

        const subDel = button('', 'task-icon-btn task-sub-del', 'close')
        subDel.setAttribute('aria-label', labelKey('removeChecklistItem'))
        subDel.addEventListener('click', () => {
          void deleteTasks([sub.id]).catch((e) => showNotice(storageError(e)))
        })
        li.append(subCheck, subTitle, subDel)
        checklistList.append(li)
      }
      checklistTitle.hidden = subs.length === 0
    }
    paintChecklist(data)

    // Read-only legacy extras (description, comments, attachments)
    const legacyHost = element('div', 'task-legacy-host')
    const paintLegacy = (sourceData: TaskData) => {
      const fresh = sourceData.tasks.find((item) => item.id === task.id) ?? task
      const atts = sourceData.taskAttachments.filter((a) => a.taskId === task.id)
      const block = buildLegacyExtras(fresh, atts)
      legacyHost.replaceChildren(...(block ? [block] : []))
    }
    paintLegacy(data)

    // Inline error alert & footer actions
    const errorAlert = element('p', 'field-error task-card-error')
    errorAlert.setAttribute('role', 'alert')
    errorAlert.hidden = true

    const footer = element('div', 'task-card-footer')
    const moreBtn = button('', 'task-icon-btn task-card-more', 'more')
    moreBtn.setAttribute('aria-label', labelKey('moreActions'))
    moreBtn.setAttribute('aria-haspopup', 'menu')
    moreBtn.setAttribute('aria-expanded', 'false')
    moreBtn.addEventListener('click', () => {
      moreBtn.setAttribute('aria-expanded', 'true')
      openMenu(buildRowMenuItems(latest(), true), moreBtn, labelKey('moreActions'), moreBtn)
    })

    const collapseBtn = button(labelKey('collapseCard'), 'button button-quiet button-small')
    collapseBtn.addEventListener('click', () => {
      expandedId = null
      activeCard = null
      paintContent()
    })

    const saveBtn = button(labelKey('save'), 'button button-primary button-small')
    async function commitCard() {
      const nextTitle = titleInput.value.trim()
      if (!nextTitle) {
        errorAlert.textContent = labelKey('title')
        errorAlert.hidden = false
        titleInput.focus()
        return
      }
      if (linkError) {
        errorAlert.textContent = storageError(linkError)
        errorAlert.hidden = false
        return
      }
      saveBtn.disabled = true
      errorAlert.hidden = true
      try {
        const { planDate, repeat } = schedule.read()
        const patch: Partial<Task> = {
          title: nextTitle,
          notes: notesInput.value,
          planDate,
          repeat,
          ...(linkController ? { link: linkController.read() } : {}),
        }
        await editTask(task.id, baseRevision, patch)
        dirty = false
        expandedId = null
        activeCard = null
        paintContent()
      } catch (err) {
        errorAlert.textContent = storageError(err)
        errorAlert.hidden = false
      } finally {
        saveBtn.disabled = false
      }
    }
    saveBtn.addEventListener('click', () => { void commitCard() })

    card.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        expandedId = null
        activeCard = null
        paintContent()
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault()
        void commitCard()
      }
    })

    const footerRight = element('div', 'task-card-footer-actions')
    footerRight.append(collapseBtn, saveBtn)
    footer.append(moreBtn, footerRight)

    const body = element('div', 'task-card-body')
    body.append(notesInput, schedule.element, linkHost, checklistSection, legacyHost, errorAlert)
    card.append(head, body, footer)
    row.append(card)

    activeCard = {
      id: task.id,
      revision: baseRevision,
      isDirty: () => dirty,
      refreshChecklist: (nextData: TaskData) => {
        paintChecklist(nextData)
        paintLegacy(nextData)
      },
    }

    queueMicrotask(() => {
      if (card.isConnected && !card.contains(document.activeElement)) {
        titleInput.focus({ preventScroll: true })
      }
    })
  }

  function taskRow(task: Task): HTMLElement {
    rendered++
    const row = element('li', 'task-row')
    row.dataset.taskId = task.id
    if (task.completedAt !== null) row.classList.add('is-completed')
    if (task.deletedAt !== null) row.classList.add('is-deleted')

    if (expandedId === task.id && task.deletedAt === null) {
      buildExpandedCard(task, row)
      return row
    }

    // Drag-reorder support (subtle on hover)
    if (task.deletedAt === null) {
      const handle = element('span', 'task-drag-handle', '⠿')
      handle.draggable = true
      handle.title = labelKey('move')
      handle.setAttribute('aria-label', labelKey('move'))
      row.append(handle)
      row.addEventListener('dragstart', (event) => {
        event.stopPropagation()
        event.dataTransfer?.setData('application/x-newworld-task', task.id)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      })
      row.addEventListener('dragover', (event) => {
        if (event.dataTransfer?.types.includes('application/x-newworld-task')) event.preventDefault()
      })
      row.addEventListener('drop', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const id = event.dataTransfer?.getData('application/x-newworld-task')
        if (id && id !== task.id) {
          void moveTasks([id], task.projectId, task.sectionId, task.parentId, task.id).catch((e) =>
            showNotice(storageError(e)),
          )
        }
      })
    }

    // Circular completion checkbox
    if (task.deletedAt === null) {
      const check = button('', 'task-check')
      check.setAttribute('role', 'checkbox')
      check.setAttribute('aria-checked', String(task.completedAt !== null))
      check.setAttribute('aria-label', labelKey(task.completedAt !== null ? 'reopen' : 'complete'))
      check.append(icon('check'))
      check.addEventListener('click', () => toggleComplete(task))
      row.append(check)
    }

    // Center: title + compact metadata strip
    const copy = element('div', 'task-copy')
    const titleBtn = button(task.title, 'task-title')
    titleBtn.setAttribute('aria-expanded', 'false')
    titleBtn.addEventListener('click', () => {
      if (task.deletedAt !== null) return
      expandedId = task.id
      activeCard = null
      paintContent()
    })
    copy.append(titleBtn)

    const today = dateKey()
    const meta = element('div', 'task-meta')
    if (task.planDate) {
      const late = isOverdue(task, today)
      const label = late ? `${labelKey('overdue')} · ${formatShortDate(task.planDate, today)}` : formatShortDate(task.planDate, today)
      meta.append(element('span', late ? 'task-chip task-overdue' : 'task-chip', label))
    } else if (task.deadline) {
      const late = task.completedAt === null && task.deadline < today
      meta.append(element('span', late ? 'task-chip task-overdue' : 'task-chip', `${labelKey('deadline')} ${task.deadline}`))
    }
    if (task.repeat) {
      meta.append(element('span', 'task-chip task-chip-repeat', `↻ ${describeRepeat(task.repeat)}`))
    }
    if (task.link && !task.link.unconfirmed) {
      const workChip = button('', 'task-chip task-chip-work', 'book')
      workChip.append(element('span', '', task.link.title))
      workChip.setAttribute('aria-label', t('tasks.openWork', [task.link.title]))
      workChip.addEventListener('click', (event) => {
        event.stopPropagation()
        void openTaskLink(task.link!)
      })
      meta.append(workChip)
    }
    const subtasks = collectChecklist(data.tasks, task.id)
    if (subtasks.length) {
      const doneSubs = subtasks.filter((s) => s.completedAt !== null).length
      meta.append(element('span', 'task-chip', `☑ ${doneSubs}/${subtasks.length}`))
    }
    const hasLegacyNotes = Boolean(task.notes.trim() || task.description.trim())
    const hasComments = Boolean(task.comments?.some((c) => c.deletedAt === null))
    const hasAttachments = data.taskAttachments.some((a) => a.taskId === task.id)
    if (hasLegacyNotes || hasComments || hasAttachments) {
      const indicator = element('span', 'task-chip task-chip-note', '≡')
      indicator.title = labelKey('notes')
      indicator.setAttribute('aria-hidden', 'true')
      meta.append(indicator)
    }
    if (meta.childElementCount) copy.append(meta)
    row.append(copy)

    // Right side: trash restore button OR hover/always-on-touch ⋯ menu button
    if (task.deletedAt !== null) {
      row.append(b('restore', () => restoreTaskGroup(task.deletionId!)))
    } else {
      const more = button('', 'task-more-btn', 'more')
      more.setAttribute('aria-label', labelKey('moreActions'))
      more.setAttribute('aria-haspopup', 'menu')
      more.setAttribute('aria-expanded', 'false')
      more.addEventListener('click', (event) => {
        event.stopPropagation()
        more.setAttribute('aria-expanded', 'true')
        openMenu(buildRowMenuItems(task, false), more, labelKey('moreActions'), more)
      })
      row.append(more)

      row.addEventListener('contextmenu', (event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
        event.preventDefault()
        openMenu(buildRowMenuItems(task, false), { x: event.clientX, y: event.clientY }, labelKey('moreActions'))
      })
    }

    return row
  }

  function viewTitleNode(): HTMLElement {
    const route = normalizedRoute()
    const headTitle = element('h2', 'task-view-title')
    if (route === 'today') headTitle.textContent = labelKey('today')
    else if (route === 'upcoming') headTitle.textContent = labelKey('upcoming')
    else if (route === 'later') headTitle.textContent = labelKey('someday')
    else if (route === 'completed') headTitle.textContent = labelKey('completed')
    else if (route === 'trash') headTitle.textContent = labelKey('trash')
    else if (route === 'all') headTitle.textContent = labelKey('all')
    else if (route.startsWith('work/') && contextLink) {
      const summary = computeWorkSummaries().find((w) => w.library === contextLink!.library && w.bookId === contextLink!.bookId)
      if (summary) headTitle.append(workPieSvg(summary.done, summary.open + summary.done))
      headTitle.append(element('span', '', contextLink.title))
    } else {
      headTitle.textContent = labelKey('workspace')
    }
    return headTitle
  }

  function paintContent() {
    const focused = document.activeElement
    const selection =
      focused instanceof HTMLInputElement && (focused === searchInput || focused === input)
        ? [focused.selectionStart, focused.selectionEnd]
        : undefined
    const route = normalizedRoute()

    // Compact top view header: title + inline search + subtle undo button
    const top = element('div', 'task-view-head')
    if (!embed) top.append(viewTitleNode())
    top.append(searchInput)
    const undoBtn = button('', 'button button-quiet button-small task-undo-btn', 'undo')
    undoBtn.setAttribute('aria-label', labelKey('undo'))
    undoBtn.title = `${labelKey('undo')} (Ctrl / ⌘ + Z)`
    undoBtn.addEventListener('click', () => {
      void undoTaskChange().catch((e) => showNotice(storageError(e)))
    })
    top.append(undoBtn)

    const allMatched = visibleTasks()
    const activeMatched = route.startsWith('work/') && !embed
      ? allMatched.filter((task) => task.completedAt === null)
      : allMatched
    const workCompletedMatched = route.startsWith('work/') && !embed
      ? allMatched.filter((task) => task.completedAt !== null)
      : []

    siblingIndex = new Map()
    rendered = 0
    for (const task of data.tasks.filter((item) => item.deletedAt === null).sort((a, b) => a.order - b.order)) {
      const key = locationKey(task)
      const list = siblingIndex.get(key) ?? []
      list.push(task)
      siblingIndex.set(key, list)
    }

    // Subtasks live inside their parent's inline checklist; only show root tasks (or orphaned visible tasks) at top level.
    const visibleSet = new Set(activeMatched.map((item) => item.id))
    const roots = activeMatched.filter((task) => !task.parentId || !visibleSet.has(task.parentId))

    if (expandedId && !roots.some((item) => item.id === expandedId) && !workCompletedMatched.some((item) => item.id === expandedId)) {
      expandedId = null
      activeCard = null
    }

    const list = element('ul', 'task-list')
    list.setAttribute('aria-label', labelKey('workspace'))

    // Beside the text in Editor, current chapter's tasks come first under their own heading.
    const chapter = embed?.chapter()
    const here = (task: Task) =>
      Boolean(chapter && task.link?.editionId === chapter.editionId && task.link.chapterId === chapter.chapterId)
    const grouped = Boolean(embed && route.startsWith('work/') && roots.some(here))
    let visualList: HTMLElement = list
    if (grouped) {
      const rest = element('ul', 'task-list')
      rest.setAttribute('aria-label', labelKey('otherInWork'))
      list.setAttribute('aria-label', labelKey('thisChapter'))
      for (const task of roots.filter(here)) if (rendered < displayLimit) list.append(taskRow(task))
      for (const task of roots.filter((task) => !here(task))) if (rendered < displayLimit) rest.append(taskRow(task))
      visualList = element('div', 'task-groups')
      visualList.append(element('h3', 'task-group-heading', labelKey('thisChapter')), list)
      if (rest.childElementCount) visualList.append(element('h3', 'task-group-heading', labelKey('otherInWork')), rest)
    } else {
      for (const task of roots) {
        if (rendered < displayLimit) list.append(taskRow(task))
      }
    }

    content.replaceChildren(
      top,
      ...(route !== 'trash' && route !== 'completed' ? [quick] : []),
      roots.length ? visualList : notice(labelKey('empty')),
    )

    if (rendered >= displayLimit && roots.length > rendered) {
      content.append(
        b('loadMore', () => {
          displayLimit += 200
          paintContent()
        }),
      )
    }

    // Per-work completed items folded below active tasks
    if (workCompletedMatched.length) {
      const doneDetails = element('details', 'task-secondary-details')
      doneDetails.open = workCompletedExpanded
      doneDetails.ontoggle = () => { workCompletedExpanded = doneDetails.open }
      doneDetails.append(element('summary', '', `${labelKey('completed')} (${workCompletedMatched.length})`))
      const doneList = element('ul', 'task-list')
      const doneSet = new Set(workCompletedMatched.map((t) => t.id))
      for (const task of workCompletedMatched.filter((t) => !t.parentId || !doneSet.has(t.parentId))) {
        doneList.append(taskRow(task))
      }
      doneDetails.append(doneList)
      content.append(doneDetails)
    }

    // Completed view: preserve completion history restore for recurring tasks
    if (route === 'completed') {
      const details = element('details', 'task-secondary-details')
      const byId = new Map(data.tasks.map((item) => [item.id, item]))
      const reversed = new Set(data.taskCompletions.map((e) => e.reverts))
      details.open = historyExpanded
      details.ontoggle = () => { historyExpanded = details.open }
      details.append(element('summary', '', labelKey('history')))
      const events = data.taskCompletions
        .slice()
        .sort((a, b) => b.at - a.at)
        .filter((event) => {
          const record = byId.get(event.taskId)
          return record ? taskMatches({ ...record, title: event.title }, searchInput.value) : event.title.toLowerCase().includes(searchInput.value.trim().toLowerCase())
        })
      for (const event of events.slice(0, displayLimit)) {
        const entry = element(
          'p',
          'task-history-row',
          `${new Date(event.at).toLocaleString()} · ${event.title} · ${labelKey(event.reverts ? 'reopen' : 'complete')}`,
        )
        if (!event.reverts && !reversed.has(event.id)) {
          entry.append(b('reopenOccurrence', () => reopenCompletion(event.id)))
        }
        details.append(entry)
      }
      if (events.length > displayLimit) {
        details.append(
          b('loadMore', () => {
            displayLimit += 200
            historyExpanded = true
            paintContent()
          }),
        )
      }
      content.append(details)
    }

    // Quiet bottom footer: full JSON export/import & local reminders settings
    if (!embed) {
      const footer = element('div', 'task-footer-tools')
      footer.append(
        taskTransferControls(),
        reminderControls(data.taskSettings.find((s) => s.id === 'reminders:enabled')?.value === 'true'),
      )
      content.append(footer)
    }

    if (selection && focused instanceof HTMLInputElement) {
      focused.focus({ preventScroll: true })
      focused.setSelectionRange(selection[0], selection[1])
    }
  }

  async function refresh() {
    const turn = ++request
    try {
      const [next, orig, ref] = await Promise.all([
        readTasks(),
        embed ? Promise.resolve([] as Book[]) : listBooks('original'),
        embed ? Promise.resolve([] as Book[]) : listBooks('reference'),
      ])
      if (signal.aborted || turn !== request) return
      data = next
      if (!embed) books = [...orig, ...ref].filter((item) => !item.workId)
      contextLink = embed?.link()
      if (embed) {
        const work = embed.link()
        embed.onCount?.(
          data.tasks.filter(
            (task) =>
              task.deletedAt === null &&
              task.completedAt === null &&
              !task.link?.unconfirmed &&
              task.link?.library === work.library &&
              task.link.bookId === work.bookId,
          ).length,
        )
      } else if (currentRoute.startsWith('work/')) {
        const [, library, id] = currentRoute.split('/')
        if (library === 'original' || library === 'reference') {
          const stored = await readBook(library, id)
          if (signal.aborted || turn !== request) return
          if (stored && !stored.book.workId) {
            contextLink = { library, bookId: id, title: stored.book.title }
          }
        }
      }
      ready = true
      if (dragging) {
        repaintAfterDrag = true
        return
      }
      if (!embed) paintNav()
      // Preserve an open inline card's live form & focus when background/subtask updates arrive.
      if (activeCard && expandedId === activeCard.id) {
        const fresh = visibleTasks().find((item) => item.id === activeCard!.id && item.deletedAt === null)
        if (fresh) {
          if (activeCard.isDirty() || fresh.revision === activeCard.revision) {
            activeCard.refreshChecklist(data)
            return
          }
          // Clean card whose own record changed externally: re-render with updated fields.
          activeCard = null
        } else {
          expandedId = null
          activeCard = null
        }
      }
      paintContent()
    } catch (e) {
      ready = false
      if (!signal.aborted) content.replaceChildren(notice(storageError(e), true))
    }
  }

  // Defer background repaints during drag-reorder so drop targets stay live.
  let dragging = false
  let repaintAfterDrag = false
  content.addEventListener('dragstart', () => { dragging = true }, { capture: true, signal })
  document.addEventListener(
    'dragend',
    () => {
      dragging = false
      if (!repaintAfterDrag || signal.aborted) return
      repaintAfterDrag = false
      if (!embed) paintNav()
      paintContent()
    },
    { capture: true, signal },
  )

  taskChanges.addEventListener('update', () => void refresh(), { signal })
  window.addEventListener('focus', () => void refresh(), { signal })
  const clock = window.setInterval(() => {
    const next = dateKey()
    if (next !== clockDay) {
      clockDay = next
      if (ready && !signal.aborted) {
        if (dragging) repaintAfterDrag = true
        else {
          if (!embed) paintNav()
          paintContent()
        }
      }
    }
  }, 30_000)
  signal.addEventListener('abort', () => window.clearInterval(clock), { once: true })

  if (!embed) {
    window.addEventListener(
      'keydown',
      (event) => {
        if (
          root.hidden ||
          document.querySelector('dialog[open]') ||
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement ||
          (event.target instanceof HTMLElement && event.target.isContentEditable)
        ) {
          return
        }
        if (event.key === 'n' && !event.ctrlKey && !event.metaKey) {
          event.preventDefault()
          input.focus()
        }
        if (event.key === '/') {
          event.preventDefault()
          searchInput.focus()
        }
        if (event.key === 'Escape' && expandedId) {
          expandedId = null
          activeCard = null
          paintContent()
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault()
          void undoTaskChange().catch((e) => showNotice(storageError(e)))
        }
      },
      { signal },
    )
  }

  void refresh()
  return {
    /** Shows another list (such as `work/…` or `all`) in the same place. */
    setRoute(next: string) {
      if (next === currentRoute) return
      currentRoute = next
      expandedId = null
      activeCard = null
      displayLimit = 200
      void refresh()
    },
    refresh: () => void refresh(),
    repaint: () => {
      if (ready && !dragging && !activeCard?.isDirty()) paintContent()
    },
    focusQuick: () => input.focus(),
  }
}
