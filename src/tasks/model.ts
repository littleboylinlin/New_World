/** Local task records have their own identities and lifecycle, independent of ideas. */
export interface Task {
  id: string; title: string; description: string; notes: string
  projectId: string | null; sectionId: string | null; parentId: string | null
  priority: number; labelIds: string[]; order: number; expanded: boolean
  planDate: string | null; completedAt: number | null; deletedAt: number | null; deletionId?: string
  createdAt: number; updatedAt: number; revision: number
  planTime?: string; zone?: string; fold?: 'earlier' | 'later'
  deadline?: string; durationMinutes?: number; repeat?: TaskRepeat; reminderMinutes?: number
}
export interface TaskRepeat { frequency: 'day'|'week'|'month'|'year'; interval: number; anchorDate: string; weekdays?: number[]; monthDays?: number[]; until?: string }
export type TaskViewMode = 'list'|'board'|'calendar'|'table'
export interface TaskView { mode: TaskViewMode; calendar: 'month'|'week'; sort: 'order'|'priority'|'date'|'title' }
export interface TaskProject {
  id: string; name: string; color: string; icon: string; parentId: string | null; order: number
  favorite: boolean; archivedAt: number | null; deletedAt: number | null; deletionId?: string; revision: number
  view?: TaskView
}
export interface TaskSection { id: string; projectId: string; name: string; order: number; deletedAt: number | null; deletionId?: string }
export interface TaskLabel { id: string; name: string; color: string; favorite: boolean; deletedAt: number | null }
export interface TaskCompletion { id: string; taskId: string; title: string; at: number; occurrence: string | null; reverts?: string; next?: string }
export type TaskCondition = { field: 'text'|'project'|'label'|'priority'|'state'|'date'|'deadline'; op: 'is'|'not'|'before'|'after'; value: string }
export interface TaskFilterGroup { operator: 'all'|'any'; conditions: (TaskCondition|TaskFilterGroup)[] }
export interface TaskFilter { id: string; name: string; favorite: boolean; group: TaskFilterGroup }
export interface TaskSetting { id: string; value: string }
// Empty reserved tables allow the staged implementation to keep one non-destructive v8 → v9 migration.
export const taskStores = ['tasks', 'taskProjects', 'taskSections', 'taskLabels', 'taskCompletions', 'taskSettings', 'taskFilters', 'taskTemplates', 'taskAttachments'] as const
export type TaskStore = typeof taskStores[number]
export interface TaskData {
  tasks: Task[]; taskProjects: TaskProject[]; taskSections: TaskSection[]; taskLabels: TaskLabel[]
  taskCompletions: TaskCompletion[]; taskSettings: TaskSetting[]
  taskFilters: TaskFilter[]; taskTemplates: never[]; taskAttachments: never[]
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
  taskAssert(!data.taskTemplates.length&&!data.taskAttachments.length, 'unsupported future task records')
  taskAssert(new TextEncoder().encode(JSON.stringify(data)).byteLength <= 32*1024*1024, 'JSON size limit')
  const tasks = new Map(data.tasks.map(t => [t.id,t])), projects = new Map(data.taskProjects.map(p => [p.id,p]))
  const labels = new Set(data.taskLabels.map(l => l.id)), sections = new Map(data.taskSections.map(s => [s.id,s]))
  function tree<T extends { id: string; parentId: string | null }>(row: T, rows: Map<string,T>) {
    taskAssert(row.parentId===null || taskId(row.parentId),'parent identity')
    const seen = new Set([row.id]); let p = row.parentId
    while (p) { taskAssert(rows.has(p) && !seen.has(p) && seen.size < taskLimits.depth, 'parent/cycle/depth'); seen.add(p); p = rows.get(p)!.parentId }
  }
  for (const p of data.taskProjects) {
    closed(p,'id name color icon parentId order favorite archivedAt deletedAt revision','deletionId view')
    taskAssert(taskId(p.id) && name(p.name) && color(p.color) && text(p.icon,16) && num(p.order) && typeof p.favorite==='boolean' && stamp(p.archivedAt) && stamp(p.deletedAt) && num(p.revision), 'project')
    tree(p,projects)
    if(p.deletedAt===null&&p.parentId)taskAssert(projects.get(p.parentId)?.deletedAt===null,'restore parent project first')
    if (p.deletionId!==undefined) taskAssert(taskId(p.deletionId)&&p.deletedAt!==null,'project deletion')
    if(p.view!==undefined)validateTaskView(p.view)
  }
  for (const s of data.taskSections) { closed(s,'id projectId name order deletedAt','deletionId'); taskAssert(taskId(s.id) && projects.has(s.projectId) && name(s.name) && num(s.order) && stamp(s.deletedAt),'section') }
  for (const l of data.taskLabels) { closed(l,'id name color favorite deletedAt'); taskAssert(taskId(l.id) && name(l.name) && color(l.color) && typeof l.favorite==='boolean' && stamp(l.deletedAt),'label') }
  const labelNames=data.taskLabels.filter(l=>l.deletedAt===null).map(l=>l.name.trim().toLocaleLowerCase())
  taskAssert(new Set(labelNames).size===labelNames.length,'duplicate label name')
  for (const t of data.tasks) {
    closed(t,'id title description notes projectId sectionId parentId priority labelIds order expanded planDate completedAt deletedAt createdAt updatedAt revision','deletionId planTime zone fold deadline durationMinutes repeat reminderMinutes')
    taskAssert(taskId(t.id) && name(t.title) && text(t.description) && text(t.notes) && [1,2,3,4].includes(t.priority) && num(t.order) && typeof t.expanded==='boolean' && num(t.createdAt) && num(t.updatedAt) && num(t.revision) && stamp(t.completedAt) && stamp(t.deletedAt) && (t.planDate===null || validDate(t.planDate)), 'task')
    taskAssert(t.projectId===null || projects.has(t.projectId), 'project reference')
    if(t.deletedAt===null&&t.projectId)taskAssert(projects.get(t.projectId)?.deletedAt===null,'restore project first')
    taskAssert(t.sectionId===null || sections.get(t.sectionId)?.projectId===t.projectId, 'section reference')
    if(t.deletedAt===null&&t.sectionId)taskAssert(sections.get(t.sectionId)?.deletedAt===null,'restore section first')
    taskAssert(Array.isArray(t.labelIds) && t.labelIds.length <= 100 && new Set(t.labelIds).size===t.labelIds.length && t.labelIds.every(l=>labels.has(l)), 'labels')
    tree(t,tasks)
    if (t.parentId) { const p=tasks.get(t.parentId)!; taskAssert(p.projectId===t.projectId && p.sectionId===t.sectionId, 'subtask location'); taskAssert(t.deletedAt!==null || p.deletedAt===null,'deleted parent') }
    if(t.deletionId!==undefined)taskAssert(taskId(t.deletionId)&&t.deletedAt!==null,'task deletion')
    validateSchedule(t)
    if(t.repeat){let parent=t.parentId;while(parent){const p=tasks.get(parent)!;taskAssert(!p.repeat,'a repeating subtree has one recurrence rule');parent=p.parentId}}
  }
  const events = new Map(data.taskCompletions.map(e => [e.id,e]))
  for (const e of data.taskCompletions) { closed(e,'id taskId title at occurrence','reverts next'); taskAssert(taskId(e.id) && tasks.has(e.taskId) && name(e.title) && num(e.at) && (e.occurrence===null || validDate(e.occurrence)) && (!e.reverts || (events.get(e.reverts)?.taskId===e.taskId && !events.get(e.reverts)?.reverts && events.get(e.reverts)!.at<=e.at)) && (e.next===undefined||validDate(e.next)), 'completion history') }
  const reversed=data.taskCompletions.filter(e=>e.reverts).map(e=>e.reverts)
  taskAssert(new Set(reversed).size===reversed.length,'duplicate completion reversal')
  for(const filter of data.taskFilters){closed(filter,'id name favorite group');taskAssert(taskId(filter.id)&&name(filter.name)&&typeof filter.favorite==='boolean','filter');validateFilterGroup(filter.group)}
  for (const s of data.taskSettings) { closed(s,'id value'); taskAssert(text(s.id,255) && text(s.value,50000),'setting') }
}
export function descendants<T extends { id: string; parentId: string | null }>(rows: T[], ids: Iterable<string>): Set<string> {
  const found = new Set(ids)
  for (let i=0;i<taskLimits.depth;i++) { const before=found.size; for(const row of rows) if(row.parentId && found.has(row.parentId)) found.add(row.id); if(found.size===before) break }
  return found
}
export function taskMatches(task: Task, query: string) { return [task.title,task.description,task.notes].join('\n').toLocaleLowerCase().includes(query.toLocaleLowerCase()) }

