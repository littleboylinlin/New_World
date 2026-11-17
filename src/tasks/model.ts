/** Local task records have their own identities and lifecycle, independent of ideas. */
export interface Task {
  id: string
  title: string
  description: string
  notes: string
  projectId: string | null
  sectionId: string | null
  parentId: string | null
  priority: number
  labelIds: string[]
  order: number
  expanded: boolean
  planDate: string | null
  completedAt: number | null
  deletedAt: number | null
  deletionId?: string
  createdAt: number
  updatedAt: number
  revision: number
  planTime?: string
  zone?: string
  fold?: 'earlier' | 'later'
  deadline?: string
  durationMinutes?: number
  repeat?: TaskRepeat
  reminderMinutes?: number
  link?: TaskWorkLink
  comments?: TaskComment[]
}
export interface TaskWorkLink {
  library: 'original' | 'reference'
  bookId: string
  title: string
  editionId?: string
  chapterId?: string
  position?: { from: number; to: number; quote: string; contentHash: string }
  unconfirmed?: boolean
}
export interface TaskComment {
  id: string
  text: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}
export interface TaskAttachment {
  id: string
  taskId: string
  name: string
  type: string
  bytes: number
  sha256: string
  content: Blob
}
export interface TaskTemplate {
  id: string
  name: string
  tasks: Task[]
  attachments: TaskAttachment[]
}
export interface TaskRepeat {
  frequency: 'day' | 'week' | 'month' | 'year'
  interval: number
  anchorDate: string
  weekdays?: number[]
  monthDays?: number[]
  until?: string
}
export type TaskViewMode = 'list' | 'board' | 'calendar' | 'table'
export interface TaskView {
  mode: TaskViewMode
  calendar: 'month' | 'week'
  sort: 'order' | 'priority' | 'date' | 'title'
}
export interface TaskProject {
  id: string
  name: string
  color: string
  icon: string
  parentId: string | null
  order: number
  favorite: boolean
  archivedAt: number | null
  deletedAt: number | null
  deletionId?: string
  revision: number
  view?: TaskView
}
export interface TaskSection {
  id: string
  projectId: string
  name: string
  order: number
  deletedAt: number | null
  deletionId?: string
  revision?: number
}
export interface TaskLabel {
  id: string
  name: string
  color: string
  favorite: boolean
  deletedAt: number | null
  revision?: number
}
export interface TaskCycleState {
  taskId: string
  planDate: string | null
  completedAt: number | null
  revision: number
}
export interface TaskCompletion {
  id: string
  taskId: string
  title: string
  at: number
  occurrence: string | null
  reverts?: string
  next?: string
  cycle?: TaskCycleState[]
}
export type TaskCondition = {
  field: 'text' | 'project' | 'label' | 'priority' | 'state' | 'date' | 'deadline'
  op: 'is' | 'not' | 'before' | 'after'
  value: string
}
export interface TaskFilterGroup {
  operator: 'all' | 'any'
  conditions: (TaskCondition | TaskFilterGroup)[]
}
export interface TaskFilter {
  id: string
  name: string
  favorite: boolean
  group: TaskFilterGroup
  revision?: number
}
export interface TaskSetting {
  id: string
  value: string
}
// Separate stores keep personal tasks out of novel metadata and project archives.
export const taskStores = [
  'tasks',
  'taskProjects',
  'taskSections',
  'taskLabels',
  'taskCompletions',
  'taskSettings',
  'taskFilters',
  'taskTemplates',
  'taskAttachments',
] as const
export type TaskStore = (typeof taskStores)[number]
export interface TaskData {
  tasks: Task[]
  taskProjects: TaskProject[]
  taskSections: TaskSection[]
  taskLabels: TaskLabel[]
  taskCompletions: TaskCompletion[]
  taskSettings: TaskSetting[]
  taskFilters: TaskFilter[]
  taskTemplates: TaskTemplate[]
  taskAttachments: TaskAttachment[]
}
export const emptyTasks = (): TaskData => ({
  tasks: [],
  taskProjects: [],
  taskSections: [],
  taskLabels: [],
  taskCompletions: [],
  taskSettings: [],
  taskFilters: [],
  taskTemplates: [],
  taskAttachments: [],
})
export function projectTaskData(data: Partial<TaskData>): TaskData {
  return Object.fromEntries(
    taskStores.map((name) => [name, data[name] ?? []]),
  ) as unknown as TaskData
}
export const taskLimits = { records: 30000, text: 20000, title: 500, depth: 32 }
export const taskId = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
export const dateKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
export function validDate(v: unknown): v is string {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    v < '1900-01-01' ||
    v > '9999-12-31'
  )
    return false
  const d = new Date(v + 'T12:00:00Z')
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v
}
export class TaskDataError extends Error {
  readonly detail: string
  constructor(detail: string) {
    super('Invalid task data: ' + detail)
    this.name = 'TaskDataError'
    this.detail = detail
  }
}
export function taskAssert(value: unknown, detail: string): asserts value {
  if (!value) throw new TaskDataError(detail)
}
export function closed(v: any, required: string, optional = '') {
  taskAssert(
    v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(v)),
    'object',
  )
  const allowed = new Set((required + ' ' + optional).split(' ').filter(Boolean))
  taskAssert(
    Object.keys(v).every((k) => allowed.has(k)) &&
      required
        .split(' ')
        .filter(Boolean)
        .every((k) => Object.hasOwn(v, k)),
    'unsupported or missing field',
  )
}
const text = (v: unknown, max = taskLimits.text) =>
  typeof v === 'string' && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)
