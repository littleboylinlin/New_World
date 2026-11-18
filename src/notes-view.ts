import { t } from './i18n'
import { renderIdeas } from './ideas-view'
import { preference } from './navigation-preferences'
import { renderTasks } from './tasks/view'
import { element, link } from './ui'

const section = preference('notes-section', ['ideas', 'tasks'] as const, 'ideas')
export function notesPath(hash: string) {
  if (/^#\/ideas\/?$/.test(hash)) return '#/notes/ideas'
  if (/^#\/tasks(?:\/|$)/.test(hash)) return hash.replace('#/tasks', '#/notes/tasks').replace(/\/$/, '')
  if (/^#\/notes\/?$/.test(hash)) return '#/notes/' + section.get()
  return /^#\/notes\/(ideas\/?$|tasks(?:\/|$))/.test(hash) ? hash.replace(/\/$/, '') : null
}

export function mountNotes(root: HTMLElement, signal: AbortSignal) {
  const page = element('section', 'notes-page')
  const head = element('div', 'page-heading')
  const heading = element('h1', '', t('navigation.notes'))
  const tabs = element('nav', 'segment-switch')
  tabs.setAttribute('aria-label', t('navigation.notes'))
  const ideasTab = link('#/notes/ideas', t('ideas.title'), 'segment')
  const tasksTab = link('#/notes/tasks', t('notes.tasks'), 'segment')
  tabs.append(ideasTab, tasksTab)
  head.append(heading, tabs)
  const ideasPane = element('div')
  const tasksPane = element('div')
  page.append(head, ideasPane, tasksPane)
  root.append(page)
  let taskPath: string | undefined
  let tasks: AbortController | undefined
  signal.addEventListener('abort', () => tasks?.abort(), { once: true })

  return (path: string) => {
    const ideas = path === '#/notes/ideas'
    section.set(ideas ? 'ideas' : 'tasks')
    ideasPane.hidden = !ideas
    tasksPane.hidden = ideas
    const [current, other] = ideas ? [ideasTab, tasksTab] : [tasksTab, ideasTab]
    current.setAttribute('aria-current', 'page')
    other.removeAttribute('aria-current')
    if (ideas && !ideasPane.childElementCount) renderIdeas(ideasPane, signal)
    if (!ideas && taskPath !== path) {
      tasks?.abort()
      tasks = new AbortController()
      taskPath = tasksTab.hash = path
      tasksPane.replaceChildren()
      renderTasks(tasksPane, tasks.signal, path.slice('#/notes/tasks/'.length) || 'inbox')
    }
  }
}