export function validateTaskView(v:TaskView) {closed(v,'mode calendar sort');taskAssert(['list','board','calendar','table'].includes(v.mode)&&['month','week'].includes(v.calendar)&&['order','priority','date','title'].includes(v.sort),'view')}
export const defaultTaskView = ():TaskView => ({mode:'list',calendar:'month',sort:'order'})
export const localZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone
export function zonedParts(stamp:number,zone:string) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(stamp)
  return Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,p.value]))
}
export function zonedDate(stamp:number,zone:string){const p=zonedParts(stamp,zone);return `${p.year}-${p.month}-${p.day}`}
const calendarDate=(value:string)=>new Date(value+'T12:00:00Z')
export function addDays(value:string,days:number) {const d=calendarDate(value);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
const dayNumber=(date:string)=>Math.floor(calendarDate(date).getTime()/86400000)
export function monthDate(year:number,month:number,day:number){const d=new Date(Date.UTC(year,month+1,0,12));d.setUTCDate(Math.min(day,d.getUTCDate()));return d.toISOString().slice(0,10)}
/** Returns both folds of an overlapping wall time, or none for a DST gap; never guesses a missing hour. */
export function wallTimes(date:string,time:string,zone:string):number[] {
  taskAssert(validDate(date)&&/^([01]\d|2[0-3]):[0-5]\d$/.test(time),'date/time')
  const base=Date.parse(date+'T'+time+':00Z'),offsets=new Set<number>()
  for(const delta of [-86400000,-43200000,0,43200000,86400000]){const stamp=base+delta,p=zonedParts(stamp,zone);offsets.add(Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)-stamp)}
  return [...offsets].map(offset=>base-offset).filter(stamp=>{const p=zonedParts(stamp,zone);return `${p.year}-${p.month}-${p.day}`===date&&`${p.hour}:${p.minute}`===time&&p.second==='00'}).sort((a,b)=>a-b)
}
export function scheduleInstant(task:Pick<Task,'planDate'|'planTime'|'zone'|'fold'>):number|null {
  if(!task.planDate||!task.planTime)return null
  const times=wallTimes(task.planDate,task.planTime,task.zone??localZone())
  taskAssert(times.length,'nonexistent wall time (DST); choose another time')
  return task.fold==='later'?times.at(-1)!:times[0]
}
export function scheduleDay(task:Task){const instant=scheduleInstant(task);return instant===null?task.planDate:dateKey(new Date(instant))}
export function validateSchedule(task:Task) {
  if(task.zone!==undefined){taskAssert(typeof task.zone==='string'&&task.zone.length<=100,'timezone');try{zonedParts(0,task.zone)}catch{taskAssert(false,'timezone')}}
  if(task.planTime!==undefined){taskAssert(typeof task.planTime==='string'&&task.planDate!==null&&task.zone!==undefined,'time requires date and explicit timezone');scheduleInstant(task)}
  if(task.fold!==undefined)taskAssert(['earlier','later'].includes(task.fold),'DST fold')
  if(task.deadline!==undefined)taskAssert(validDate(task.deadline),'deadline')
  if(task.durationMinutes!==undefined)taskAssert(Number.isSafeInteger(task.durationMinutes)&&task.durationMinutes>=0&&task.durationMinutes<=525600,'duration')
  if(task.reminderMinutes!==undefined)taskAssert(Number.isSafeInteger(task.reminderMinutes)&&task.reminderMinutes>=0&&task.reminderMinutes<=43200&&scheduleInstant(task)!==null,'reminder requires scheduled time')
  if(task.repeat){const r=task.repeat;closed(r,'frequency interval anchorDate','weekdays monthDays until');taskAssert(['day','week','month','year'].includes(r.frequency)&&Number.isSafeInteger(r.interval)&&r.interval>=1&&r.interval<=3660&&validDate(r.anchorDate)&&task.planDate!==null&&r.anchorDate<=task.planDate,'repeat');if(r.until!==undefined)taskAssert(validDate(r.until)&&r.until>=r.anchorDate,'repeat end')
    if(r.weekdays!==undefined)taskAssert(r.frequency==='week'&&Array.isArray(r.weekdays)&&r.weekdays.length>0&&r.weekdays.length<=7&&new Set(r.weekdays).size===r.weekdays.length&&r.weekdays.every(n=>Number.isInteger(n)&&n>=0&&n<=6),'weekdays')
    if(r.monthDays!==undefined)taskAssert(r.frequency==='month'&&Array.isArray(r.monthDays)&&r.monthDays.length>0&&r.monthDays.length<=31&&new Set(r.monthDays).size===r.monthDays.length&&r.monthDays.every(n=>Number.isInteger(n)&&n>=1&&n<=31),'month days')
  }
}
/** Calendar-based recurrence, anchored to the original schedule; skips overdue occurrences without inventing completions. */
export function nextOccurrence(task:Task,now=Date.now()):string|null {
  const r=task.repeat;if(!r||!task.planDate)return null
  const after=[task.planDate,zonedDate(now,task.zone??localZone())].sort().at(-1)!,anchor=calendarDate(r.anchorDate)
  let next:string|undefined
  if(r.frequency==='day')next=addDays(r.anchorDate,(Math.max(0,Math.floor((dayNumber(after)-dayNumber(r.anchorDate))/r.interval))+1)*r.interval)
  else if(r.frequency==='week'){
    const monday=addDays(r.anchorDate,-((anchor.getUTCDay()+6)%7)),weekdays=r.weekdays??[anchor.getUTCDay()]
    for(let i=1;i<=7*r.interval+7;i++){const candidate=addDays(after,i),week=Math.floor((dayNumber(candidate)-dayNumber(monday))/7);if(week>=0&&week%r.interval===0&&weekdays.includes(calendarDate(candidate).getUTCDay())){next=candidate;break}}
  }else if(r.frequency==='month'){
    const a=anchor.getUTCFullYear()*12+anchor.getUTCMonth(),d=calendarDate(after),start=d.getUTCFullYear()*12+d.getUTCMonth()
    for(let month=start;month<=start+r.interval+1;month++){if((month-a)%r.interval!==0)continue;const candidates=[...new Set((r.monthDays??[anchor.getUTCDate()]).map(day=>monthDate(Math.floor(month/12),month%12,day)))].sort();next=candidates.find(c=>c>after);if(next)break}
  }else{const year=calendarDate(after).getUTCFullYear();for(let y=year;y<=year+r.interval;y++)if((y-anchor.getUTCFullYear())%r.interval===0){const c=monthDate(y,anchor.getUTCMonth(),anchor.getUTCDate());if(c>after){next=c;break}}}
  if(!next||!validDate(next)||(r.until&&next>r.until))return null
  if(task.planTime)scheduleInstant({...task,planDate:next})
  return next
}
export function validateFilterGroup(group:TaskFilterGroup,depth=0,budget={rules:0}) {
  closed(group,'operator conditions');taskAssert(depth<=8&&['all','any'].includes(group.operator)&&Array.isArray(group.conditions)&&group.conditions.length<=50,'filter group')
  for(const c of group.conditions){taskAssert(++budget.rules<=100,'filter rule limit');if('operator'in c)validateFilterGroup(c,depth+1,budget);else{closed(c,'field op value');taskAssert(['text','project','label','priority','state','date','deadline'].includes(c.field)&&['is','not','before','after'].includes(c.op)&&typeof c.value==='string'&&c.value.length<=500,'condition');if(c.field==='priority')taskAssert(['1','2','3','4'].includes(c.value),'filter priority');if(c.field==='state')taskAssert(['active','completed','deleted'].includes(c.value),'filter state');if(['date','deadline'].includes(c.field))taskAssert(validDate(c.value),'filter date');else taskAssert(['is','not'].includes(c.op),'filter operator')}}
}
export function matchesFilter(task:Task,group:TaskFilterGroup):boolean {
  const results=group.conditions.map(c=>{if('operator'in c)return matchesFilter(task,c);let found=false
    if(c.field==='text')found=taskMatches(task,c.value)
    else if(c.field==='project')found=(task.projectId??'')===c.value
    else if(c.field==='label')found=task.labelIds.includes(c.value)
    else if(c.field==='priority')found=String(task.priority)===c.value
    else if(c.field==='state')found=(task.deletedAt!==null?'deleted':task.completedAt!==null?'completed':'active')===c.value
    else {const date=c.field==='date'?scheduleDay(task):task.deadline;found=Boolean(date&&(c.op==='before'?date<c.value:c.op==='after'?date>c.value:date===c.value))}
    return c.op==='not'?!found:found})
  return group.operator==='all'?results.every(Boolean):results.some(Boolean)
}
export interface ParsedTaskDate { date:string; time?:string; repeat?:TaskRepeat; phrase:string }
export function parseTaskDate(input:string,now=new Date()):ParsedTaskDate|null {
  const today=dateKey(now),text=input.toLocaleLowerCase(),matches:ParsedTaskDate[]=[]
  for(const [pattern,delta] of [[/今天|\btoday\b/,0],[/明天|(?<!day after )\btomorrow\b/,1],[/后天|\bday after tomorrow\b/,2]] as const){const m=text.match(pattern);if(m)matches.push({date:addDays(today,delta),phrase:m[0]})}
  const monthly=text.match(/下个?月\s*(\d{1,2})\s*[号日]|next month(?: on)?\s+(\d{1,2})(?:st|nd|rd|th)?/)
  if(monthly){const n=Number(monthly[1]??monthly[2]),d=calendarDate(today),candidate=monthDate(d.getUTCFullYear(),d.getUTCMonth()+1,n);if(n<1||n>31||Number(candidate.slice(-2))!==n)return null;matches.push({date:candidate,phrase:monthly[0]})}
  const weekly=text.match(/每周([一二三四五六日天])|\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/)
  if(weekly){const weekday=weekly[1]?{'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':0,'天':0}[weekly[1]]!:['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(weekly[2]);const date=addDays(today,(weekday-calendarDate(today).getUTCDay()+7)%7);matches.push({date,phrase:weekly[0],repeat:{frequency:'week',interval:1,anchorDate:date,weekdays:[weekday]}})}
  const repeats=text.match(/每隔\s*(\d+)\s*([天周])|\bevery\s+(\d+)\s+(days?|weeks?)\b|每天|每日|每年|每月|\bevery (?:day|week|month|year)\b|\bdaily\b|\bweekly\b|\bmonthly\b|\byearly\b/)
  if(repeats){const frequency:TaskRepeat['frequency']=repeats[2]==='周'||/week/.test(repeats[0])?'week':/年|year/.test(repeats[0])?'year':/月|month/.test(repeats[0])?'month':'day',interval=Number(repeats[1]??repeats[3]??1);if(interval<1||interval>3660)return null;matches.push({date:today,phrase:repeats[0],repeat:{frequency,interval,anchorDate:today}})}
  if(matches.length!==1)return null
  const result=matches[0],clock=text.match(/(上午|下午|晚上|凌晨|早上|中午)([零〇一二三四五六七八九十\d]+)[点时](?:([零〇一二三四五六七八九十\d]+)分?)?|\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b([01]\d|2[0-3]):([0-5]\d)\b/)
  const chinese=(v:string)=>{if(/^\d+$/.test(v))return Number(v);const nums:Record<string,number>={'零':0,'〇':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};if(v==='十')return 10;if(v.includes('十')){const [a,b]=v.split('十');return (a?nums[a]:1)*10+(b?nums[b]:0)}return nums[v]??NaN}
  if(clock){let hour:number,minute:number;if(clock[1]){hour=chinese(clock[2]);minute=clock[3]?chinese(clock[3]):0;if(hour<1||hour>12)return null;hour%=12;if(['下午','晚上','中午'].includes(clock[1]))hour+=12}else if(clock[6]){hour=Number(clock[4]);minute=Number(clock[5]??0);if(hour<1||hour>12)return null;hour=hour%12+(clock[6]==='pm'?12:0)}else{hour=Number(clock[7]);minute=Number(clock[8])}if(!Number.isInteger(hour)||!Number.isInteger(minute)||minute<0||minute>59)return null;result.time=String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0')}
  else if(/\bat\s+\d|\d\s*[点时]/.test(text))return null
  return result
}