const name = (v: unknown) => text(v, taskLimits.title) && String(v).trim().length > 0
const num = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const time = (v: unknown) => num(v) && Number(v) <= 253402214399999
const stamp = (v: unknown) => v === null || time(v)
const color = (v: unknown) => typeof v === 'string' && /^#[a-f0-9]{6}$/i.test(v)

/** Preflight before asynchronous resource traversal; oversized arrays must not spawn promises. */
export function taskEnvelope(data: unknown, nodeLimit = 1_000_000) {
  closed(data, taskStores.join(' '))
  let count = 0
  for (const key of taskStores) {
    const rows = (data as TaskData)[key]
    taskAssert(Array.isArray(rows), key)
    count += rows.length
    taskAssert(count <= taskLimits.records, 'record limit')
  }
  let nodes = 0
  const visit = (value: unknown, depth: number) => {
    taskAssert(++nodes <= nodeLimit && depth <= 64, 'task JSON complexity')
    if (
      value === null ||
      value === undefined ||
      ['string', 'boolean'].includes(typeof value) ||
      value instanceof Blob
    )
      return
    if (typeof value === 'number') {
      taskAssert(Number.isFinite(value), 'finite number')
      return
    }
    taskAssert(typeof value === 'object', 'inert JSON value')
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    taskAssert([Object.prototype, null].includes(Object.getPrototypeOf(value)), 'plain task object')
    for (const [key, item] of Object.entries(value!)) {
      taskAssert(!['__proto__', 'prototype', 'constructor'].includes(key), 'unsafe task JSON key')
      visit(item, depth + 1)
    }
  }
  visit(data, 0)
}

/** Native codecs plus a linear alphabet check avoid regex stack exhaustion on large assets. */
export function taskBase64(value: unknown, bytes: number): Uint8Array<ArrayBuffer> {
  taskAssert(
    typeof value === 'string' &&
      Number.isSafeInteger(bytes) &&
      bytes >= 0 &&
      bytes <= 16 * 1024 * 1024 &&
      value.length === 4 * Math.ceil(bytes / 3),
    'base64 size',
  )
  taskAssert(!/[^A-Za-z0-9+/=]/.test(value), 'base64 alphabet')
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new TaskDataError('base64 encoding')
  }
  taskAssert(binary.length === bytes && btoa(binary) === value, 'canonical base64')
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

