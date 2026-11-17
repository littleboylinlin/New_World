import { t } from '../i18n'
import { button, element, link, notice } from '../ui'
import { field, choices, taskForm } from './forms'
import { showNotice } from '../undo'
import { storageError, readBook } from '../library'
import {
  dateKey,
  descendants,
  emptyTasks,
  taskMatches,
  scheduleDay,
  scheduleInstant,
  matchesFilter,
  defaultTaskView,
  validateTaskView,
} from './model'
import type { Task, TaskData, TaskProject, TaskLabel, TaskView, TaskWorkLink } from './model'
import {
  addTask,
  batchTasks,
  completeTasks,
  copyTask,
  deleteProject,
  deleteSection,
  deleteTasks,
  editTask,
  moveTasks,
  readTasks,
  reorderProject,
  reorderSection,
  restoreTaskGroup,
  saveLabel,
  saveProject,
  saveSection,
  saveTaskSetting,
  saveFilter,
  deleteFilter,
  reopenCompletion,
  taskChanges,
  undoTaskChange,
} from './store'
import './tasks.css'
import { taskTimeFields } from './time-view'
import { taskVisuals } from './visuals'
import { filterDialog } from './filter-view'
import { reminderControls } from './reminders'
import { taskLinkFields, taskLinkButton } from './links'
import { taskExtras, saveTemplateDialog, templatesView, statsView } from './extras-view'
import { taskTransferControls } from './transfer-view'

