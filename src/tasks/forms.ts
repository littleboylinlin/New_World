import { element } from '../ui'
import { formDialog } from '../dialogs'

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
