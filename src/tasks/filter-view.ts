import { t } from '../i18n'
import { element, button } from '../ui'
import { field, choices, taskForm } from './forms'
import { saveFilter } from './store'
import type { TaskCondition, TaskFilter, TaskFilterGroup, TaskData } from './model'

const key=(name:string)=>t('tasks.'+name)
export function filterDialog(data:TaskData,current?:TaskFilter) {
  const name=field(key('filterName'),'text',current?.name??'');name.input.required=true
  const favorite=element('input');favorite.type='checkbox';favorite.checked=current?.favorite??false
  const favoriteLabel=element('label','field-label',key('favorite'));favoriteLabel.append(favorite)
  function group(initial:TaskFilterGroup,depth:number):{node:HTMLElement;read:()=>TaskFilterGroup}{
    const node=element('fieldset','task-filter-group'),operator=choices(key('combine'),[['all',key('matchAll')],['any',key('matchAny')]],initial.operator),rules=element('div');node.append(operator.wrapper,rules)
    const readers:{node:HTMLElement;read:()=>TaskCondition|TaskFilterGroup}[]=[]
    const remove=(entry:typeof readers[number])=>{readers.splice(readers.indexOf(entry),1);entry.node.remove()}
    function condition(value:TaskCondition={field:'text',op:'is',value:''}){
      const line=element('div','task-filter-rule'),type=choices(key('filterField'),['text','project','label','priority','state','date','deadline'].map(f=>[f,key('filter.'+f)]),value.op),op=choices(key('filterOp'),['is','not','before','after'].map(o=>[o,key('filter.'+o)]),value.op)
      type.input.value=value.field;let input:HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement
      const holder=element('div')
      const update=(keep='')=>{let control
        if(type.input.value==='project')control=choices(key('filterValue'),[['',key('inbox')],...data.taskProjects.filter(p=>p.deletedAt===null).map(p=>[p.id,p.name] as [string,string])],keep)
        else if(type.input.value==='label')control=choices(key('filterValue'),data.taskLabels.filter(l=>l.deletedAt===null).map(l=>[l.id,l.name] as [string,string]),keep)
        else if(type.input.value==='priority')control=choices(key('filterValue'),[1,2,3,4].map(p=>[String(p),'P'+p]),keep||'4')
        else if(type.input.value==='state')control=choices(key('filterValue'),['active','completed','deleted'].map(s=>[s,key('filter.'+s)]),keep||'active')
        else control=field(key('filterValue'),['date','deadline'].includes(type.input.value)?'date':'text',keep)
        input=control.input;holder.replaceChildren(control.wrapper);for(const option of [...op.input.options])option.disabled=!['date','deadline'].includes(type.input.value)&&['before','after'].includes(option.value);if(op.input.selectedOptions[0]?.disabled)op.input.value='is'
      };type.input.onchange=()=>update();update(value.value)
      const entry={node:line,read:():TaskCondition=>({field:type.input.value as TaskCondition['field'],op:op.input.value as TaskCondition['op'],value:input.value})},erase=button(key('removeRule'),'button button-quiet button-small');erase.onclick=()=>remove(entry);line.append(type.wrapper,op.wrapper,holder,erase);readers.push(entry);rules.append(line)
    }
    function nested(value:TaskFilterGroup){const entry=group(value,depth+1),erase=button(key('removeGroup'),'button button-quiet button-small');erase.onclick=()=>remove(entry);entry.node.append(erase);readers.push(entry);rules.append(entry.node)}
    for(const value of initial.conditions)if('operator'in value)nested(value);else condition(value)
    const add=button(key('addRule'),'button button-quiet button-small');add.onclick=()=>condition();node.append(add)
    if(depth<8){const addGroup=button(key('addGroup'),'button button-quiet button-small');addGroup.onclick=()=>nested({operator:'all',conditions:[]});node.append(addGroup)}
    return {node,read:()=>({operator:operator.input.value as 'all'|'any',conditions:readers.map(entry=>entry.read())})}
  }
  const root=group(current?.group??{operator:'all',conditions:[{field:'state',op:'is',value:'active'}]},0)
  taskForm({title:key(current?'editFilter':'newFilter'),action:key('saveFilter'),fields:[name.wrapper,favoriteLabel,root.node]},async()=>{const value={id:current?.id??crypto.randomUUID(),name:name.input.value.trim(),favorite:favorite.checked,group:root.read()};await saveFilter(value);location.hash='#/tasks/filter/'+value.id})
}