/** Closed schema, bounded records and complete graph validation; used before every atomic write/import. */
export function validateTasks(data: TaskData) {
  taskEnvelope(data)
  for (const key of taskStores) {
    taskAssert(new Set(data[key].map((r) => r.id)).size === data[key].length, 'duplicate ' + key)
  }
  taskAssert(
    new TextEncoder().encode(JSON.stringify(data)).byteLength <= 32 * 1024 * 1024,
    'JSON size limit',
  )
  const tasks = new Map(data.tasks.map((t) => [t.id, t])),
    projects = new Map(data.taskProjects.map((p) => [p.id, p]))
  const labels = new Set(data.taskLabels.map((l) => l.id)),
    sections = new Map(data.taskSections.map((s) => [s.id, s]))
  function tree<T extends { id: string; parentId: string | null }>(row: T, rows: Map<string, T>) {
    taskAssert(row.parentId === null || taskId(row.parentId), 'parent identity')
    const seen = new Set([row.id])
    let p = row.parentId
    while (p) {
      taskAssert(rows.has(p) && !seen.has(p) && seen.size < taskLimits.depth, 'parent/cycle/depth')
      seen.add(p)
      p = rows.get(p)!.parentId
    }
  }
  for (const p of data.taskProjects) {
    closed(
      p,
      'id name color icon parentId order favorite archivedAt deletedAt revision',
      'deletionId view',
    )
    taskAssert(
      taskId(p.id) &&
        name(p.name) &&
        color(p.color) &&
        text(p.icon, 16) &&
        num(p.order) &&
        typeof p.favorite === 'boolean' &&
        stamp(p.archivedAt) &&
        stamp(p.deletedAt) &&
        num(p.revision),
      'project',
    )
    tree(p, projects)
    if (p.deletedAt === null && p.parentId)
      taskAssert(projects.get(p.parentId)?.deletedAt === null, 'restore parent project first')
    if (p.deletionId !== undefined)
      taskAssert(taskId(p.deletionId) && p.deletedAt !== null, 'project deletion')
    if (p.view !== undefined) validateTaskView(p.view)
  }
  for (const s of data.taskSections) {
    closed(s, 'id projectId name order deletedAt', 'deletionId revision')
    taskAssert(
      taskId(s.id) &&
        projects.has(s.projectId) &&
        name(s.name) &&
        num(s.order) &&
        stamp(s.deletedAt) &&
        (s.revision === undefined || num(s.revision)),
      'section',
    )
    if (s.deletionId !== undefined)
      taskAssert(taskId(s.deletionId) && s.deletedAt !== null, 'section deletion')
  }
  for (const l of data.taskLabels) {
    closed(l, 'id name color favorite deletedAt', 'revision')
    taskAssert(
      taskId(l.id) &&
        name(l.name) &&
        color(l.color) &&
        typeof l.favorite === 'boolean' &&
        stamp(l.deletedAt) &&
        (l.revision === undefined || num(l.revision)),
      'label',
    )
  }
  for (const t of data.tasks) {
    closed(
      t,
      'id title description notes projectId sectionId parentId priority labelIds order expanded planDate completedAt deletedAt createdAt updatedAt revision',
      'deletionId planTime zone fold deadline durationMinutes repeat reminderMinutes link comments',
    )
    taskAssert(
      taskId(t.id) &&
        name(t.title) &&
        text(t.description) &&
        text(t.notes) &&
        [1, 2, 3, 4].includes(t.priority) &&
        num(t.order) &&
        typeof t.expanded === 'boolean' &&
        time(t.createdAt) &&
        time(t.updatedAt) &&
        num(t.revision) &&
        stamp(t.completedAt) &&
        stamp(t.deletedAt) &&
        (t.planDate === null || validDate(t.planDate)),
      'task',
    )
    taskAssert(t.projectId === null || projects.has(t.projectId), 'project reference')
    if (t.deletedAt === null && t.projectId)
      taskAssert(projects.get(t.projectId)?.deletedAt === null, 'restore project first')
    taskAssert(
      t.sectionId === null || sections.get(t.sectionId)?.projectId === t.projectId,
      'section reference',
    )
    if (t.deletedAt === null && t.sectionId)
      taskAssert(sections.get(t.sectionId)?.deletedAt === null, 'restore section first')
    taskAssert(
      Array.isArray(t.labelIds) &&
        t.labelIds.length <= 100 &&
        new Set(t.labelIds).size === t.labelIds.length &&
        t.labelIds.every((l) => labels.has(l)),
      'labels',
    )
    tree(t, tasks)
    if (t.parentId) {
      const p = tasks.get(t.parentId)!
      taskAssert(p.projectId === t.projectId && p.sectionId === t.sectionId, 'subtask location')
      taskAssert(t.deletedAt !== null || p.deletedAt === null, 'deleted parent')
    }
    if (t.deletionId !== undefined)
      taskAssert(taskId(t.deletionId) && t.deletedAt !== null, 'task deletion')
    validateSchedule(t)
    if (t.link !== undefined) validateTaskLink(t.link)
    if (t.parentId) {
      const p = tasks.get(t.parentId)!
      taskAssert(
        (p.link?.library ?? null) === (t.link?.library ?? null) &&
          (p.link?.bookId ?? null) === (t.link?.bookId ?? null) &&
          Boolean(p.link?.unconfirmed) === Boolean(t.link?.unconfirmed),
        'subtask work ownership; detach before relinking',
      )
    }
    if (t.comments !== undefined) {
      taskAssert(
        Array.isArray(t.comments) &&
          t.comments.length <= 1000 &&
          new Set(t.comments.map((c) => c.id)).size === t.comments.length,
        'comments',
      )
      for (const c of t.comments) {
        closed(c, 'id text createdAt updatedAt deletedAt')
        taskAssert(
          taskId(c.id) &&
            text(c.text) &&
            c.text.trim().length > 0 &&
            time(c.createdAt) &&
            time(c.updatedAt) &&
            stamp(c.deletedAt),
          'comment',
        )
      }
    }
    if (t.repeat) {
      let parent = t.parentId
      while (parent) {
        const p = tasks.get(parent)!
        taskAssert(!p.repeat, 'a repeating subtree has one recurrence rule')
        parent = p.parentId
      }
    }
  }
  const events = new Map(data.taskCompletions.map((e) => [e.id, e]))
  for (const e of data.taskCompletions) {
    closed(e, 'id taskId title at occurrence', 'reverts next cycle')
    taskAssert(
      taskId(e.id) &&
        tasks.has(e.taskId) &&
        name(e.title) &&
        time(e.at) &&
        (e.occurrence === null || validDate(e.occurrence)) &&
        (e.reverts === undefined ||
          (taskId(e.reverts) &&
            events.get(e.reverts)?.taskId === e.taskId &&
            !events.get(e.reverts)?.reverts &&
            events.get(e.reverts)!.at <= e.at)) &&
        (e.next === undefined || validDate(e.next)),
      'completion history',
    )
    if (e.cycle !== undefined) {
      taskAssert(
        e.next &&
          Array.isArray(e.cycle) &&
          e.cycle.length > 0 &&
          e.cycle.length <= taskLimits.records &&
          new Set(e.cycle.map((c) => c.taskId)).size === e.cycle.length &&
          e.cycle.some((c) => c.taskId === e.taskId && c.planDate === e.occurrence),
        'repeat cycle snapshot',
      )
      for (const c of e.cycle) {
        closed(c, 'taskId planDate completedAt revision')
        taskAssert(
          taskId(c.taskId) &&
            (c.planDate === null || validDate(c.planDate)) &&
            stamp(c.completedAt) &&
            num(c.revision),
          'cycle historical identity/state',
        )
      }
    }
  }
  const reversed = data.taskCompletions.filter((e) => e.reverts).map((e) => e.reverts)
  taskAssert(new Set(reversed).size === reversed.length, 'duplicate completion reversal')
  for (const filter of data.taskFilters) {
    closed(filter, 'id name favorite group', 'revision')
    taskAssert(
      taskId(filter.id) &&
        name(filter.name) &&
        typeof filter.favorite === 'boolean' &&
        (filter.revision === undefined || num(filter.revision)),
      'filter',
    )
    validateFilterGroup(filter.group)
    const refs = (g: TaskFilterGroup) => {
      for (const c of g.conditions)
        if ('operator' in c) refs(c)
        else if (c.field === 'project')
          taskAssert(c.value === '' || projects.has(c.value), 'filter project reference')
        else if (c.field === 'label') taskAssert(labels.has(c.value), 'filter label reference')
    }
    refs(filter.group)
  }
  for (const s of data.taskSettings) {
    closed(s, 'id value')
    taskAssert(text(s.id, 255) && text(s.value, 50000), 'setting')
  }
  let bytes = 0
  for (const a of data.taskAttachments) {
    validateAttachment(a)
    taskAssert(tasks.has(a.taskId), 'attachment task')
    bytes += a.bytes
  }
  for (const template of data.taskTemplates) {
    closed(template, 'id name tasks attachments')
    taskAssert(
      taskId(template.id) &&
        name(template.name) &&
        Array.isArray(template.tasks) &&
        template.tasks.length > 0 &&
        template.tasks.length <= 1000 &&
        template.tasks.every((t) => t.projectId === null && t.sectionId === null) &&
        Array.isArray(template.attachments),
      'template',
    )
    const mini = {
      ...emptyTasks(),
      tasks: template.tasks,
      taskAttachments: template.attachments,
      taskProjects: data.taskProjects,
      taskSections: data.taskSections,
      taskLabels: data.taskLabels,
    }
    validateTasks(mini)
    bytes += template.attachments.reduce((sum, a) => sum + a.bytes, 0)
  }
  taskAssert(bytes <= 64 * 1024 * 1024, 'attachment total limit')
}
export function validateTaskLink(link: TaskWorkLink) {
  closed(link, 'library bookId title', 'editionId chapterId position unconfirmed')
  taskAssert(
    ['original', 'reference'].includes(link.library) &&
      taskId(link.bookId) &&
      text(link.title, 500),
    'work link',
  )
  if (link.editionId !== undefined) taskAssert(taskId(link.editionId), 'edition link')
  if (link.chapterId !== undefined)
    taskAssert(taskId(link.chapterId) && link.editionId !== undefined, 'chapter link')
  if (link.unconfirmed !== undefined)
    taskAssert(typeof link.unconfirmed === 'boolean', 'unconfirmed link')
  if (link.position !== undefined) {
    closed(link.position, 'from to quote contentHash')
    taskAssert(
      link.chapterId &&
        num(link.position.from) &&
        num(link.position.to) &&
        link.position.to >= link.position.from &&
        link.position.to <= 10000000 &&
        text(link.position.quote, 2000) &&
        /^[a-f0-9]{16}$/.test(link.position.contentHash),
      'editor position',
    )
  }
}
export function validateAttachment(a: TaskAttachment) {
  closed(a, 'id taskId name type bytes sha256 content')
  taskAssert(
    taskId(a.id) &&
      taskId(a.taskId) &&
      name(a.name) &&
      a.name.length <= 255 &&
      !/[\\/\x00-\x1f]/.test(a.name) &&
      typeof a.type === 'string' &&
      a.type.length <= 255 &&
      num(a.bytes) &&
      a.bytes <= 16 * 1024 * 1024 &&
      /^[a-f0-9]{64}$/.test(a.sha256) &&
      a.content instanceof Blob &&
      a.content.size === a.bytes &&
      a.content.type === a.type,
    'attachment',
  )
}
export function descendants<T extends { id: string; parentId: string | null }>(
  rows: T[],
  ids: Iterable<string>,
): Set<string> {
  const found = new Set(ids)
  for (let i = 0; i < taskLimits.depth; i++) {
    const before = found.size
    for (const row of rows) if (row.parentId && found.has(row.parentId)) found.add(row.id)
    if (found.size === before) break
  }
  return found
}
export function taskMatches(task: Task, query: string) {
  return [
    task.title,
    task.description,
    task.notes,
    task.link?.title,
    ...(task.comments ?? []).filter((c) => c.deletedAt === null).map((c) => c.text),
  ]
    .join('\n')
    .toLocaleLowerCase()
    .includes(query.toLocaleLowerCase())
}

