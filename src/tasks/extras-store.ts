import { descendants, taskAssert } from './model'
import type { Task, TaskComment } from './model'
import { changeTasks, defaultTask } from './store'
import { attachmentFrom } from './resources'

export async function addAttachment(taskId: string, file: File) {
  const attachment = await attachmentFrom(file, taskId)
  return changeTasks((data) => {
    taskAssert(
      data.tasks.some((t) => t.id === taskId && t.deletedAt === null),
      'attachment task',
    )
    data.taskAttachments.push(attachment)
  })
}
export function removeAttachment(id: string) {
  return changeTasks((data) => {
    data.taskAttachments = data.taskAttachments.filter((a) => a.id !== id)
  })
}
export function commentTask(taskId: string, value: string, current?: TaskComment) {
  return changeTasks((data) => {
    const task = data.tasks.find((t) => t.id === taskId)
    taskAssert(task && task.deletedAt === null, 'comment task')
    task.comments ??= []
    if (current) {
      const old = task.comments.find((c) => c.id === current.id)
      taskAssert(
        old &&
          old.updatedAt === current.updatedAt &&
          old.text === current.text &&
          old.deletedAt === current.deletedAt,
        'comment changed',
      )
      old.text = value
      old.updatedAt = Date.now()
    } else
      task.comments.push({
        id: crypto.randomUUID(),
        text: value,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
      })
    task.revision++
    task.updatedAt = Date.now()
  })
}
export function deleteComment(taskId: string, id: string, restore = false) {
  return changeTasks((data) => {
    const task = data.tasks.find((t) => t.id === taskId),
      comment = task?.comments?.find((c) => c.id === id)
    taskAssert(task && comment, 'comment')
    comment.deletedAt = restore ? null : Date.now()
    comment.updatedAt = Date.now()
    task.revision++
    task.updatedAt = Date.now()
  })
}
export function createTemplate(taskId: string, name: string) {
  return changeTasks((data) => {
    const ids = descendants(data.tasks, [taskId]),
      tasks = structuredClone(data.tasks.filter((t) => ids.has(t.id) && t.deletedAt === null))
    taskAssert(tasks.length, 'template root')
    for (const task of tasks) {
      task.projectId = null
      task.sectionId = null
      if (!ids.has(task.parentId!)) task.parentId = null
      task.completedAt = null
      delete task.deletionId
    }
    data.taskTemplates.push({
      id: crypto.randomUUID(),
      name,
      tasks,
      attachments: structuredClone(
        data.taskAttachments.filter((a) => tasks.some((t) => t.id === a.taskId)),
      ),
    })
  })
}
export function deleteTemplate(id: string) {
  return changeTasks((data) => {
    data.taskTemplates = data.taskTemplates.filter((t) => t.id !== id)
  })
}
export function instantiateTemplate(id: string, projectId: string | null = null) {
  return changeTasks((data) => {
    const template = data.taskTemplates.find((t) => t.id === id)
    taskAssert(template, 'template')
    const map = new Map(template.tasks.map((t) => [t.id, crypto.randomUUID()])),
      order = Math.max(0, ...data.tasks.map((t) => t.order)) + 1024
    const copies = template.tasks.map((task, i) => {
      const copy: Task = defaultTask(task.title, {
        ...structuredClone(task),
        id: map.get(task.id)!,
        projectId,
        sectionId: null,
        parentId: task.parentId ? map.get(task.parentId)! : null,
        order: order + i * 1024,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        revision: 0,
        completedAt: null,
        deletedAt: null,
      })
      for (const c of copy.comments ?? []) c.id = crypto.randomUUID()
      return copy
    })
    data.tasks.push(...copies)
    data.taskAttachments.push(
      ...template.attachments.map((a) => ({
        ...a,
        id: crypto.randomUUID(),
        taskId: map.get(a.taskId)!,
      })),
    )
    return copies
  })
}
