import { t } from '../i18n'
import { button, downloadFile, element } from '../ui'
import { showNotice } from '../undo'
import { storageError } from '../library'
import { choices, taskForm } from './forms'
import { dateKey } from './model'
import { readTasks } from './store'
import { importTasks, inspectTaskConflicts, packTasks, readTaskFile } from './transfer'

export function taskTransferControls() {
  const controls = element('div', 'task-toolbar'),
    out = button(t('tasks.exportData'), 'button button-quiet button-small'),
    into = button(t('tasks.importData'), 'button button-quiet button-small')
  out.onclick = () =>
    void (async () => {
      const blob = await packTasks(await readTasks())
      downloadFile(blob, 'New_World-tasks-' + dateKey() + '.json')
    })().catch((e) => showNotice(storageError(e)))
  into.onclick = () => {
    const input = element('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.hidden = true
    input.oncancel = () => input.remove()
    input.onchange = () => {
      const file = input.files?.[0]
      input.remove()
      if (!file) return
      void (async () => {
        const data = await readTaskFile(file),
          conflicts = await inspectTaskConflicts(data),
          mode = choices(t('tasks.importMode'), [
            ...(!conflicts ? [['preserve', t('tasks.preserve')] as [string, string]] : []),
            ['copy', t('tasks.importCopy')],
            ['skip', t('tasks.importSkip')],
          ])
        taskForm(
          {
            title: t('tasks.importPreview'),
            action: t('tasks.confirmImport'),
            description: t('tasks.importSummary', [
              data.tasks.length,
              data.taskProjects.length,
              data.taskAttachments.length,
              conflicts,
            ]),
            fields: [element('p', 'dialog-help', t('tasks.importTaskHint')), mode.wrapper],
          },
          async () => {
            await importTasks(data, mode.input.value as 'preserve' | 'copy' | 'skip')
            if (mode.input.value !== 'skip') {
              showNotice(t('tasks.imported'))
              location.hash = '#/tasks/all'
            }
          },
        )
      })().catch((e) => showNotice(storageError(e)))
    }
    document.body.append(input)
    input.click()
  }
  controls.append(out, into)
  return controls
}