const labelKey = (key: string) => t('tasks.' + key)
const b = (key: string, action: () => unknown, cls = 'button button-quiet button-small') => {
  const node = button(labelKey(key), cls)
  node.addEventListener('click', () => {
    void Promise.resolve()
      .then(action)
      .catch((e) => showNotice(storageError(e)))
  })
  return node
}
export async function taskDialog(data: TaskData, task?: Task, patch: Partial<Task> = {}) {
  const initial = task ?? {
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
  const title = field(labelKey('title'), 'text', initial.title),
    description = field(labelKey('description'), 'textarea', initial.description),
    notes = field(labelKey('notes'), 'textarea', initial.notes)
  title.input.required = true
  title.input.maxLength = 500
  description.input.maxLength = notes.input.maxLength = 20000
  const priority = choices(
    labelKey('priority'),
    [1, 2, 3, 4].map((p) => [String(p), 'P' + p]),
    String(initial.priority),
  )
  const project = choices(
    labelKey('project'),
    [
      ['', labelKey('inbox')],
      ...data.taskProjects
        .filter((p) => p.deletedAt === null)
        .map((p) => [p.id, p.icon + ' ' + p.name] as [string, string]),
    ],
    initial.projectId ?? '',
  )
  const section = choices(labelKey('section'), []),
    parent = choices(labelKey('parent'), [])
  const date = field(labelKey('date'), 'date', initial.planDate ?? '')
  const scheduling = taskTimeFields(initial, title.input, date.input)
  const association = await taskLinkFields(initial.link)
  const updateLocation = () => {
    const sections = [
      ['', labelKey('unsectioned')],
      ...data.taskSections
        .filter((s) => s.projectId === project.input.value && s.deletedAt === null)
        .map((s) => [s.id, s.name]),
    ] as [string, string][]
    section.input.replaceChildren(
      ...sections.map(([id, name]) => {
        const o = element('option', '', name)
        o.value = id
        return o
      }),
    )
    section.input.value =
      initial.projectId === (project.input.value || null) ? (initial.sectionId ?? '') : ''
    const excluded = task ? descendants(data.tasks, [task.id]) : new Set<string>()
    const parents = [
      ['', labelKey('none')],
      ...data.tasks
        .filter(
          (p) =>
            p.deletedAt === null &&
            p.completedAt === null &&
            p.projectId === (project.input.value || null) &&
            !excluded.has(p.id),
        )
        .map((p) => [p.id, p.title]),
    ] as [string, string][]
    parent.input.replaceChildren(
      ...parents.map(([id, name]) => {
        const o = element('option', '', name)
        o.value = id
        return o
      }),
    )
    parent.input.value = initial.parentId ?? ''
  }
  project.input.addEventListener('change', updateLocation)
  updateLocation()
  const labels = element('fieldset', 'task-label-picks')
  labels.append(element('legend', '', labelKey('label')))
  const picked = new Map<string, HTMLInputElement>()
  for (const label of data.taskLabels.filter((l) => l.deletedAt === null)) {
    const wrapper = element('label'),
      box = element('input')
    box.type = 'checkbox'
    box.checked = initial.labelIds.includes(label.id)
    wrapper.style.color = label.color
    const name =
      data.taskLabels.filter((l) => l.deletedAt === null && l.name === label.name).length > 1
        ? label.name + ' · ' + label.id.slice(0, 8)
        : label.name
    wrapper.append(box, document.createTextNode(name))
    labels.append(wrapper)
    picked.set(label.id, box)
  }
  const location = [project.wrapper, section.wrapper, parent.wrapper]
  taskForm(
    {
      title: labelKey(task ? 'edit' : 'add'),
      action: labelKey('save'),
      fields: [
        title.wrapper,
        description.wrapper,
        notes.wrapper,
        ...location,
        priority.wrapper,
        date.wrapper,
        ...scheduling.fields,
        ...association.fields,
        labels,
      ],
    },
    async () => {
      const value = {
        title: title.input.value.trim(),
        description: description.input.value,
        notes: notes.input.value,
        priority: Number(priority.input.value),
        planDate: date.input.value || null,
        projectId: project.input.value || null,
        sectionId: section.input.value || null,
        parentId: parent.input.value || null,
        labelIds: [
          ...new Set([
            ...initial.labelIds.filter((id) => !picked.has(id)),
            ...[...picked].filter(([, box]) => box.checked).map(([id]) => id),
          ]),
        ],
      }
      const schedule = { ...scheduling.read(), link: association.read() }
      if (task) await editTask(task.id, task.revision, { ...value, ...schedule })
      else await addTask(value.title, { ...value, ...schedule })
    },
  )
}
function projectDialog(data: TaskData, current?: TaskProject) {
  const name = field(labelKey('projectName'), 'text', current?.name ?? ''),
    color = field(labelKey('color'), 'color', current?.color ?? '#5274a5'),
    icon = field(labelKey('icon'), 'text', current?.icon ?? '')
  name.input.required = true
  name.input.maxLength = 500
  icon.input.maxLength = 16
  const excluded = current ? descendants(data.taskProjects, [current.id]) : new Set<string>()
  const parent = choices(
    labelKey('parentProject'),
    [
      ['', labelKey('none')],
      ...data.taskProjects
        .filter((p) => p.deletedAt === null && !excluded.has(p.id))
        .map((p) => [p.id, p.name] as [string, string]),
    ],
    current?.parentId ?? '',
  )
  taskForm(
    {
      title: labelKey(current ? 'editProject' : 'newProject'),
      action: labelKey('saveProject'),
      fields: [name.wrapper, parent.wrapper, color.wrapper, icon.wrapper],
    },
    async () => {
      await saveProject(
        {
          ...(current ?? {}),
          name: name.input.value.trim(),
          color: color.input.value,
          icon: icon.input.value,
          parentId: parent.input.value || null,
        },
        current?.revision,
      )
    },
  )
}
function labelsDialog(data: TaskData) {
  const body = element('div', 'task-management')
  const edit = (label?: TaskLabel) => {
    const name = field(labelKey('labelName'), 'text', label?.name ?? ''),
      color = field(labelKey('labelColor'), 'color', label?.color ?? '#5274a5')
    name.input.required = true
    name.input.maxLength = 500
    taskForm(
      {
        title: labelKey(label ? 'labels' : 'newLabel'),
        action: labelKey('saveLabel'),
        fields: [name.wrapper, color.wrapper],
      },
      async () => {
        await saveLabel({ ...label, name: name.input.value.trim(), color: color.input.value })
      },
    )
  }
  const paint = () => {
    body.replaceChildren(b('newLabel', () => edit()))
    for (const label of data.taskLabels) {
      const row = element('div', 'task-management-row')
      row.append(
        element('span', '', label.name),
        b('edit', () => edit(label)),
        b(label.deletedAt !== null ? 'restore' : 'delete', () =>
          saveLabel({ ...label, deletedAt: label.deletedAt !== null ? null : Date.now() }),
        ),
        b('favorite', () => saveLabel({ ...label, favorite: !label.favorite })),
      )
      body.append(row)
    }
  }
  paint()
  taskForm({ title: labelKey('labels'), action: t('common.close'), fields: [body] }, async () => {})
  const dialog = body.closest('dialog')!,
    controller = new AbortController()
  dialog.addEventListener('close', () => controller.abort(), { once: true })
  taskChanges.addEventListener(
    'update',
    () => {
      void readTasks().then(
        (next) => {
          if (!controller.signal.aborted) {
            data = next
            paint()
          }
        },
        (e) => showNotice(storageError(e)),
      )
    },
    { signal: controller.signal },
  )
}
function sectionDialog(data: TaskData, projectId: string) {
  const body = element('div', 'task-management')
  const edit = (id?: string) => {
    const current = data.taskSections.find((s) => s.id === id)
    const name = field(labelKey('sectionName'), 'text', current?.name ?? '')
    name.input.required = true
    taskForm(
      {
        title: labelKey(current ? 'editSection' : 'newSection'),
        action: labelKey('saveSection'),
        fields: [name.wrapper],
      },
      async () => {
        await saveSection({ ...current, name: name.input.value.trim(), projectId })
      },
    )
  }
  const paint = () => {
    body.replaceChildren(b('newSection', () => edit()))
    for (const section of data.taskSections
      .filter((s) => s.projectId === projectId && s.deletedAt === null)
      .sort((a, b) => a.order - b.order)) {
      const row = element('div', 'task-management-row')
      row.append(
        element('span', '', section.name),
        b('editSection', () => edit(section.id)),
        b('delete', () => deleteSection(section.id)),
        b('up', () => reorderSection(section.id, -1)),
        b('down', () => reorderSection(section.id, 1)),
      )
      body.append(row)
    }
  }
  paint()
  taskForm(
    { title: labelKey('manageSections'), action: t('common.close'), fields: [body] },
    async () => {},
  )
  const dialog = body.closest('dialog')!,
    controller = new AbortController()
  dialog.addEventListener('close', () => controller.abort(), { once: true })
  taskChanges.addEventListener(
    'update',
    () => {
      void readTasks().then(
        (next) => {
          if (!controller.signal.aborted) {
            data = next
            paint()
          }
        },
        (e) => showNotice(storageError(e)),
      )
    },
    { signal: controller.signal },
  )
}

export function renderTasks(root: HTMLElement, signal: AbortSignal) {
  const page = element('section', 'task-workspace'),
    heading = element('header', 'page-heading'),
    nav = element('nav', 'task-nav'),
    content = element('div', 'task-content')
  heading.append(
    element('div', '', labelKey('intro')),
    link('#/', t('navigation.home'), 'button button-quiet'),
  )
  const title = element('h1', '', labelKey('workspace'))
  heading.prepend(title)
  const layout = element('div', 'task-layout')
  layout.append(nav, content)
  page.append(heading, layout)
  root.append(page)
  let data = emptyTasks(),
    request = 0,
    calendarDate = dateKey(),
    contextLink: TaskWorkLink | undefined,
    displayLimit = 200,
    rendered = 0,
    historyExpanded = false
  let childrenIndex = new Map<string, Task[]>(),
    siblingIndex = new Map<string, Task[]>()
  const locationKey = (task: Task) => [task.projectId, task.sectionId, task.parentId].join(':')
  const selected = new Set<string>()
  const route = () => decodeURIComponent(location.hash.replace(/^#\/tasks\/?/, '') || 'inbox')
  const query = field(labelKey('search'), 'search')
  query.input.placeholder = labelKey('searchHint')
  query.input.addEventListener('input', () => paintContent())
  const quick = element('form', 'task-quick'),
    input = element('input', 'title-input')
  input.required = true
  input.maxLength = 500
  input.setAttribute('aria-label', labelKey('quick'))
  input.placeholder = labelKey('quick')
  const add = button(labelKey('add'), 'button button-primary')
  add.type = 'submit'
  quick.append(input, add)
  quick.addEventListener('submit', (event) => {
    event.preventDefault()
    add.disabled = true
    void addTask(input.value, {
      projectId: route().startsWith('project/') ? route().slice(8) : null,
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
        add.disabled = false
      })
  })

  function paintNav() {
    nav.replaceChildren()
    nav.setAttribute('aria-label', labelKey('workspace'))
    for (const key of [
      'inbox',
      'today',
      'upcoming',
      'all',
      'completed',
      'trash',
      'templates',
      'statistics',
    ]) {
      const item = link('#/tasks/' + key, labelKey(key), 'task-nav-item')
      if (route() === key) item.setAttribute('aria-current', 'page')
      nav.append(item)
    }
    nav.append(
      b('newProject', () => projectDialog(data)),
      b('labels', () => labelsDialog(data)),
      b('newFilter', () => filterDialog(data)),
    )
    for (const filter of data.taskFilters)
      nav.append(
        link(
          '#/tasks/filter/' + filter.id,
          (filter.favorite ? '★ ' : '') + filter.name,
          'task-nav-item',
        ),
      )
    const projects = data.taskProjects
      .filter((p) => p.deletedAt === null)
      .sort((a, b) => a.order - b.order)
    const appendProject = (p: TaskProject, depth: number) => {
      const item = link(
        '#/tasks/project/' + p.id,
        (p.favorite ? '★ ' : '') + p.icon + ' ' + p.name,
        'task-nav-item',
      )
      item.style.borderInlineStartColor = p.color
      item.style.paddingInlineStart = 10 + Math.min(depth, 8) * 10 + 'px'
      if (route() === 'project/' + p.id) item.setAttribute('aria-current', 'page')
      nav.append(item)
      projects
        .filter((c) => c.parentId === p.id && (c.archivedAt !== null) === (p.archivedAt !== null))
        .forEach((c) => appendProject(c, depth + 1))
    }
    nav.append(element('h2', '', labelKey('project')))
    projects
      .filter(
        (p) =>
          p.archivedAt === null &&
          (!p.parentId || !projects.some((v) => v.id === p.parentId && v.archivedAt === null)),
      )
      .forEach((p) => appendProject(p, 0))
    if (projects.some((p) => p.archivedAt !== null)) {
      nav.append(element('h2', '', labelKey('archived')))
      projects
        .filter(
          (p) =>
            p.archivedAt !== null &&
            (!p.parentId || !projects.some((v) => v.id === p.parentId && v.archivedAt !== null)),
        )
        .forEach((p) => appendProject(p, 0))
    }
    for (const label of data.taskLabels.filter((l) => l.deletedAt === null && l.favorite))
      nav.append(link('#/tasks/label/' + label.id, '# ' + label.name, 'task-nav-item'))
  }
  function visibleTasks() {
    const current = route(),
      today = dateKey(),
      projectId = current.startsWith('project/') ? current.slice(8) : null
    const archived = new Set(
      data.taskProjects
        .filter((p) => p.archivedAt !== null)
        .flatMap((p) => [...descendants(data.taskProjects, [p.id])]),
    )
    return data.tasks
      .filter((task) => {
        if (!taskMatches(task, query.input.value)) return false
        if (current.startsWith('filter/')) {
          const filter = data.taskFilters.find((f) => f.id === current.slice(7))
          return Boolean(filter && matchesFilter(task, filter.group))
        }
        if (current.startsWith('work/'))
          return (
            !task.link?.unconfirmed &&
            task.link?.library === current.split('/')[1] &&
            task.link?.bookId === current.split('/')[2]
          )
        if (current === 'trash') return task.deletedAt !== null
        if (task.deletedAt !== null) return false
        if (current === 'completed') return task.completedAt !== null
        if (task.completedAt !== null) return false
        if (projectId) return task.projectId === projectId
        if (task.projectId && archived.has(task.projectId)) return false
        if (current === 'today')
          return (
            (scheduleDay(task) !== null && scheduleDay(task)! <= today) ||
            Boolean(task.deadline && task.deadline < today)
          )
        if (current === 'upcoming') return scheduleDay(task) !== null && scheduleDay(task)! > today
        if (current === 'inbox') return task.projectId === null
        if (current.startsWith('label/')) return task.labelIds.includes(current.slice(6))
        return true
      })
      .sort((a, b) =>
        ['today', 'upcoming', 'completed'].includes(current)
          ? (a.planDate ?? '').localeCompare(b.planDate ?? '') ||
            a.priority - b.priority ||
            a.order - b.order
          : a.order - b.order,
      )
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
        selected.clear()
      },
    )
  }
  function moveDialog(ids: string[]) {
    const project = choices(labelKey('project'), [
      ['', labelKey('inbox')],
      ...data.taskProjects
        .filter((p) => p.deletedAt === null && p.archivedAt === null)
        .map((p) => [p.id, p.name] as [string, string]),
    ])
    taskForm(
      { title: labelKey('move'), action: labelKey('move'), fields: [project.wrapper] },
      async () => {
        await moveTasks(ids, project.input.value || null, null)
        selected.clear()
      },
    )
  }
  function bulkControls() {
    const controls = element('div', 'task-bulk')
    controls.append(
      element('span', '', t('tasks.selected', [selected.size])),
      b('clear', () => {
        selected.clear()
        paintContent()
      }),
      b('move', () => moveDialog([...selected])),
      b('complete', () => completeTasks([...selected], true)),
      b('delete', () => confirmDelete([...selected])),
    )
    const priority = choices(labelKey('priority'), [
      ['', labelKey('priority')],
      ...[1, 2, 3, 4].map((p) => [String(p), 'P' + p] as [string, string]),
    ])
    priority.input.addEventListener('change', () => {
      if (priority.input.value)
        void batchTasks([...selected], { priority: Number(priority.input.value) }).catch((e) =>
          showNotice(storageError(e)),
        )
    })
    const date = field(labelKey('date'), 'date')
    date.input.addEventListener(
      'change',
      () =>
        void batchTasks([...selected], { planDate: date.input.value || null }).catch((e) =>
          showNotice(storageError(e)),
        ),
    )
    controls.append(priority.wrapper, date.wrapper)
    return controls
  }
  function taskRow(task: Task, depth: number, visible: Set<string>, flat = false): HTMLElement {
    rendered++
    const row = element('li', 'task-row')
    row.dataset.taskId = task.id
    row.style.setProperty('--task-depth', String(Math.min(depth, 8)))
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
      if (id && id !== task.id)
        void moveTasks([id], task.projectId, task.sectionId, task.parentId, task.id).catch((e) =>
          showNotice(storageError(e)),
        )
    })
    const select = element('input')
    select.type = 'checkbox'
    select.checked = selected.has(task.id)
    select.setAttribute('aria-label', labelKey('select') + ' ' + task.title)
    select.addEventListener('change', () => {
      if (select.checked) selected.add(task.id)
      else selected.delete(task.id)
      paintContent()
    })
    const text = button(task.title, 'task-title')
    text.addEventListener('click', () => {
      void taskDialog(data, task).catch((e) => showNotice(storageError(e)))
    })
    text.style.color = ['', '#b63030', '#aa6817', '#386ba1', 'var(--ink)'][task.priority]
    const copy = element('div', 'task-copy')
    copy.append(text)
    const meta = element('div', 'file-details')
    meta.append(element('span', '', 'P' + task.priority))
    if (task.planDate) {
      const instant = scheduleInstant(task),
        overdue =
          task.completedAt === null &&
          (instant === null ? task.planDate < dateKey() : instant < Date.now())
      meta.append(element('span', overdue ? 'task-overdue' : '', task.planDate))
    }
    for (const id of task.labelIds) {
      const label = data.taskLabels.find((l) => l.id === id && l.deletedAt === null)
      if (label) meta.append(link('#/tasks/label/' + id, '#' + label.name))
    }
    copy.append(meta)
    const actions = element('div', 'task-actions')
    if (task.deletedAt !== null)
      actions.append(b('restore', () => restoreTaskGroup(task.deletionId!)))
    else {
      actions.append(
        b(task.completedAt !== null ? 'reopen' : 'complete', () =>
          completeTasks([task.id], task.completedAt === null, {
            id: task.id,
            revision: task.revision,
          }),
        ),
      )
      actions.append(
        b('extras', () => taskExtras(data, task)),
        b('saveTemplate', () => saveTemplateDialog(task)),
      )
      if (task.link) actions.append(taskLinkButton(task.link))
      actions.append(
        b('subtask', () =>
          taskDialog(data, undefined, {
            parentId: task.id,
            projectId: task.projectId,
            sectionId: task.sectionId,
            ...(task.link
              ? {
                  link: {
                    library: task.link.library,
                    bookId: task.link.bookId,
                    title: task.link.title,
                    ...(task.link.unconfirmed ? { unconfirmed: true } : {}),
                  },
                }
              : {}),
          }),
        ),
        b('copy', () => copyTask(task.id)),
        b('move', () => moveDialog([task.id])),
        b('delete', () => confirmDelete([task.id])),
      )
      const siblings = siblingIndex.get(locationKey(task)) ?? [],
        index = siblings.findIndex((t) => t.id === task.id)
      const up = b('up', () =>
        moveTasks(
          [task.id],
          task.projectId,
          task.sectionId,
          task.parentId,
          siblings[index - 1]?.id,
        ),
      )
      up.disabled = index === 0
      const down = b('down', () =>
        moveTasks(
          [task.id],
          task.projectId,
          task.sectionId,
          task.parentId,
          siblings[index + 2]?.id,
        ),
      )
      down.disabled = index === siblings.length - 1
      actions.append(up, down)
    }
    if (task.planTime) meta.append(element('span', '', task.planTime + ' ' + (task.zone ?? '')))
    if (task.deadline) meta.append(element('span', '', labelKey('deadline') + ': ' + task.deadline))
    if (task.repeat) meta.append(element('span', '', labelKey('repeat.' + task.repeat.frequency)))
    const children = flat ? [] : (childrenIndex.get(task.id) ?? [])
    if (children.length) {
      const toggle = b(task.expanded ? 'collapse' : 'expand', () =>
        editTask(task.id, task.revision, { expanded: !task.expanded }),
      )
      row.append(toggle)
    }
    row.append(select, copy, actions)
    if (children.length && (task.expanded || query.input.value)) {
      const list = element('ul', 'task-list')
      for (const child of children)
        if (rendered < displayLimit) list.append(taskRow(child, depth + 1, visible))
      row.append(list)
    }
    return row
  }
  function paintContent() {
    const focused = document.activeElement,
      selection =
        focused instanceof HTMLInputElement && (focused === query.input || focused === input)
          ? [focused.selectionStart, focused.selectionEnd]
          : undefined
    const current = route(),
      project = current.startsWith('project/')
        ? data.taskProjects.find((p) => p.id === current.slice(8))
        : undefined
    const top = element('div', 'task-toolbar')
    top.append(
      query.wrapper,
      b('add', () =>
        taskDialog(data, undefined, {
          projectId: project?.id ?? null,
          ...(contextLink ? { link: contextLink } : {}),
        }),
      ),
      b('undo', () => undoTaskChange()),
    )
    if (project) {
      top.prepend(element('h2', '', project.icon + ' ' + project.name))
      top.append(
        b('manageProject', () => projectDialog(data, project)),
        b('up', () => reorderProject(project.id, -1)),
        b('down', () => reorderProject(project.id, 1)),
        b('favorite', () =>
          saveProject({ ...project, favorite: !project.favorite }, project.revision),
        ),
        b(project.archivedAt !== null ? 'unarchiveProject' : 'archiveProject', () =>
          saveProject(
            { ...project, archivedAt: project.archivedAt !== null ? null : Date.now() },
            project.revision,
          ),
        ),
        b('manageSections', () => sectionDialog(data, project.id)),
        b('deleteProject', () =>
          taskForm(
            {
              title: labelKey('deleteProject'),
              action: labelKey('deleteProject'),
              description: labelKey('deleteProjectHint'),
              danger: true,
            },
            async () => {
              await deleteProject(project.id)
              location.hash = '#/tasks/trash'
            },
          ),
        ),
      )
    }
    const filter = current.startsWith('filter/')
      ? data.taskFilters.find((f) => f.id === current.slice(7))
      : undefined
    if (filter)
      top.append(
        b('editFilter', () => filterDialog(data, filter)),
        b('favorite', () => saveFilterFavorite()),
        b('deleteFilter', () => deleteFilter(filter.id)),
      )
    function saveFilterFavorite() {
      if (filter) return saveFilter({ ...filter, favorite: !filter.favorite })
    }
    if (current === 'templates' || current === 'statistics') {
      content.replaceChildren(
        top,
        current === 'templates' ? templatesView(data, null) : statsView(data),
        taskTransferControls(),
      )
      return
    }
    if (contextLink) top.prepend(element('h2', '', contextLink.title))
    let view = project?.view ?? defaultTaskView()
    if (!project) {
      try {
        const stored = data.taskSettings.find((s) => s.id === 'view:' + current)
        if (stored) {
          const parsed = JSON.parse(stored.value)
          validateTaskView(parsed)
          view = parsed
        }
      } catch {
        /* A corrupt preference cannot affect task data. */
      }
    }
    const saveView = async (patch: Partial<TaskView>) => {
      const next = { ...view, ...patch }
      if (project) await saveProject({ ...project, view: next }, project.revision)
      else await saveTaskSetting('view:' + current, JSON.stringify(next))
    }
    const mode = choices(
      labelKey('view'),
      ['list', 'board', 'calendar', 'table'].map((m) => [m, labelKey('view.' + m)]),
      view.mode,
    )
    mode.input.onchange = () =>
      void saveView({ mode: mode.input.value as TaskView['mode'] }).catch((e) =>
        showNotice(storageError(e)),
      )
    const sort = choices(
      labelKey('sort'),
      ['order', 'priority', 'date', 'title'].map((m) => [m, labelKey('sort.' + m)]),
      view.sort,
    )
    sort.input.onchange = () =>
      void saveView({ sort: sort.input.value as TaskView['sort'] }).catch((e) =>
        showNotice(storageError(e)),
      )
    top.append(mode.wrapper, sort.wrapper)
    if (view.mode === 'calendar') {
      const period = choices(
        labelKey('calendarPeriod'),
        [
          ['month', labelKey('month')],
          ['week', labelKey('week')],
        ],
        view.calendar,
      )
      period.input.onchange = () =>
        void saveView({ calendar: period.input.value as TaskView['calendar'] }).catch((e) =>
          showNotice(storageError(e)),
        )
      top.append(period.wrapper)
    }
    let tasks = visibleTasks()
    if (view.sort !== 'order')
      tasks = tasks.sort((a, b) =>
        view.sort === 'priority'
          ? a.priority - b.priority || a.order - b.order
          : view.sort === 'title'
            ? a.title.localeCompare(b.title)
            : (scheduleDay(a) ?? '9999').localeCompare(scheduleDay(b) ?? '9999') ||
              a.order - b.order,
      )
    childrenIndex = new Map()
    siblingIndex = new Map()
    rendered = 0
    for (const task of tasks)
      if (task.parentId) {
        const children = childrenIndex.get(task.parentId) ?? []
        children.push(task)
        childrenIndex.set(task.parentId, children)
      }
    for (const task of data.tasks
      .filter((t) => t.deletedAt === null)
      .sort((a, b) => a.order - b.order)) {
      const key = locationKey(task),
        siblings = siblingIndex.get(key) ?? []
      siblings.push(task)
      siblingIndex.set(key, siblings)
    }
    const visible = new Set(tasks.map((t) => t.id)),
      list = element('ul', 'task-list')
    list.setAttribute('aria-label', labelKey('workspace'))
    if (view.mode === 'calendar') {
      const pivot = new Date(calendarDate + 'T12:00:00Z'),
        start =
          view.calendar === 'week'
            ? new Date(pivot.getTime() - ((pivot.getUTCDay() + 6) % 7) * 86400000)
            : new Date(
                Date.UTC(
                  pivot.getUTCFullYear(),
                  pivot.getUTCMonth(),
                  1 -
                    ((new Date(
                      Date.UTC(pivot.getUTCFullYear(), pivot.getUTCMonth(), 1),
                    ).getUTCDay() +
                      6) %
                      7),
                  12,
                ),
              ),
        end = new Date(start.getTime() + (view.calendar === 'week' ? 7 : 42) * 86400000),
        from = start.toISOString().slice(0, 10),
        until = end.toISOString().slice(0, 10)
      tasks = tasks.filter((t) => {
        const day = scheduleDay(t)
        return !day || (day >= from && day < until)
      })
    }
    if (view.mode === 'list')
      for (const task of tasks.filter((t) => !t.parentId || !visible.has(t.parentId)))
        if (rendered < displayLimit) list.append(taskRow(task, 0, visible))
    const visual =
      view.mode === 'list'
        ? list
        : taskVisuals(
            data,
            tasks.slice(0, displayLimit),
            view,
            project?.id ?? null,
            (task, flat) => taskRow(task, 0, visible, flat),
            calendarDate,
            (date) => {
              calendarDate = date
              paintContent()
            },
          )
    content.replaceChildren(
      top,
      ...(current !== 'trash' && current !== 'completed' ? [quick] : []),
      ...(selected.size ? [bulkControls()] : []),
      tasks.length || view.mode !== 'list' ? visual : notice(labelKey('empty')),
    )
    if (rendered >= displayLimit && tasks.length > rendered)
      content.append(
        b('loadMore', () => {
          displayLimit += 200
          paintContent()
        }),
      )
    content.append(
      taskTransferControls(),
      reminderControls(
        data.taskSettings.find((s) => s.id === 'reminders:enabled')?.value === 'true',
      ),
    )
    if (selection && focused instanceof HTMLInputElement) {
      focused.focus({ preventScroll: true })
      focused.setSelectionRange(selection[0], selection[1])
    }
    if (current === 'trash')
      for (const project of data.taskProjects.filter((p) => p.deletedAt !== null)) {
        const row = element('div', 'task-management-row')
        row.append(
          element('span', '', project.name),
          b('restoreProject', () => restoreTaskGroup(project.deletionId!)),
        )
        content.append(row)
      }
    if (current === 'completed') {
      const details = element('details'),
        byId = new Map(data.tasks.map((t) => [t.id, t])),
        reversed = new Set(data.taskCompletions.map((e) => e.reverts))
      details.open = historyExpanded
      details.ontoggle = () => {
        historyExpanded = details.open
      }
      details.append(element('summary', '', labelKey('history')))
      const events = data.taskCompletions
        .slice()
        .sort((a, b) => b.at - a.at)
        .filter((event) =>
          taskMatches({ ...byId.get(event.taskId)!, title: event.title }, query.input.value),
        )
      for (const event of events.slice(0, displayLimit)) {
        const entry = element(
          'p',
          '',
          new Date(event.at).toLocaleString() +
            ' · ' +
            event.title +
            ' · ' +
            labelKey(event.reverts ? 'reopen' : 'complete'),
        )
        if (!event.reverts && !reversed.has(event.id))
          entry.append(b('reopenOccurrence', () => reopenCompletion(event.id)))
        details.append(entry)
      }
      if (events.length > displayLimit)
        details.append(
          b('loadMore', () => {
            displayLimit += 200
            historyExpanded = true
            paintContent()
          }),
        )
      content.append(details)
    }
  }
  async function refresh() {
    const turn = ++request
    try {
      const next = await readTasks()
      if (signal.aborted || turn !== request) return
      data = next
      contextLink = undefined
      if (route().startsWith('work/')) {
        const [, library, id] = route().split('/')
        if (library === 'original' || library === 'reference') {
          const stored = await readBook(library, id)
          if (signal.aborted || turn !== request) return
          if (stored && !stored.book.workId)
            contextLink = { library, bookId: id, title: stored.book.title }
        }
      }
      for (const id of selected) if (!data.tasks.some((t) => t.id === id)) selected.delete(id)
      paintNav()
      paintContent()
    } catch (e) {
      if (!signal.aborted) content.replaceChildren(notice(storageError(e), true))
    }
  }
  taskChanges.addEventListener('update', () => void refresh(), { signal })
  window.addEventListener('focus', () => void refresh(), { signal })
  window.addEventListener(
    'keydown',
    (event) => {
      if (
        document.querySelector('dialog[open]') ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      )
        return
      if (event.key === 'n' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        input.focus()
      }
      if (event.key === '/') {
        event.preventDefault()
        query.input.focus()
      }
      if (event.key === 'Escape') {
        selected.clear()
        paintContent()
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        void undoTaskChange().catch((e) => showNotice(storageError(e)))
      }
      if (event.altKey && event.key === 'Enter' && selected.size) {
        event.preventDefault()
        void completeTasks([...selected], true).catch((e) => showNotice(storageError(e)))
      }
    },
    { signal },
  )
  void refresh()
}
