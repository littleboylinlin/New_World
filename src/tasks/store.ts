import { openDatabase, writing } from '../library'
import { t } from '../i18n'
import { taskStores, emptyTasks, validateTasks, descendants, nextOccurrence, addDays } from './model'
import type { Task, TaskData, TaskProject, TaskLabel, TaskSection, TaskFilter } from './model'

export const taskChanges = new EventTarget()
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('new-world-tasks') : undefined
channel?.addEventListener('message', () => taskChanges.dispatchEvent(new Event('update')))
export function announceTasks() { taskChanges.dispatchEvent(new Event('update')); channel?.postMessage('update') }
export async function readTasks(): Promise<TaskData> {
  const db=await openDatabase(), tx=db.transaction([...taskStores]), data=emptyTasks()
  const pending=taskStores.map(name=>new Promise<void>((resolve,reject)=>{const q=tx.objectStore(name).getAll();q.onsuccess=()=>{(data[name] as unknown[])=q.result;resolve()};q.onerror=()=>reject(q.error)}))
  await Promise.all(pending); return data
}
let undo: { before: TaskData; after: string } | undefined
const fingerprint=(data:TaskData)=>JSON.stringify(taskStores.filter(name=>name!=='taskSettings').map(name=>[name,[...data[name]].sort((a,b)=>a.id.localeCompare(b.id))]))
/** All reads and graph edits run inside one serialized strict transaction, including conflict checks. */
export async function changeTasks<T>(edit: (data: TaskData) => T, remember = true): Promise<T> {
  const db=await openDatabase(), tx=db.transaction([...taskStores], 'readwrite', {durability:'strict'})
  const requests=taskStores.map(name=>tx.objectStore(name).getAll())
  let before: TaskData, after: string,modified=false
  const {step,done}=writing<T>(tx)
  requests.at(-1)!.onsuccess=step(()=>{
    const data=Object.fromEntries(taskStores.map((name,i)=>[name,requests[i].result])) as unknown as TaskData
    before=structuredClone(data)
    const result=edit(data); validateTasks(data)
    for (const name of taskStores) {
      const store=tx.objectStore(name), previous=new Map(before[name].map(r=>[r.id,r]))
      for(const row of data[name]) { if(JSON.stringify(previous.get(row.id))!==JSON.stringify(row)){store.put(row);modified=true} previous.delete(row.id) }
      for(const id of previous.keys()){store.delete(id);modified=true}
    }
    after=fingerprint(data); return result
  })
  const result=await done()
  if(remember&&modified) undo={before:before!,after:after!}
  if(modified)announceTasks(); return result
}
export async function undoTaskChange() {
  const change=undo; if(!change) throw new Error(t('tasks.noUndo'))
  await changeTasks(data=>{if(fingerprint(data)!==change.after)throw new Error(t('tasks.conflict'));const settings=data.taskSettings;Object.assign(data,change.before);data.taskSettings=settings},false)
  undo=undefined
}
const nextOrder=(rows:{order:number}[])=>Math.max(0,...rows.map(r=>r.order))+1024
export const defaultTask = (title: string, patch: Partial<Task> = {}): Task => ({id:crypto.randomUUID(),title:title.trim(),description:'',notes:'',projectId:null,sectionId:null,parentId:null,priority:4,labelIds:[],order:1024,expanded:true,planDate:null,completedAt:null,deletedAt:null,createdAt:Date.now(),updatedAt:Date.now(),revision:0,...patch})
function requireTask(data:TaskData,id:string,revision?:number) {const task=data.tasks.find(t=>t.id===id);if(!task || (revision!==undefined && task.revision!==revision))throw new Error(t('tasks.conflict'));return task}
function touch(task:Task) {task.updatedAt=Date.now();task.revision++}
export function addTask(title:string,patch:Partial<Task>={}) {return changeTasks(data=>{
  const parent=patch.parentId ? requireTask(data,patch.parentId) : undefined
  const task=defaultTask(title,{...patch,...(parent?{projectId:parent.projectId,sectionId:parent.sectionId}:{}),order:nextOrder(data.tasks)})
  data.tasks.push(task);return task
})}
export function editTask(id:string,revision:number,patch:Partial<Omit<Task,'id'|'createdAt'|'updatedAt'|'revision'|'completedAt'|'deletedAt'|'deletionId'>>) {return changeTasks(data=>{
  const task=requireTask(data,id,revision), all=descendants(data.tasks,[id]);Object.assign(task,structuredClone(patch))
  if(task.repeat&&task.planDate&&task.repeat.anchorDate>task.planDate)task.repeat.anchorDate=task.planDate
  if(task.parentId){const parent=requireTask(data,task.parentId);task.projectId=parent.projectId;task.sectionId=parent.sectionId}
  for(const row of data.tasks)if(all.has(row.id)){row.projectId=task.projectId;row.sectionId=task.sectionId;touch(row)}
  return task
})}
export function moveTasks(ids:string[],projectId:string|null,sectionId:string|null,parentId:string|null=null,beforeId?:string) {return changeTasks(data=>{
  const selected=new Set(ids); const roots=[...selected].filter(id=>{let parent=requireTask(data,id).parentId;while(parent){if(selected.has(parent))return false;parent=requireTask(data,parent).parentId}return true})
  const all=descendants(data.tasks,roots)
  if(parentId && all.has(parentId))throw new Error(t('tasks.cycle'))
  const parent=parentId ? requireTask(data,parentId) : undefined
  if(parent) {projectId=parent.projectId;sectionId=parent.sectionId}
  for(const id of all) {const task=requireTask(data,id);task.projectId=projectId;task.sectionId=sectionId;if(roots.includes(id))task.parentId=parentId;touch(task)}
  const siblings=data.tasks.filter(t=>t.parentId===parentId && t.projectId===projectId && t.sectionId===sectionId && !roots.includes(t.id)).sort((a,b)=>a.order-b.order)
  const at=beforeId?siblings.findIndex(t=>t.id===beforeId):-1
  siblings.splice(at<0?siblings.length:at,0,...roots.map(id=>requireTask(data,id)))
  siblings.forEach((task,i)=>{task.order=(i+1)*1024;touch(task)})
})}
export function completeTasks(ids:string[],complete:boolean,expected?:{id:string;revision:number}) {return changeTasks(data=>{
  if(expected)requireTask(data,expected.id,expected.revision)
  const all=complete?descendants(data.tasks,ids):new Set(ids), now=Date.now()
  const rolls: { task:Task; next:string; previous:string }[]=[]
  const reopen=(task:Task)=>{if(task.completedAt===null)return;const reversed=new Set(data.taskCompletions.map(e=>e.reverts));const latest=data.taskCompletions.filter(e=>e.taskId===task.id&&!e.reverts&&!reversed.has(e.id)).at(-1);if(latest)data.taskCompletions.push({id:crypto.randomUUID(),taskId:task.id,title:task.title,at:now,occurrence:task.planDate,reverts:latest.id});task.completedAt=null;touch(task)}
  for(const id of all) {
    const task=requireTask(data,id);if(task.deletedAt!==null || (task.completedAt!==null)===complete)continue
    if(complete){const next=nextOccurrence(task,now);if(next)rolls.push({task,next,previous:task.planDate!});task.completedAt=now;data.taskCompletions.push({id:crypto.randomUUID(),taskId:id,title:task.title,at:now,occurrence:task.planDate,...(next?{next}:{})})}
    else {reopen(task);let parent=task.parentId;while(parent){const p=requireTask(data,parent);reopen(p);parent=p.parentId}}
    touch(task)
  }
  for(const {task,next,previous} of rolls){const shift=Math.round((Date.parse(next+'T12:00Z')-Date.parse(previous+'T12:00Z'))/86400000);task.planDate=next;task.completedAt=null;touch(task)
    const children=descendants(data.tasks,[task.id]);for(const child of data.tasks)if(child.deletedAt===null&&child.id!==task.id&&children.has(child.id)){child.completedAt=null;if(child.planDate)child.planDate=addDays(child.planDate,shift);touch(child)}
  }
})}
export function reopenCompletion(id:string){return changeTasks(data=>{
  const event=data.taskCompletions.find(e=>e.id===id&&!e.reverts);if(!event||data.taskCompletions.some(e=>e.reverts===id))throw new Error(t('tasks.conflict'))
  const reversed=new Set(data.taskCompletions.map(e=>e.reverts));if(data.taskCompletions.filter(e=>e.taskId===event.taskId&&!e.reverts&&!reversed.has(e.id)).at(-1)?.id!==id)throw new Error(t('tasks.latestCompletion'))
  const task=requireTask(data,event.taskId);if(task.deletedAt!==null)throw new Error(t('tasks.restoreFirst'))
  task.completedAt=null;if(event.next){const shift=Math.round((Date.parse(event.occurrence+'T12:00Z')-Date.parse(event.next+'T12:00Z'))/86400000),children=descendants(data.tasks,[task.id]);task.planDate=event.occurrence;for(const child of data.tasks)if(child.deletedAt===null&&child.id!==task.id&&children.has(child.id)){child.completedAt=null;if(child.planDate)child.planDate=addDays(child.planDate,shift);touch(child)}}touch(task)
  data.taskCompletions.push({id:crypto.randomUUID(),taskId:task.id,title:task.title,at:Date.now(),occurrence:event.occurrence,reverts:id})
  let parent=task.parentId;while(parent){const p=requireTask(data,parent);if(p.completedAt!==null){const latest=data.taskCompletions.filter(e=>e.taskId===p.id&&!e.reverts&&!data.taskCompletions.some(r=>r.reverts===e.id)).at(-1);if(latest)data.taskCompletions.push({id:crypto.randomUUID(),taskId:p.id,title:p.title,at:Date.now(),occurrence:p.planDate,reverts:latest.id});p.completedAt=null;touch(p)}parent=p.parentId}
})}
export function deleteTasks(ids:string[]) {return changeTasks(data=>{const deletionId=crypto.randomUUID();for(const id of descendants(data.tasks,ids)){const task=requireTask(data,id);if(task.deletedAt===null){task.deletedAt=Date.now();task.deletionId=deletionId;touch(task)}}})}
export function restoreTaskGroup(deletionId:string) {return changeTasks(data=>{
  for(const collection of [data.tasks,data.taskProjects,data.taskSections])for(const row of collection)if(row.deletionId===deletionId){row.deletedAt=null;delete row.deletionId}
})}
export function copyTask(id:string) {return changeTasks(data=>{
  const task=requireTask(data,id), all=descendants(data.tasks,[id]), mapping=new Map([...all].map(key=>[key,crypto.randomUUID()]))
  const copies=data.tasks.filter(t=>all.has(t.id)).sort((a,b)=>a.order-b.order).map((t,i)=>({...structuredClone(t),id:mapping.get(t.id)!,parentId:t.id===id?t.parentId:mapping.get(t.parentId!)!,title:t.id===id?t.title+' '+tCopy():t.title,completedAt:null,deletedAt:null,order:nextOrder(data.tasks)+i*1024,createdAt:Date.now(),updatedAt:Date.now(),revision:0}))
  for(const c of copies)delete c.deletionId
  data.tasks.push(...copies);return copies.find(t=>t.id===mapping.get(task.id))!
})}
function tCopy(){return t('tasks.copySuffix')}
export function batchTasks(ids:string[],patch:Partial<Pick<Task,'priority'|'planDate'|'labelIds'>>) {return changeTasks(data=>{for(const id of ids){const task=requireTask(data,id);Object.assign(task,structuredClone(patch));touch(task)}})}
export function saveProject(value:Partial<TaskProject>&{name:string},revision?:number) {return changeTasks(data=>{
  const current=value.id?data.taskProjects.find(p=>p.id===value.id):undefined
  if(value.id && (!current || current.revision!==revision))throw new Error(t('tasks.conflict'))
  const project:TaskProject=current?{...current,...value,revision:current.revision+1}:{id:crypto.randomUUID(),color:'#5274a5',icon:'',parentId:null,order:nextOrder(data.taskProjects),favorite:false,archivedAt:null,deletedAt:null,revision:0,...value}
  if(current)Object.assign(current,project);else data.taskProjects.push(project);return project
})}
export function deleteProject(id:string) {return changeTasks(data=>{
  const all=descendants(data.taskProjects,[id]), deletionId=crypto.randomUUID(), now=Date.now()
  for(const p of data.taskProjects)if(all.has(p.id)&&p.deletedAt===null){p.deletedAt=now;p.deletionId=deletionId;p.revision++}
  for(const s of data.taskSections)if(all.has(s.projectId)&&s.deletedAt===null){s.deletedAt=now;s.deletionId=deletionId}
  for(const task of data.tasks)if(task.projectId && all.has(task.projectId)&&task.deletedAt===null){task.deletedAt=now;task.deletionId=deletionId;touch(task)}
})}
export function saveSection(value:Partial<TaskSection>&{name:string;projectId:string}) {return changeTasks(data=>{const current=data.taskSections.find(s=>s.id===value.id);if(current)Object.assign(current,value);else data.taskSections.push({id:crypto.randomUUID(),order:nextOrder(data.taskSections),deletedAt:null,...value})})}
export function deleteSection(id:string) {return changeTasks(data=>{const s=data.taskSections.find(s=>s.id===id);if(!s)throw new Error(t('tasks.conflict'));s.deletedAt=Date.now();for(const task of data.tasks)if(task.sectionId===id){task.sectionId=null;touch(task)}})}
export function reorderProject(id:string,direction:number) {return changeTasks(data=>{
  const row=data.taskProjects.find(p=>p.id===id);if(!row)throw new Error(t('tasks.conflict'))
  const siblings=data.taskProjects.filter(p=>p.parentId===row.parentId&&p.deletedAt===null).sort((a,b)=>a.order-b.order),from=siblings.indexOf(row),to=from+direction
  if(to<0||to>=siblings.length)return
  ;[siblings[from],siblings[to]]=[siblings[to],siblings[from]];siblings.forEach((p,i)=>{p.order=(i+1)*1024;p.revision++})
})}
export function reorderSection(id:string,direction:number) {return changeTasks(data=>{
  const row=data.taskSections.find(s=>s.id===id);if(!row)throw new Error(t('tasks.conflict'))
  const siblings=data.taskSections.filter(s=>s.projectId===row.projectId&&s.deletedAt===null).sort((a,b)=>a.order-b.order),from=siblings.indexOf(row),to=from+direction
  if(to<0||to>=siblings.length)return
  ;[siblings[from],siblings[to]]=[siblings[to],siblings[from]];siblings.forEach((p,i)=>{p.order=(i+1)*1024})
})}
export function saveLabel(value:Partial<TaskLabel>&{name:string}) {return changeTasks(data=>{const current=data.taskLabels.find(l=>l.id===value.id);if(current)Object.assign(current,value);else data.taskLabels.push({id:crypto.randomUUID(),color:'#5274a5',favorite:false,deletedAt:null,...value})})}
export function saveTaskSetting(id:string,value:string){return changeTasks(data=>{const old=data.taskSettings.find(s=>s.id===id);if(old)old.value=value;else data.taskSettings.push({id,value})},false)}
export function saveFilter(value:TaskFilter){return changeTasks(data=>{const current=data.taskFilters.find(f=>f.id===value.id);if(current)Object.assign(current,structuredClone(value));else data.taskFilters.push(structuredClone(value))})}
export function deleteFilter(id:string){return changeTasks(data=>{data.taskFilters=data.taskFilters.filter(f=>f.id!==id)})}
