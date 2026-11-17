import { t } from '../i18n'
import { button, element, link, notice } from '../ui'
import { formDialog } from '../dialogs'
import { showNotice } from '../undo'
import { storageError } from '../library'
import { dateKey, descendants, emptyTasks, taskMatches } from './model'
import type { Task, TaskData, TaskProject, TaskLabel } from './model'
import { addTask, batchTasks, completeTasks, copyTask, deleteProject, deleteSection, deleteTasks, editTask, moveTasks, readTasks, reorderProject, reorderSection, restoreTaskGroup, saveLabel, saveProject, saveSection, taskChanges, undoTaskChange } from './store'
import './tasks.css'

export function taskForm(options: Parameters<typeof formDialog>[1], submit: Parameters<typeof formDialog>[2]) {
  formDialog(document.body, options, submit)
  document.body.lastElementChild?.classList.add('task-dialog')
}
export function field(label:string,type='text',value='') {
  const wrapper=element('label','field-label',label)
  const input=type==='textarea'?element('textarea','title-input'):element('input','title-input')
  if(input instanceof HTMLInputElement)input.type=type
  else input.rows=4
  input.value=value;input.setAttribute('aria-label',label);wrapper.append(input)
  return {wrapper,input}
}
export function choices(label:string,options:[string,string][],value='') {
  const wrapper=element('label','field-label',label),input=element('select','title-input')
  input.setAttribute('aria-label',label)
  for(const [key,name] of options){const option=element('option','',name);option.value=key;input.append(option)}
  input.value=value;wrapper.append(input);return {wrapper,input}
}
const labelKey=(key:string)=>t('tasks.'+key)
const b=(key:string,action:()=>unknown,cls='button button-quiet button-small')=>{
  const node=button(labelKey(key),cls)
  node.addEventListener('click',()=>{void Promise.resolve().then(action).catch(e=>showNotice(storageError(e)))})
  return node
}
export function taskDialog(data:TaskData,task?:Task,patch:Partial<Task>={}) {
  const initial=task??{title:'',description:'',notes:'',priority:4,labelIds:[],projectId:null,sectionId:null,parentId:null,planDate:null,...patch}
  const title=field(labelKey('title'),'text',initial.title), description=field(labelKey('description'),'textarea',initial.description), notes=field(labelKey('notes'),'textarea',initial.notes)
  title.input.required=true;title.input.maxLength=500;description.input.maxLength=notes.input.maxLength=20000
  const priority=choices(labelKey('priority'),[1,2,3,4].map(p=>[String(p),'P'+p]),String(initial.priority))
  const project=choices(labelKey('project'),[['',labelKey('inbox')],...data.taskProjects.filter(p=>p.deletedAt===null).map(p=>[p.id,p.icon+' '+p.name] as [string,string])],initial.projectId??'')
  const section=choices(labelKey('section'),[]), parent=choices(labelKey('parent'),[])
  const date=field(labelKey('date'),'date',initial.planDate??'')
  const updateLocation=()=>{
    const sections=[['',labelKey('unsectioned')],...data.taskSections.filter(s=>s.projectId===project.input.value&&s.deletedAt===null).map(s=>[s.id,s.name])] as [string,string][]
    section.input.replaceChildren(...sections.map(([id,name])=>{const o=element('option','',name);o.value=id;return o}));section.input.value=initial.projectId===(project.input.value||null)?initial.sectionId??'':''
    const excluded=task?descendants(data.tasks,[task.id]):new Set<string>()
    const parents=[['',labelKey('none')],...data.tasks.filter(p=>p.deletedAt===null&&!p.completedAt&&p.projectId===(project.input.value||null)&&!excluded.has(p.id)).map(p=>[p.id,p.title])] as [string,string][]
    parent.input.replaceChildren(...parents.map(([id,name])=>{const o=element('option','',name);o.value=id;return o}));parent.input.value=initial.parentId??''
  }
  project.input.addEventListener('change',updateLocation);updateLocation()
  const labels=element('fieldset','task-label-picks');labels.append(element('legend','',labelKey('label')))
  const picked=new Map<string,HTMLInputElement>()
  for(const label of data.taskLabels.filter(l=>l.deletedAt===null)){
    const wrapper=element('label'),box=element('input');box.type='checkbox';box.checked=initial.labelIds.includes(label.id);wrapper.append(box,document.createTextNode(label.name));labels.append(wrapper);picked.set(label.id,box)
  }
  const location=[project.wrapper,section.wrapper,parent.wrapper]
  taskForm({title:labelKey(task?'edit':'add'),action:labelKey('save'),fields:[title.wrapper,description.wrapper,notes.wrapper,...location,priority.wrapper,date.wrapper,labels]},async()=>{
    const value={title:title.input.value.trim(),description:description.input.value,notes:notes.input.value,priority:Number(priority.input.value),planDate:date.input.value||null,projectId:project.input.value||null,sectionId:section.input.value||null,parentId:parent.input.value||null,labelIds:[...new Set([...initial.labelIds.filter(id=>!picked.has(id)),...[...picked].filter(([,box])=>box.checked).map(([id])=>id)])]}
    if(task)await editTask(task.id,task.revision,value);else await addTask(value.title,value)
  })
}
function projectDialog(data:TaskData,current?:TaskProject) {
  const name=field(labelKey('projectName'),'text',current?.name??''),color=field(labelKey('color'),'color',current?.color??'#5274a5'),icon=field(labelKey('icon'),'text',current?.icon??'')
  name.input.required=true;name.input.maxLength=500;icon.input.maxLength=16
  const excluded=current?descendants(data.taskProjects,[current.id]):new Set<string>()
  const parent=choices(labelKey('parentProject'),[['',labelKey('none')],...data.taskProjects.filter(p=>p.deletedAt===null&&!excluded.has(p.id)).map(p=>[p.id,p.name] as [string,string])],current?.parentId??'')
  taskForm({title:labelKey(current?'editProject':'newProject'),action:labelKey('saveProject'),fields:[name.wrapper,parent.wrapper,color.wrapper,icon.wrapper]},async()=>{await saveProject({...(current??{}),name:name.input.value.trim(),color:color.input.value,icon:icon.input.value,parentId:parent.input.value||null},current?.revision)})
}
function labelsDialog(data:TaskData) {
  const body=element('div','task-management')
  const edit=(label?:TaskLabel)=>{
    const name=field(labelKey('labelName'),'text',label?.name??''),color=field(labelKey('labelColor'),'color',label?.color??'#5274a5')
    name.input.required=true;name.input.maxLength=500
    taskForm({title:labelKey(label?'labels':'newLabel'),action:labelKey('saveLabel'),fields:[name.wrapper,color.wrapper]},async()=>{await saveLabel({...label,name:name.input.value.trim(),color:color.input.value})})
  }
  const paint=()=>{body.replaceChildren(b('newLabel',()=>edit()));for(const label of data.taskLabels){const row=element('div','task-management-row');row.append(element('span','',label.name),b('edit',()=>edit(label)),b(label.deletedAt?'restore':'delete',()=>saveLabel({...label,deletedAt:label.deletedAt?null:Date.now()})),b('favorite',()=>saveLabel({...label,favorite:!label.favorite})));body.append(row)}}
  paint()
  taskForm({title:labelKey('labels'),action:t('common.close'),fields:[body]},async()=>{})
  const dialog=body.closest('dialog')!,controller=new AbortController();dialog.addEventListener('close',()=>controller.abort(),{once:true})
  taskChanges.addEventListener('update',()=>{void readTasks().then(next=>{if(!controller.signal.aborted){data=next;paint()}},e=>showNotice(storageError(e)))},{signal:controller.signal})
}
function sectionDialog(data:TaskData,projectId:string) {
  const body=element('div','task-management')
  const edit=(id?:string)=>{const current=data.taskSections.find(s=>s.id===id);const name=field(labelKey('sectionName'),'text',current?.name??'');name.input.required=true
    taskForm({title:labelKey(current?'editSection':'newSection'),action:labelKey('saveSection'),fields:[name.wrapper]},async()=>{await saveSection({...current,name:name.input.value.trim(),projectId})})}
  const paint=()=>{body.replaceChildren(b('newSection',()=>edit()));for(const section of data.taskSections.filter(s=>s.projectId===projectId&&s.deletedAt===null).sort((a,b)=>a.order-b.order)) {const row=element('div','task-management-row');row.append(element('span','',section.name),b('editSection',()=>edit(section.id)),b('delete',()=>deleteSection(section.id)),b('up',()=>reorderSection(section.id,-1)),b('down',()=>reorderSection(section.id,1)));body.append(row)}}
  paint()
  taskForm({title:labelKey('manageSections'),action:t('common.close'),fields:[body]},async()=>{})
  const dialog=body.closest('dialog')!,controller=new AbortController();dialog.addEventListener('close',()=>controller.abort(),{once:true})
  taskChanges.addEventListener('update',()=>{void readTasks().then(next=>{if(!controller.signal.aborted){data=next;paint()}},e=>showNotice(storageError(e)))},{signal:controller.signal})
}

