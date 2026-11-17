/** Local task records have their own identities and lifecycle, independent of ideas. */
export interface Task {
  id: string; title: string; description: string; notes: string
  projectId: string | null; sectionId: string | null; parentId: string | null
  priority: number; labelIds: string[]; order: number; expanded: boolean
  planDate: string | null; completedAt: number | null; deletedAt: number | null; deletionId?: string
  createdAt: number; updatedAt: number; revision: number
}
export interface TaskProject {
  id: string; name: string; color: string; icon: string; parentId: string | null; order: number
  favorite: boolean; archivedAt: number | null; deletedAt: number | null; deletionId?: string; revision: number
}
export interface TaskSection { id: string; projectId: string; name: string; order: number; deletedAt: number | null; deletionId?: string }
export interface TaskLabel { id: string; name: string; color: string; favorite: boolean; deletedAt: number | null }
export interface TaskCompletion { id: string; taskId: string; title: string; at: number; occurrence: string | null; reverts?: string }
export interface TaskSetting { id: string; value: string }
// Empty reserved tables allow the staged implementation to keep one non-destructive v8 → v9 migration.
export const taskStores = ['tasks', 'taskProjects', 'taskSections', 'taskLabels', 'taskCompletions', 'taskSettings', 'taskFilters', 'taskTemplates', 'taskAttachments'] as const
export type TaskStore = typeof taskStores[number]
export interface TaskData {
  tasks: Task[]; taskProjects: TaskProject[]; taskSections: TaskSection[]; taskLabels: TaskLabel[]
  taskCompletions: TaskCompletion[]; taskSettings: TaskSetting[]
  taskFilters: never[]; taskTemplates: never[]; taskAttachments: never[]
}
export const emptyTasks = (): TaskData => ({ tasks: [], taskProjects: [], taskSections: [], taskLabels: [], taskCompletions: [], taskSettings: [], taskFilters: [], taskTemplates: [], taskAttachments: [] })
export const taskLimits = { records: 30000, text: 20000, title: 500, depth: 32 }
export const taskId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
export const dateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
export function validDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v < '1900-01-01' || v > '9999-12-31') return false
  const d = new Date(v + 'T12:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === v
}
export function taskAssert(value: unknown, detail: string): asserts value { if (!value) throw new Error('Invalid task data: ' + detail) }
export function closed(v: any, required: string, optional = '') {
  taskAssert(v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)), 'object')
  const allowed = new Set((required + ' ' + optional).split(' ').filter(Boolean))
  taskAssert(Object.keys(v).every(k => allowed.has(k)) && required.split(' ').filter(Boolean).every(k => Object.hasOwn(v,k)), 'unsupported or missing field')
}
const text = (v: unknown, max = taskLimits.text) => typeof v === 'string' && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)
const name = (v: unknown) => text(v, taskLimits.title) && String(v).trim().length > 0
const num = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const stamp = (v: unknown) => v === null || num(v)
const color = (v: unknown) => typeof v === 'string' && /^#[a-f0-9]{6}$/i.test(v)