/** Only explicit identity/reference fields are remapped, never arbitrary text or provenance hashes. */
export function taskIdentities(data: TaskData) {
  const ids = new Set<string>()
  for (const name of taskStores)
    if (name !== 'taskSettings') for (const row of data[name]) ids.add(row.id)
  for (const e of data.taskCompletions) for (const c of e.cycle ?? []) ids.add(c.taskId)
  for (const task of [...data.tasks, ...data.taskTemplates.flatMap((t) => t.tasks)]) {
    ids.add(task.id)
    if (task.deletionId) ids.add(task.deletionId)
    for (const c of task.comments ?? []) ids.add(c.id)
  }
  for (const p of [...data.taskProjects, ...data.taskSections])
    if (p.deletionId) ids.add(p.deletionId)
  for (const a of data.taskTemplates.flatMap((t) => t.attachments)) ids.add(a.id)
  return ids
}
export function detachedTaskIds(data: TaskData) {
  const ids = new Set(data.tasks.map((t) => t.id))
  return [
    ...new Set(
      data.taskCompletions.flatMap((e) =>
        (e.cycle ?? []).filter((c) => !ids.has(c.taskId)).map((c) => c.taskId),
      ),
    ),
  ].sort()
}
export function remapTasks(data: TaskData, mapping: Map<string, string>) {
  const map = (id: string) => mapping.get(id) ?? id,
    maybe = (id: string | null) => (id === null ? null : map(id))
  const task = (t: Task) => {
    t.id = map(t.id)
    t.parentId = maybe(t.parentId)
    t.projectId = maybe(t.projectId)
    t.sectionId = maybe(t.sectionId)
    t.labelIds = t.labelIds.map(map)
    if (t.deletionId) t.deletionId = map(t.deletionId)
    for (const c of t.comments ?? []) c.id = map(c.id)
  }
  const attachment = (a: TaskAttachment) => {
    a.id = map(a.id)
    a.taskId = map(a.taskId)
  }
  data.tasks.forEach(task)
  data.taskAttachments.forEach(attachment)
  for (const p of data.taskProjects) {
    p.id = map(p.id)
    p.parentId = maybe(p.parentId)
    if (p.deletionId) p.deletionId = map(p.deletionId)
  }
  for (const s of data.taskSections) {
    s.id = map(s.id)
    s.projectId = map(s.projectId)
    if (s.deletionId) s.deletionId = map(s.deletionId)
  }
  for (const l of data.taskLabels) l.id = map(l.id)
  for (const e of data.taskCompletions) {
    e.id = map(e.id)
    e.taskId = map(e.taskId)
    if (e.reverts) e.reverts = map(e.reverts)
    for (const c of e.cycle ?? []) c.taskId = map(c.taskId)
  }
  function group(g: TaskFilterGroup) {
    for (const c of g.conditions)
      if ('operator' in c) group(c)
      else if (c.field === 'project' || c.field === 'label') c.value = map(c.value)
  }
  for (const f of data.taskFilters) {
    f.id = map(f.id)
    group(f.group)
  }
  for (const t of data.taskTemplates) {
    t.id = map(t.id)
    t.tasks.forEach(task)
    t.attachments.forEach(attachment)
  }
}