export function renderTasks(root:HTMLElement,signal:AbortSignal) {
  const page=element('section','task-workspace'),heading=element('header','page-heading'),nav=element('nav','task-nav'),content=element('div','task-content')
  heading.append(element('div','',labelKey('intro')),link('#/',t('navigation.home'),'button button-quiet'))
  const title=element('h1','',labelKey('workspace'));heading.prepend(title)
  const layout=element('div','task-layout');layout.append(nav,content);page.append(heading,layout);root.append(page)
  let data=emptyTasks(),request=0; const selected=new Set<string>()
  const route=()=>decodeURIComponent(location.hash.replace(/^#\/tasks\/?/,'')||'inbox')
  const query=field(labelKey('search'),'search');query.input.placeholder=labelKey('searchHint')
  query.input.addEventListener('input',()=>paintContent())
    const quick=element('form','task-quick'),input=element('input','title-input');input.required=true;input.maxLength=500;input.setAttribute('aria-label',labelKey('quick'));input.placeholder=labelKey('quick');const add=button(labelKey('add'),'button button-primary');add.type='submit';quick.append(input,add)
    quick.addEventListener('submit',event=>{event.preventDefault();add.disabled=true;void addTask(input.value,{projectId:route().startsWith('project/')?route().slice(8):null}).then(()=>{input.value='';input.focus()},e=>showNotice(storageError(e))).finally(()=>{add.disabled=false})})

  function paintNav() {
    nav.replaceChildren();nav.setAttribute('aria-label',labelKey('workspace'))
    for(const key of ['inbox','today','upcoming','all','completed','trash']){const item=link('#/tasks/'+key,labelKey(key),'task-nav-item');if(route()===key)item.setAttribute('aria-current','page');nav.append(item)}
    nav.append(b('newProject',()=>projectDialog(data)),b('labels',()=>labelsDialog(data)))
    const projects=data.taskProjects.filter(p=>p.deletedAt===null).sort((a,b)=>a.order-b.order)
    const appendProject=(p:TaskProject,depth:number)=>{const item=link('#/tasks/project/'+p.id,(p.favorite?'★ ':'')+p.icon+' '+p.name,'task-nav-item');item.style.borderInlineStartColor=p.color;item.style.paddingInlineStart=(10+Math.min(depth,8)*10)+'px';if(route()==='project/'+p.id)item.setAttribute('aria-current','page');nav.append(item);projects.filter(c=>c.parentId===p.id&&Boolean(c.archivedAt)===Boolean(p.archivedAt)).forEach(c=>appendProject(c,depth+1))}
    nav.append(element('h2','',labelKey('project')))
    projects.filter(p=>!p.archivedAt&&(!p.parentId||!projects.some(v=>v.id===p.parentId&&!v.archivedAt))).forEach(p=>appendProject(p,0))
    if(projects.some(p=>p.archivedAt)){nav.append(element('h2','',labelKey('archived')));projects.filter(p=>p.archivedAt&&(!p.parentId||!projects.some(v=>v.id===p.parentId&&v.archivedAt))).forEach(p=>appendProject(p,0))}
    for(const label of data.taskLabels.filter(l=>l.deletedAt===null&&l.favorite))nav.append(link('#/tasks/label/'+label.id,'# '+label.name,'task-nav-item'))
  }
  function visibleTasks() {
    const current=route(),today=dateKey(),projectId=current.startsWith('project/')?current.slice(8):null
    const archived=new Set(data.taskProjects.filter(p=>p.archivedAt).flatMap(p=>[...descendants(data.taskProjects,[p.id])]))
    return data.tasks.filter(task=>{
      if(!taskMatches(task,query.input.value))return false
      if(current==='trash')return task.deletedAt!==null
      if(task.deletedAt!==null)return false
      if(current==='completed')return task.completedAt!==null
      if(task.completedAt!==null)return false
      if(projectId)return task.projectId===projectId
      if(task.projectId&&archived.has(task.projectId))return false
      if(current==='today')return task.planDate!==null&&task.planDate<=today
      if(current==='upcoming')return task.planDate!==null&&task.planDate>today
      if(current==='inbox')return task.projectId===null
      if(current.startsWith('label/'))return task.labelIds.includes(current.slice(6))
      return true
    }).sort((a,b)=>['today','upcoming','completed'].includes(current)?(a.planDate??'').localeCompare(b.planDate??'')||a.priority-b.priority||a.order-b.order:a.order-b.order)
  }
  function confirmDelete(ids:string[]) {taskForm({title:labelKey('delete'),action:labelKey('delete'),description:labelKey('deleteHint'),danger:true},async()=>{await deleteTasks(ids);selected.clear()})}
  function moveDialog(ids:string[]) {
    const project=choices(labelKey('project'),[['',labelKey('inbox')],...data.taskProjects.filter(p=>p.deletedAt===null&&!p.archivedAt).map(p=>[p.id,p.name] as [string,string])])
    taskForm({title:labelKey('move'),action:labelKey('move'),fields:[project.wrapper]},async()=>{await moveTasks(ids,project.input.value||null,null);selected.clear()})
  }
  function bulkControls() {
    const controls=element('div','task-bulk');controls.append(element('span','',t('tasks.selected',[selected.size])),b('clear',()=>{selected.clear();paintContent()}),b('move',()=>moveDialog([...selected])),b('complete',()=>completeTasks([...selected],true)),b('delete',()=>confirmDelete([...selected])))
    const priority=choices(labelKey('priority'),[['',labelKey('priority')],...[1,2,3,4].map(p=>[String(p),'P'+p] as [string,string])]);priority.input.addEventListener('change',()=>{if(priority.input.value)void batchTasks([...selected],{priority:Number(priority.input.value)}).catch(e=>showNotice(storageError(e)))})
    const date=field(labelKey('date'),'date');date.input.addEventListener('change',()=>void batchTasks([...selected],{planDate:date.input.value||null}).catch(e=>showNotice(storageError(e))))
    controls.append(priority.wrapper,date.wrapper);return controls
  }
  function taskRow(task:Task,depth:number,visible:Set<string>):HTMLElement {
    const row=element('li','task-row');row.dataset.taskId=task.id;row.style.setProperty('--task-depth',String(Math.min(depth,8)))
    const handle=element('span','task-drag-handle','⠿');handle.draggable=true;handle.title=labelKey('move');handle.setAttribute('aria-label',labelKey('move'));row.append(handle)
    row.addEventListener('dragstart',event=>{event.stopPropagation();event.dataTransfer?.setData('application/x-newworld-task',task.id);if(event.dataTransfer)event.dataTransfer.effectAllowed='move'})
    row.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('application/x-newworld-task'))event.preventDefault()})
    row.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();const id=event.dataTransfer?.getData('application/x-newworld-task');if(id&&id!==task.id)void moveTasks([id],task.projectId,task.sectionId,task.parentId,task.id).catch(e=>showNotice(storageError(e)))})
    const select=element('input');select.type='checkbox';select.checked=selected.has(task.id);select.setAttribute('aria-label',labelKey('select')+' '+task.title);select.addEventListener('change',()=>{if(select.checked)selected.add(task.id);else selected.delete(task.id);paintContent()})
    const text=button(task.title,'task-title');text.addEventListener('click',()=>taskDialog(data,task));text.style.color=['','#b63030','#aa6817','#386ba1','var(--ink)'][task.priority]
    const copy=element('div','task-copy');copy.append(text)
    const meta=element('div','file-details');meta.append(element('span','','P'+task.priority));if(task.planDate)meta.append(element('span',task.planDate<dateKey()&&!task.completedAt?'task-overdue':'',task.planDate))
    for(const id of task.labelIds){const label=data.taskLabels.find(l=>l.id===id&&l.deletedAt===null);if(label)meta.append(link('#/tasks/label/'+id,'#'+label.name))}
    copy.append(meta)
    const actions=element('div','task-actions')
    if(task.deletedAt!==null)actions.append(b('restore',()=>restoreTaskGroup(task.deletionId!)))
    else {
      actions.append(b(task.completedAt?'reopen':'complete',()=>completeTasks([task.id],!task.completedAt,{id:task.id,revision:task.revision})))
      actions.append(b('subtask',()=>taskDialog(data,undefined,{parentId:task.id,projectId:task.projectId,sectionId:task.sectionId})),b('copy',()=>copyTask(task.id)),b('move',()=>moveDialog([task.id])),b('delete',()=>confirmDelete([task.id])))
      const siblings=data.tasks.filter(t=>t.parentId===task.parentId&&t.projectId===task.projectId&&t.sectionId===task.sectionId&&t.deletedAt===null).sort((a,b)=>a.order-b.order),index=siblings.findIndex(t=>t.id===task.id)
      const up=b('up',()=>moveTasks([task.id],task.projectId,task.sectionId,task.parentId,siblings[index-1]?.id));up.disabled=index===0
      const down=b('down',()=>moveTasks([task.id],task.projectId,task.sectionId,task.parentId,siblings[index+2]?.id));down.disabled=index===siblings.length-1;actions.append(up,down)
    }
    const children=data.tasks.filter(c=>c.parentId===task.id&&visible.has(c.id)).sort((a,b)=>a.order-b.order)
    if(children.length){const toggle=b(task.expanded?'collapse':'expand',()=>editTask(task.id,task.revision,{expanded:!task.expanded}));row.append(toggle)}
    row.append(select,copy,actions)
    if(children.length&&task.expanded){const list=element('ul','task-list');for(const child of children)list.append(taskRow(child,depth+1,visible));row.append(list)}
    return row
  }
  function paintContent() {
    const current=route(),project=current.startsWith('project/')?data.taskProjects.find(p=>p.id===current.slice(8)):undefined
    const top=element('div','task-toolbar');top.append(query.wrapper,b('add',()=>taskDialog(data,undefined,{projectId:project?.id??null})),b('undo',()=>undoTaskChange()))
    if(project){top.prepend(element('h2','',project.icon+' '+project.name));top.append(b('manageProject',()=>projectDialog(data,project)),b('up',()=>reorderProject(project.id,-1)),b('down',()=>reorderProject(project.id,1)),b('favorite',()=>saveProject({...project,favorite:!project.favorite},project.revision)),b(project.archivedAt?'unarchiveProject':'archiveProject',()=>saveProject({...project,archivedAt:project.archivedAt?null:Date.now()},project.revision)),b('manageSections',()=>sectionDialog(data,project.id)),b('deleteProject',()=>taskForm({title:labelKey('deleteProject'),action:labelKey('deleteProject'),description:labelKey('deleteProjectHint'),danger:true},async()=>{await deleteProject(project.id);location.hash='#/tasks/trash'})))}
    const list=element('ul','task-list');list.setAttribute('aria-label',labelKey('workspace'))
    const tasks=visibleTasks(),visible=new Set(tasks.map(t=>t.id))
    for(const task of tasks.filter(t=>!t.parentId||!visible.has(t.parentId)))list.append(taskRow(task,0,visible))
    content.replaceChildren(top,...(current!=='trash'&&current!=='completed'?[quick]:[]),...(selected.size?[bulkControls()]:[]),tasks.length?list:notice(labelKey('empty')))
    if(current==='trash')for(const project of data.taskProjects.filter(p=>p.deletedAt!==null)){const row=element('div','task-management-row');row.append(element('span','',project.name),b('restoreProject',()=>restoreTaskGroup(project.deletionId!)));content.append(row)}
    if(current==='completed'){const details=element('details');details.append(element('summary','',labelKey('history')));for(const event of data.taskCompletions.slice().sort((a,b)=>b.at-a.at))if(taskMatches({...data.tasks.find(t=>t.id===event.taskId)!,title:event.title},query.input.value))details.append(element('p','',new Date(event.at).toLocaleString()+' · '+event.title+' · '+labelKey(event.reverts?'reopen':'complete')));content.append(details)}
  }
  async function refresh(){const turn=++request;try{const next=await readTasks();if(signal.aborted||turn!==request)return;data=next;for(const id of selected)if(!data.tasks.some(t=>t.id===id))selected.delete(id);paintNav();paintContent()}catch(e){if(!signal.aborted)content.replaceChildren(notice(storageError(e),true))}}
  taskChanges.addEventListener('update',()=>void refresh(),{signal});window.addEventListener('focus',()=>void refresh(),{signal})
  void refresh()
}
