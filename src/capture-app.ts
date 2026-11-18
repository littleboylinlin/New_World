import { locale, t } from './i18n'
import { captureForm } from './idea-capture'
import { storageError } from './library'
import { addDays, dateKey, localZone, wallTimes } from './tasks/model'
import type { Task } from './tasks/model'
import { addTask } from './tasks/store'
import { button, element } from './ui'

const desktop = window.newWorldDesktop!
document.documentElement.classList.add('capture-window')
document.title = t('capture.title')

const panel = element('main', 'capture-panel')
const modes = element('div', 'segment-switch')
modes.setAttribute('role', 'group')
modes.setAttribute('aria-label', document.title)
const ideaTab = button(t('ideas.title'), 'segment')
const reminderTab = button(t('capture.reminder'), 'segment')
modes.append(ideaTab, reminderTab)
const hide = () => { void desktop.hideCapture?.() }
const idea = captureForm(hide, hide, t('capture.ideaKeys'))
const reminder = element('form', 'capture-form')
const title = element('input', 'title-input capture-task-title')
title.placeholder = t('capture.reminderText')
title.setAttribute('aria-label', title.placeholder)
title.required = true
title.maxLength = 500
function optionalField(type: 'date' | 'time', key: string) {
  const label = element('label', 'field-label', t(key))
  const input = element('input', 'title-input')
  input.type = type
  label.append(input)
  return { label, input }
}
const date = optionalField('date', 'tasks.date')
const time = optionalField('time', 'tasks.time')
const schedule = element('div', 'capture-schedule')
const preview = element('p', 'dialog-help')
preview.id = 'reminder-date-preview'
preview.setAttribute('aria-live', 'polite')
time.input.setAttribute('aria-describedby', preview.id)
schedule.append(date.label, time.label, preview)
const hint = element('p', 'dialog-help', t('capture.keys'))
const status = element('p', 'field-error')
status.setAttribute('role', 'alert')
const actions = element('div', 'dialog-controls')
const cancel = button(t('common.cancel'), 'button button-quiet')
cancel.onclick = hide
const save = button(t('ideas.save'), 'button button-primary')
save.type = 'submit'
actions.append(cancel, save)
reminder.append(title, schedule, hint, status, actions)
panel.append(modes, idea.form, reminder)
document.body.replaceChildren(panel)

function plan(now: number): Partial<Task> {
  const planTime = time.input.value
  if (!planTime) return { planDate: date.input.value || null }
  const zone = localZone()
  let planDate = date.input.value || dateKey(new Date(now))
  for (;;) {
    const times = wallTimes(planDate, planTime, zone)
    const selected = date.input.value ? times[0] : times.find((stamp) => stamp > now)
    if (selected !== undefined) {
      return { planDate, planTime, zone, fold: selected === times[0] ? 'earlier' : 'later', reminderMinutes: 0 }
    }
    if (date.input.value) throw new Error(t('tasks.invalidTime'))
    planDate = addDays(planDate, 1)
  }
}
function refreshDate() {
  save.textContent = t(time.input.value ? 'capture.saveReminder' : 'ideas.save')
  try {
    const now = Date.now()
    const { planDate, planTime } = plan(now)
    if (!planTime || !planDate) { preview.textContent = ''; return }
    const today = dateKey(new Date(now))
    const day = planDate === today ? t('capture.today') : planDate === addDays(today, 1) ? t('capture.tomorrow')
      : new Date(planDate + 'T12:00:00').toLocaleDateString(locale, { dateStyle: 'long' })
    preview.textContent = t('capture.scheduled', [day, planTime])
  } catch { preview.textContent = t('tasks.invalidTime') }
}
for (const input of [date.input, time.input]) input.addEventListener('input', refreshDate)
reminder.onsubmit = async (event) => {
  event.preventDefault()
  if (save.disabled) return
  save.disabled = true
  status.textContent = ''
  try {
    const scheduled = plan(Date.now())
    await addTask(title.value, scheduled, { enableReminders: Boolean(scheduled.planTime) })
    reminder.reset()
    hide()
  } catch (error) { status.textContent = storageError(error) }
  finally { save.disabled = false }
}

function select(ideas: boolean) {
  idea.form.hidden = !ideas
  reminder.hidden = ideas
  ideaTab.setAttribute('aria-pressed', String(ideas))
  reminderTab.setAttribute('aria-pressed', String(!ideas))
  if (ideas) idea.focus()
  else { refreshDate(); title.focus() }
}
ideaTab.onclick = () => select(true)
reminderTab.onclick = () => select(false)
panel.addEventListener('keydown', (event) => {
  if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
  if (event.key === 'Tab' && !event.shiftKey) {
    event.preventDefault()
    select(idea.form.hidden)
  } else if (event.key === 'Escape' && !event.defaultPrevented) {
    event.preventDefault()
    hide()
  }
})
function shown() {
  select(true)
  void idea.refresh()
}
desktop.onCaptureShown?.(shown)
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDate() })
window.setInterval(() => { if (!reminder.hidden && !document.hidden) refreshDate() }, 1000)
shown()