/** Closed schema, bounded records and complete graph validation; used before every atomic write/import. */
export function validateTasks(data: TaskData) {
  closed(data, taskStores.join(' '))
  let count = 0
  for (const key of taskStores) {
    taskAssert(Array.isArray(data[key]), key); count += data[key].length
    taskAssert(new Set(data[key].map(r => r.id)).size === data[key].length, 'duplicate ' + key)
  }
  taskAssert(count <= taskLimits.records, 'record limit')
  taskAssert(!data.taskFilters.length&&!data.taskTemplates.length&&!data.taskAttachments.length, 'unsupported future task records')
  taskAssert(new TextEncoder().encode(JSON.stringify(data)).byteLength <= 32*1024*1024, 'JSON size limit')
  const tasks = new Map(data.tasks.map(t => [t.id,t])), projects = new Map(data.taskProjects.map(p => [p.id,p]))
  const labels = new Set(data.taskLabels.map(l => l.id)), sections = new Map(data.taskSections.map(s => [s.id,s]))
  function tree<T extends { id: string; parentId: string | null }>(row: T, rows: Map<string,T>) {
    taskAssert(row.parentId===null || taskId(row.parentId),'parent identity')
    const seen = new Set([row.id]); let p = row.parentId
    while (p) { taskAssert(rows.has(p) && !seen.has(p) && seen.size < taskLimits.depth, 'parent/cycle/depth'); seen.add(p); p = rows.get(p)!.parentId }
  }
  for (const p of data.taskProjects) {
    closed(p,'id name color icon parentId order favorite archivedAt deletedAt revision','deletionId')
    taskAssert(taskId(p.id) && name(p.name) && color(p.color) && text(p.icon,16) && num(p.order) && typeof p.favorite==='boolean' && stamp(p.archivedAt) && stamp(p.deletedAt) && num(p.revision), 'project')
    tree(p,projects)
    if(p.deletedAt===null&&p.parentId)taskAssert(projects.get(p.parentId)?.deletedAt===null,'restore parent project first')
    if (p.deletionId!==undefined) taskAssert(taskId(p.deletionId)&&p.deletedAt!==null,'project deletion')
  }
  for (const s of data.taskSections) { closed(s,'id projectId name order deletedAt','deletionId'); taskAssert(taskId(s.id) && projects.has(s.projectId) && name(s.name) && num(s.order) && stamp(s.deletedAt),'section') }
  for (const l of data.taskLabels) { closed(l,'id name color favorite deletedAt'); taskAssert(taskId(l.id) && name(l.name) && color(l.color) && typeof l.favorite==='boolean' && stamp(l.deletedAt),'label') }
  const labelNames=data.taskLabels.filter(l=>l.deletedAt===null).map(l=>l.name.trim().toLocaleLowerCase())
  taskAssert(new Set(labelNames).size===labelNames.length,'duplicate label name')
  for (const t of data.tasks) {
    closed(t,'id title description notes projectId sectionId parentId priority labelIds order expanded planDate completedAt deletedAt createdAt updatedAt revision','deletionId')
    taskAssert(taskId(t.id) && name(t.title) && text(t.description) && text(t.notes) && [1,2,3,4].includes(t.priority) && num(t.order) && typeof t.expanded==='boolean' && num(t.createdAt) && num(t.updatedAt) && num(t.revision) && stamp(t.completedAt) && stamp(t.deletedAt) && (t.planDate===null || validDate(t.planDate)), 'task')
    taskAssert(t.projectId===null || projects.has(t.projectId), 'project reference')
    if(t.deletedAt===null&&t.projectId)taskAssert(projects.get(t.projectId)?.deletedAt===null,'restore project first')
    taskAssert(t.sectionId===null || sections.get(t.sectionId)?.projectId===t.projectId, 'section reference')
    if(t.deletedAt===null&&t.sectionId)taskAssert(sections.get(t.sectionId)?.deletedAt===null,'restore section first')
    taskAssert(Array.isArray(t.labelIds) && t.labelIds.length <= 100 && new Set(t.labelIds).size===t.labelIds.length && t.labelIds.every(l=>labels.has(l)), 'labels')
    tree(t,tasks)
    if (t.parentId) { const p=tasks.get(t.parentId)!; taskAssert(p.projectId===t.projectId && p.sectionId===t.sectionId, 'subtask location'); taskAssert(t.deletedAt!==null || p.deletedAt===null,'deleted parent') }
    if(t.deletionId!==undefined)taskAssert(taskId(t.deletionId)&&t.deletedAt!==null,'task deletion')
  }
  const events = new Map(data.taskCompletions.map(e => [e.id,e]))
  for (const e of data.taskCompletions) { closed(e,'id taskId title at occurrence','reverts'); taskAssert(taskId(e.id) && tasks.has(e.taskId) && name(e.title) && num(e.at) && (e.occurrence===null || validDate(e.occurrence)) && (!e.reverts || (events.get(e.reverts)?.taskId===e.taskId && !events.get(e.reverts)?.reverts)), 'completion history') }
  for (const s of data.taskSettings) { closed(s,'id value'); taskAssert(text(s.id,255) && text(s.value,50000),'setting') }
}
export function descendants<T extends { id: string; parentId: string | null }>(rows: T[], ids: Iterable<string>): Set<string> {
  const found = new Set(ids)
  for (let i=0;i<taskLimits.depth;i++) { const before=found.size; for(const row of rows) if(row.parentId && found.has(row.parentId)) found.add(row.id); if(found.size===before) break }
  return found
}
export function taskMatches(task: Task, query: string) { return [task.title,task.description,task.notes].join('\n').toLocaleLowerCase().includes(query.toLocaleLowerCase()) }
