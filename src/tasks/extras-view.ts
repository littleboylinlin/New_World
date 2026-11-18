import { t, locale } from '../i18n'
import { button, downloadFile, element } from '../ui'
import { storageError } from '../library'
import { showNotice } from '../undo'
import { choices, field, taskForm } from './forms'
import { dateKey, addDays } from './model'
import type { Task, TaskData, TaskComment } from './model'
import { readTasks, taskChanges } from './store'
import {
  addAttachment,
  commentTask,
  createTemplate,
  deleteComment,
  deleteTemplate,
  instantiateTemplate,
  removeAttachment,
} from './extras-store'
import { attachmentTypes } from './resources'

const key = (name: string) => t('tasks.' + name)
const action = (name: string, run: () => unknown) => {
  const b = button(key(name), 'button button-quiet button-small')
  b.onclick = () =>
    void Promise.resolve()
      .then(run)
      .catch((e) => showNotice(storageError(e)))
  return b
}
export function taskExtras(data: TaskData, initial: Task) {
  const body = element('div', 'task-management')
  let task = initial
  const edit = (current?: TaskComment) => {
    const text = field(key('commentText'), 'textarea', current?.text ?? '')
    text.input.required = true
    taskForm(
      {
        title: key(current ? 'editComment' : 'newComment'),
        action: key('saveComment'),
        fields: [text.wrapper],
      },
      async () => {
        await commentTask(task.id, text.input.value, current)
      },
    )
  }
  function paint() {
    task = data.tasks.find((t) => t.id === task.id) ?? task
    body.replaceChildren(
      element('h3', '', key('comments')),
      action('newComment', () => edit()),
    )
    for (const c of task.comments ?? []) {
      const row = element('div', 'task-management-row')
      row.append(
        element('span', '', c.text + ' · ' + new Date(c.createdAt).toLocaleString(locale)),
        action(c.deletedAt === null ? 'editComment' : 'restoreComment', () =>
          c.deletedAt === null ? edit(c) : deleteComment(task.id, c.id, true),
        ),
      )
      if (c.deletedAt === null)
        row.append(action('deleteComment', () => deleteComment(task.id, c.id)))
      body.append(row)
    }
    body.append(
      element('h3', '', key('attachments')),
      element('p', 'dialog-help', key('attachmentHint')),
    )
    const file = element('input')
    file.type = 'file'
    file.accept = Object.keys(attachmentTypes)
      .map((e) => '.' + e)
      .join(',')
    file.setAttribute('aria-label', key('addAttachment'))
    file.onchange = () => {
      const picked = file.files?.[0]
      if (picked) {
        file.disabled = true
        void addAttachment(task.id, picked)
          .catch((e) => showNotice(storageError(e)))
          .finally(() => {
            file.disabled = false
            file.value = ''
          })
      }
    }
    body.append(file)
    for (const a of data.taskAttachments.filter((a) => a.taskId === task.id)) {
      const row = element('div', 'task-management-row')
      row.append(
        element('span', '', a.name + ' · ' + a.bytes + ' B'),
        action('downloadAttachment', () => downloadFile(a.content, a.name)),
        action('removeAttachment', () =>
          taskForm(
            {
              title: key('removeAttachment'),
              action: key('removeAttachment'),
              description: key('removeAttachmentHint'),
              danger: true,
            },
            async () => {
              await removeAttachment(a.id)
            },
          ),
        ),
      )
      body.append(row)
    }
  }
  paint()
  taskForm({ title: key('extras'), action: t('common.close'), fields: [body] }, async () => {})
  const controller = new AbortController()
  body.closest('dialog')!.addEventListener('close', () => controller.abort(), { once: true })
  taskChanges.addEventListener(
    'update',
    () =>
      void readTasks().then(
        (next) => {
          if (!controller.signal.aborted) {
            data = next
            paint()
          }
        },
        (e) => showNotice(storageError(e)),
      ),
    { signal: controller.signal },
  )
}
export function saveTemplateDialog(task: Task) {
  const name = field(key('templateName'), 'text', task.title)
  name.input.required = true
  taskForm(
    {
      title: key('saveTemplate'),
      action: key('saveTemplate'),
      fields: [name.wrapper],
      description: key('templateHint'),
    },
    async () => {
      await createTemplate(task.id, name.input.value.trim())
    },
  )
}
export function templatesView(data: TaskData, projectId: string | null) {
  const body = element('section', 'task-management')
  body.append(element('h2', '', key('templates')), element('p', 'dialog-help', key('templateHint')))
  for (const template of data.taskTemplates) {
    const row = element('div', 'task-management-row')
    row.append(
      element('span', '', template.name),
      action('useTemplate', async () => {
        await instantiateTemplate(template.id, projectId)
        location.hash = '#/notes/tasks/all'
      }),
      action('deleteTemplate', () =>
        taskForm(
          { title: key('deleteTemplate'), action: key('deleteTemplate'), danger: true },
          async () => {
            await deleteTemplate(template.id)
          },
        ),
      ),
    )
    body.append(row)
  }
  return body
}
export function statsView(data: TaskData) {
  const body = element('section', 'task-stats'),
    range = choices(
      key('statsRange'),
      [
        ['day', key('day')],
        ['week', key('week')],
        ['month', key('month')],
      ],
      'day',
    ),
    output = element('div')
  body.append(
    element('h2', '', key('statistics')),
    element('p', 'dialog-help', key('statisticsHint')),
    range.wrapper,
    output,
  )
  function paint() {
    const reversals = new Set(data.taskCompletions.flatMap((e) => (e.reverts ? [e.reverts] : []))),
      counts = new Map<string, number>()
    for (const event of data.taskCompletions) {
      if (event.reverts || reversals.has(event.id)) continue
      let bucket = dateKey(new Date(event.at))
      if (range.input.value === 'week')
        bucket = addDays(bucket, -((new Date(bucket + 'T12:00Z').getUTCDay() + 6) % 7))
      if (range.input.value === 'month') bucket = bucket.slice(0, 7)
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
    }
    const table = element('table', 'task-table'),
      head = element('tr')
    head.append(element('th', '', key('date')), element('th', '', key('completionCount')))
    table.append(head)
    for (const [date, count] of [...counts].sort(([a], [b]) => b.localeCompare(a))) {
      const row = element('tr')
      row.append(element('td', '', date), element('td', '', String(count)))
      table.append(row)
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0)
    output.replaceChildren(table, element('p', '', t('tasks.totalCompletions', [total])))
  }
  range.input.onchange = paint
  paint()
  return body
}