export function validateTaskView(v: TaskView) {
  closed(v, 'mode calendar sort')
  taskAssert(
    ['list', 'board', 'calendar', 'table'].includes(v.mode) &&
      ['month', 'week'].includes(v.calendar) &&
      ['order', 'priority', 'date', 'title'].includes(v.sort),
    'view',
  )
}
export const defaultTaskView = (): TaskView => ({ mode: 'list', calendar: 'month', sort: 'order' })
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const zoneFormats = new Map<string, Intl.DateTimeFormat>()
export function zonedParts(stamp: number, zone: string) {
  let format = zoneFormats.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    if (zoneFormats.size >= 64) zoneFormats.delete(zoneFormats.keys().next().value!)
    zoneFormats.set(zone, format)
  }
  const parts = format.formatToParts(stamp)
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]))
}
export function zonedDate(stamp: number, zone: string) {
  const p = zonedParts(stamp, zone)
  return `${p.year}-${p.month}-${p.day}`
}
const calendarDate = (value: string) => new Date(value + 'T12:00:00Z')
export function addDays(value: string, days: number) {
  const d = calendarDate(value)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const dayNumber = (date: string) => Math.floor(calendarDate(date).getTime() / 86400000)
export function monthDate(year: number, month: number, day: number) {
  const d = new Date(Date.UTC(year, month + 1, 0, 12))
  d.setUTCDate(Math.min(day, d.getUTCDate()))
  return d.toISOString().slice(0, 10)
}
/** Returns both folds of an overlapping wall time, or none for a DST gap; never guesses a missing hour. */
export function wallTimes(date: string, time: string, zone: string): number[] {
  taskAssert(validDate(date) && /^([01]\d|2[0-3]):[0-5]\d$/.test(time), 'date/time')
  const base = Date.parse(date + 'T' + time + ':00Z'),
    offsets = new Set<number>()
  for (const delta of [-86400000, -43200000, 0, 43200000, 86400000]) {
    const stamp = base + delta,
      p = zonedParts(stamp, zone)
    offsets.add(
      Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour),
        Number(p.minute),
        Number(p.second),
      ) - stamp,
    )
  }
  return [...offsets]
    .map((offset) => base - offset)
    .filter((stamp) => {
      const p = zonedParts(stamp, zone)
      return (
        `${p.year}-${p.month}-${p.day}` === date &&
        `${p.hour}:${p.minute}` === time &&
        p.second === '00'
      )
    })
    .sort((a, b) => a - b)
}
export function scheduleInstant(
  task: Pick<Task, 'planDate' | 'planTime' | 'zone' | 'fold'>,
): number | null {
  if (!task.planDate || !task.planTime) return null
  const times = wallTimes(task.planDate, task.planTime, task.zone ?? localZone())
  taskAssert(times.length, 'nonexistent wall time (DST); choose another time')
  return task.fold === 'later' ? times.at(-1)! : times[0]
}
export function scheduleDay(task: Task) {
  const instant = scheduleInstant(task)
  return instant === null ? task.planDate : dateKey(new Date(instant))
}
/** Calendar cells are device-local days; keep the task's wall clock when dragging across zones. */
export function planDateForLocalDay(task: Task, target: string) {
  taskAssert(validDate(target), 'calendar target date')
  if (!task.planTime) return target
  for (const shift of [0, -1, 1, -2, 2]) {
    const candidate = addDays(target, shift)
    if (!validDate(candidate)) continue
    try {
      if (scheduleDay({ ...task, planDate: candidate }) === target) return candidate
    } catch {
      /* A DST gap is not a valid target. */
    }
  }
  throw new TaskDataError('no valid scheduled wall time on the selected local day')
}
export function validateSchedule(task: Task) {
  if (task.zone !== undefined) {
    taskAssert(typeof task.zone === 'string' && task.zone.length <= 100, 'timezone')
    try {
      zonedParts(0, task.zone)
    } catch {
      taskAssert(false, 'timezone')
    }
  }
  if (task.planTime !== undefined) {
    taskAssert(
      typeof task.planTime === 'string' && task.planDate !== null && task.zone !== undefined,
      'time requires date and explicit timezone',
    )
    scheduleInstant(task)
  }
  if (task.fold !== undefined) taskAssert(['earlier', 'later'].includes(task.fold), 'DST fold')
  if (task.deadline !== undefined) taskAssert(validDate(task.deadline), 'deadline')
  if (task.durationMinutes !== undefined)
    taskAssert(
      Number.isSafeInteger(task.durationMinutes) &&
        task.durationMinutes >= 0 &&
        task.durationMinutes <= 525600,
      'duration',
    )
  if (task.reminderMinutes !== undefined)
    taskAssert(
      Number.isSafeInteger(task.reminderMinutes) &&
        task.reminderMinutes >= 0 &&
        task.reminderMinutes <= 43200 &&
        scheduleInstant(task) !== null,
      'reminder requires scheduled time',
    )
  if (task.repeat !== undefined) {
    const r = task.repeat
    closed(r, 'frequency interval anchorDate', 'weekdays monthDays until')
    taskAssert(
      ['day', 'week', 'month', 'year'].includes(r.frequency) &&
        Number.isSafeInteger(r.interval) &&
        r.interval >= 1 &&
        r.interval <= 3660 &&
        validDate(r.anchorDate) &&
        task.planDate !== null &&
        r.anchorDate <= task.planDate,
      'repeat',
    )
    if (r.until !== undefined)
      taskAssert(validDate(r.until) && r.until >= r.anchorDate, 'repeat end')
    if (r.weekdays !== undefined)
      taskAssert(
        r.frequency === 'week' &&
          Array.isArray(r.weekdays) &&
          r.weekdays.length > 0 &&
          r.weekdays.length <= 7 &&
          new Set(r.weekdays).size === r.weekdays.length &&
          r.weekdays.every((n) => Number.isInteger(n) && n >= 0 && n <= 6),
        'weekdays',
      )
    if (r.monthDays !== undefined)
      taskAssert(
        r.frequency === 'month' &&
          Array.isArray(r.monthDays) &&
          r.monthDays.length > 0 &&
          r.monthDays.length <= 31 &&
          new Set(r.monthDays).size === r.monthDays.length &&
          r.monthDays.every((n) => Number.isInteger(n) && n >= 1 && n <= 31),
        'month days',
      )
  }
}
/** Calendar-based recurrence, anchored to the original schedule; skips overdue occurrences without inventing completions. */
export function nextOccurrence(task: Task, now = Date.now()): string | null {
  const r = task.repeat
  if (!r || !task.planDate) return null
  const after = [task.planDate, zonedDate(now, task.zone ?? localZone())].sort().at(-1)!,
    anchor = calendarDate(r.anchorDate)
  let next: string | undefined
  if (r.frequency === 'day')
    next = addDays(
      r.anchorDate,
      (Math.max(0, Math.floor((dayNumber(after) - dayNumber(r.anchorDate)) / r.interval)) + 1) *
        r.interval,
    )
  else if (r.frequency === 'week') {
    const monday = addDays(r.anchorDate, -((anchor.getUTCDay() + 6) % 7)),
      weekdays = r.weekdays ?? [anchor.getUTCDay()]
    for (let i = 1; i <= 7 * r.interval + 7; i++) {
      const candidate = addDays(after, i),
        week = Math.floor((dayNumber(candidate) - dayNumber(monday)) / 7)
      if (
        week >= 0 &&
        week % r.interval === 0 &&
        weekdays.includes(calendarDate(candidate).getUTCDay())
      ) {
        next = candidate
        break
      }
    }
  } else if (r.frequency === 'month') {
    const a = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth(),
      d = calendarDate(after),
      start = d.getUTCFullYear() * 12 + d.getUTCMonth()
    for (let month = start; month <= start + r.interval + 1; month++) {
      if ((month - a) % r.interval !== 0) continue
      const candidates = [
        ...new Set(
          (r.monthDays ?? [anchor.getUTCDate()]).map((day) =>
            monthDate(Math.floor(month / 12), month % 12, day),
          ),
        ),
      ].sort()
      next = candidates.find((c) => c > after)
      if (next) break
    }
  } else {
    const year = calendarDate(after).getUTCFullYear()
    for (let y = year; y <= year + r.interval; y++)
      if ((y - anchor.getUTCFullYear()) % r.interval === 0) {
        const c = monthDate(y, anchor.getUTCMonth(), anchor.getUTCDate())
        if (c > after) {
          next = c
          break
        }
      }
  }
  if (!next || !validDate(next) || (r.until && next > r.until)) return null
  if (task.planTime) scheduleInstant({ ...task, planDate: next })
  return next
}
export function validateFilterGroup(group: TaskFilterGroup, depth = 0, budget = { rules: 0 }) {
  closed(group, 'operator conditions')
  taskAssert(
    depth <= 8 &&
      ['all', 'any'].includes(group.operator) &&
      Array.isArray(group.conditions) &&
      group.conditions.length <= 50,
    'filter group',
  )
  for (const c of group.conditions) {
    taskAssert(++budget.rules <= 100, 'filter rule limit')
    if ('operator' in c) validateFilterGroup(c, depth + 1, budget)
    else {
      closed(c, 'field op value')
      taskAssert(
        ['text', 'project', 'label', 'priority', 'state', 'date', 'deadline'].includes(c.field) &&
          ['is', 'not', 'before', 'after'].includes(c.op) &&
          typeof c.value === 'string' &&
          c.value.length <= 500,
        'condition',
      )
      if (c.field === 'priority')
        taskAssert(['1', '2', '3', '4'].includes(c.value), 'filter priority')
      if (c.field === 'state')
        taskAssert(['active', 'completed', 'deleted'].includes(c.value), 'filter state')
      if (['date', 'deadline'].includes(c.field)) taskAssert(validDate(c.value), 'filter date')
      else taskAssert(['is', 'not'].includes(c.op), 'filter operator')
    }
  }
}
export function matchesFilter(task: Task, group: TaskFilterGroup): boolean {
  const results = group.conditions.map((c) => {
    if ('operator' in c) return matchesFilter(task, c)
    let found = false
    if (c.field === 'text') found = taskMatches(task, c.value)
    else if (c.field === 'project') found = (task.projectId ?? '') === c.value
    else if (c.field === 'label') found = task.labelIds.includes(c.value)
    else if (c.field === 'priority') found = String(task.priority) === c.value
    else if (c.field === 'state')
      found =
        (task.deletedAt !== null
          ? 'deleted'
          : task.completedAt !== null
            ? 'completed'
            : 'active') === c.value
    else {
      const date = c.field === 'date' ? scheduleDay(task) : task.deadline
      found = Boolean(
        date &&
          (c.op === 'before'
            ? date < c.value
            : c.op === 'after'
              ? date > c.value
              : date === c.value),
      )
    }
    return c.op === 'not' ? !found : found
  })
  return group.operator === 'all' ? results.every(Boolean) : results.some(Boolean)
}
export interface ParsedTaskDate {
  date: string
  time?: string
  repeat?: TaskRepeat
  phrase: string
}
export function parseTaskDate(input: string, now = new Date()): ParsedTaskDate | null {
  const today = dateKey(now),
    text = input.toLocaleLowerCase(),
    matches: ParsedTaskDate[] = []
  for (const [pattern, delta] of [
    [/今天|\btoday\b/, 0],
    [/明天|(?<!day after )\btomorrow\b/, 1],
    [/后天|\bday after tomorrow\b/, 2],
  ] as const) {
    const m = text.match(pattern)
    if (m) matches.push({ date: addDays(today, delta), phrase: m[0] })
  }
  const monthly = text.match(
    /下个?月\s*(\d{1,2})\s*[号日]|next month(?: on)?\s+(\d{1,2})(?:st|nd|rd|th)?/,
  )
  if (monthly) {
    const n = Number(monthly[1] ?? monthly[2]),
      d = calendarDate(today),
      candidate = monthDate(d.getUTCFullYear(), d.getUTCMonth() + 1, n)
    if (n < 1 || n > 31 || Number(candidate.slice(-2)) !== n) return null
    matches.push({ date: candidate, phrase: monthly[0] })
  }
  const weekly = text.match(
    /每周([一二三四五六日天])|\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
  )
  if (weekly) {
    const weekday = weekly[1]
      ? { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[weekly[1]]!
      : ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(
          weekly[2],
        )
    const date = addDays(today, (weekday - calendarDate(today).getUTCDay() + 7) % 7)
    matches.push({
      date,
      phrase: weekly[0],
      repeat: { frequency: 'week', interval: 1, anchorDate: date, weekdays: [weekday] },
    })
  }
  const repeatMatches = [
    ...text.matchAll(
      /每隔\s*(\d+)\s*([天周])|\bevery\s+(\d+)\s+(days?|weeks?)\b|每天|每日|每年|每月|\bevery (?:day|week|month|year)\b|\bdaily\b|\bweekly\b|\bmonthly\b|\byearly\b/g,
    ),
  ]
  if (repeatMatches.length > 1) return null
  const repeats = repeatMatches[0]
  if (repeats) {
    const frequency: TaskRepeat['frequency'] =
        repeats[2] === '周' || /week/.test(repeats[0])
          ? 'week'
          : /年|year/.test(repeats[0])
            ? 'year'
            : /月|month/.test(repeats[0])
              ? 'month'
              : 'day',
      interval = Number(repeats[1] ?? repeats[3] ?? 1)
    if (interval < 1 || interval > 3660) return null
    matches.push({
      date: today,
      phrase: repeats[0],
      repeat: { frequency, interval, anchorDate: today },
    })
  }
  if (matches.length !== 1) return null
  const result = matches[0],
    clocks = [
      ...text.matchAll(
        /(上午|下午|晚上|凌晨|早上|中午)([零〇一二三四五六七八九十\d]+)[点时](?:(半|一刻|三刻|[零〇一二三四五六七八九十\d]+)分?)?|\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b([01]\d|2[0-3]):([0-5]\d)\b/g,
      ),
    ]
  if (clocks.length > 1) return null
  const clock = clocks[0]
  const chinese = (v: string) => {
    if (/^\d+$/.test(v)) return Number(v)
    const nums: Record<string, number> = {
      零: 0,
      〇: 0,
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
    }
    if (v === '十') return 10
    if (v.includes('十')) {
      const [a, b] = v.split('十')
      return (a ? nums[a] : 1) * 10 + (b ? nums[b] : 0)
    }
    return nums[v] ?? NaN
  }
  if (clock) {
    let hour: number, minute: number
    if (clock[1]) {
      hour = chinese(clock[2])
      minute = clock[3] ? ({ 半: 30, 一刻: 15, 三刻: 45 }[clock[3]] ?? chinese(clock[3])) : 0
      if (hour < 1 || hour > 12) return null
      if (clock[1] === '中午') {
        if (![11, 12, 1, 2].includes(hour)) return null
        if (hour <= 2) hour += 12
      } else if (clock[1] === '晚上') {
        if (hour < 6 || hour === 12) return null
        hour += 12
      } else if (clock[1] === '下午') hour = (hour % 12) + 12
      else {
        if (['上午', '早上'].includes(clock[1]) && hour === 12) return null
        hour %= 12
      }
    } else if (clock[6]) {
      hour = Number(clock[4])
      minute = Number(clock[5] ?? 0)
      if (hour < 1 || hour > 12) return null
      hour = (hour % 12) + (clock[6] === 'pm' ? 12 : 0)
    } else {
      hour = Number(clock[7])
      minute = Number(clock[8])
    }
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59)
      return null
    result.time = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0')
  } else if (/\bat\s+\d|\d\s*[点时]|\d{1,2}:\d{2}/.test(text)) return null
  return result
}
