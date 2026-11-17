import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyTasks, validateTasks, validDate, descendants } from '../../src/tasks/model.ts'
const id = () => crypto.randomUUID()
function row() {
  return {
    id: id(),
    title: '离线任务',
    description: '',
    notes: '',
    projectId: null,
    sectionId: null,
    parentId: null,
    priority: 4,
    labelIds: [],
    order: 1,
    expanded: true,
    planDate: null,
    completedAt: null,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 1,
    revision: 0,
  }
}
test('task dates are strict calendar dates; trees reject cycles, dangling references and unknown fields', () => {
  assert.equal(validDate('2028-02-29'), true)
  assert.equal(validDate('2027-02-29'), false)
  assert.equal(validDate('2027-04-31'), false)
  const data = emptyTasks(),
    parent = row(),
    child = { ...row(), parentId: parent.id }
  data.tasks.push(parent, child)
  validateTasks(data)
  assert.deepEqual([...descendants(data.tasks, [parent.id])], [parent.id, child.id])
  for (const mutate of [
    (d) => (d.tasks[0].parentId = child.id),
    (d) => (d.tasks[0].parentId = ''),
    (d) => (d.tasks[0].projectId = id()),
    (d) => (d.tasks[0].labelIds = [id()]),
    (d) => (d.tasks[0].unknown = 'bad'),
    (d) => d.tasks.push({ ...parent }),
    (d) => (d.tasks[0].title = ''),
  ]) {
    const invalid = structuredClone(data)
    mutate(invalid)
    assert.throws(() => validateTasks(invalid))
  }
})

test('desktop task notification permission is restricted to the trusted main document', async () => {
  const { default: guards } = await import('../../desktop/ipc-guard.cjs'),
    appUrl = 'new-world://app/',
    contents = { getURL: () => appUrl + '#/tasks' },
    mainWindow = { webContents: contents, isDestroyed: () => false },
    details = { isMainFrame: true, requestingUrl: appUrl + '#/tasks' },
    check = (c, p, d) => guards.isTrustedTaskNotification(c, p, d, { appUrl, mainWindow })
  assert.equal(check(contents, 'notifications', details), true)
  for (const [c, p, d] of [
    [contents, 'geolocation', details],
    [{}, 'notifications', details],
    [null, 'notifications', details],
    [contents, 'notifications', { ...details, isMainFrame: false }],
    [contents, 'notifications', { ...details, requestingUrl: 'https://example.com/' }],
    [contents, 'notifications', { isMainFrame: true }],
  ])
    assert.equal(check(c, p, d), false)
})

test('optional task fields reject null and false history references rather than silently dropping them', () => {
  const data = emptyTasks(),
    task = row()
  data.tasks.push(task)
  for (const patch of [
    { repeat: null },
    { link: { library: 'original', bookId: id(), title: '作品', position: null } },
  ]) {
    const invalid = structuredClone(data)
    Object.assign(invalid.tasks[0], patch)
    assert.throws(() => validateTasks(invalid))
  }
  for (const reverts of ['', null, false]) {
    const invalid = structuredClone(data)
    invalid.taskCompletions.push({
      id: id(),
      taskId: task.id,
      title: task.title,
      at: 1,
      occurrence: null,
      reverts,
    })
    assert.throws(() => validateTasks(invalid))
  }
})
