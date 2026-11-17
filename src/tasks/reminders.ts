import { t } from '../i18n'
import { button, element } from '../ui'
import { showNotice } from '../undo'
import { storageError } from '../library'
import { scheduleInstant } from './model'
import { changeTasks, readTasks, saveTaskSetting, taskChanges } from './store'

let mounted=false,running=false
const enabled='reminders:enabled'
/** No OS scheduler or service worker: delivery requires a running renderer. */
export async function checkReminders(now=Date.now()) {
  if(running||typeof Notification==='undefined'||Notification.permission!=='granted')return
  running=true
  try{
    const data=await readTasks();if(data.taskSettings.find(s=>s.id===enabled)?.value!=='true')return
    let shown=0
    for(const task of data.tasks){
      if(shown>=3)break
      if(task.deletedAt!==null||task.completedAt!==null||task.reminderMinutes===undefined)continue
      const instant=scheduleInstant(task);if(instant===null)continue
      const due=instant-task.reminderMinutes*60000;if(due>now||due<now-7*86400000)continue
      const id='reminder:'+task.id+':'+instant,token=crypto.randomUUID()
      const claimed=await changeTasks(current=>{
        if(current.taskSettings.find(s=>s.id===enabled)?.value!=='true')return false
        const actual=current.tasks.find(t=>t.id===task.id);if(!actual||actual.revision!==task.revision)return false
        const old=current.taskSettings.find(s=>s.id===id)
        if(old){const state=JSON.parse(old.value);if(state.shown||state.at>now-120000)return false}
        current.taskSettings=current.taskSettings.filter(s=>!s.id.startsWith('reminder:')||Number(JSON.parse(s.value).at)>now-30*86400000)
        const entry={id,value:JSON.stringify({at:now,token,shown:false})};const existing=current.taskSettings.find(s=>s.id===id);if(existing)existing.value=entry.value;else current.taskSettings.push(entry);return true
      },false)
      if(!claimed)continue
      try{
        const notification=new Notification(t('tasks.reminderTitle'),{body:task.title,tag:id})
        notification.onclick=()=>{window.focus();location.hash='#/tasks/today';notification.close()}
        await changeTasks(current=>{const entry=current.taskSettings.find(s=>s.id===id);if(entry&&JSON.parse(entry.value).token===token)entry.value=JSON.stringify({at:now,token,shown:true})},false)
        shown++
      }catch(error){await changeTasks(current=>{current.taskSettings=current.taskSettings.filter(s=>s.id!==id||JSON.parse(s.value).token!==token)},false);throw error}
    }
  }finally{running=false}
}
export function mountTaskReminders(){if(mounted)return;mounted=true
  const check=()=>void checkReminders().catch(e=>showNotice(storageError(e)))
  setInterval(check,30000);window.addEventListener('focus',check);document.addEventListener('visibilitychange',check);taskChanges.addEventListener('update',check);check()
}
export function reminderControls(){
  const details=element('details','task-reminder-controls');details.append(element('summary','',t('tasks.reminderSettings')),element('p','dialog-help',t('tasks.reminderLimits')),element('p','dialog-help',t('tasks.shortcuts')))
  const status=element('p','dialog-help',t('tasks.permission.'+(typeof Notification==='undefined'?'unsupported':Notification.permission)))
  const enable=button(t('tasks.enableReminders'),'button button-quiet button-small'),disable=button(t('tasks.disableReminders'),'button button-quiet button-small')
  enable.onclick=()=>{void(async()=>{if(typeof Notification==='undefined')return;const permission=await Notification.requestPermission();status.textContent=t('tasks.permission.'+permission);if(permission==='granted')await saveTaskSetting(enabled,'true')})().catch(e=>showNotice(storageError(e)))}
  disable.onclick=()=>void saveTaskSetting(enabled,'false').catch(e=>showNotice(storageError(e)))
  details.append(status,enable,disable);return details
}
