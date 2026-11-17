import { runningVersion } from '../updates'
import {
  closed,
  detachedTaskIds,
  taskAssert,
  taskIdentities,
  taskStores,
  remapTasks,
  validateTasks,
} from './model'
import type { TaskData } from './model'
import { taskHash, validateTaskAssets } from './resources'
import { changeTasks, readTasks } from './store'

export async function encodeTaskResources(
  data: TaskData,
  put: (id: string, blob: Blob) => Promise<string>,
): Promise<TaskData> {
  const visit = async (value: any): Promise<any> => {
    if (value instanceof Blob) {
      const id = await taskHash(new Blob([await taskHash(value), '\n', value.type]))
      return { $taskResource: await put(id, value) }
    }
    if (Array.isArray(value)) return Promise.all(value.map(visit))
    if (value && typeof value === 'object')
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .map(async ([k, v]) => [k, await visit(v)]),
        ),
      )
    return value
  }
  return visit(data)
}
export async function decodeTaskResources(
  data: unknown,
  get: (id: string) => Promise<Blob>,
): Promise<TaskData> {
  let nodes = 0
  const visit = async (value: any, depth = 0): Promise<any> => {
    taskAssert(depth <= 64 && ++nodes <= 1000000, 'task JSON complexity')
    if (Array.isArray(value)) return Promise.all(value.map((v) => visit(v, depth + 1)))
    if (value && typeof value === 'object') {
      if (Object.hasOwn(value, '$taskResource')) {
        closed(value, '$taskResource')
        taskAssert(typeof value.$taskResource === 'string', 'task resource')
        return get(value.$taskResource)
      }
      taskAssert(
        !Object.keys(value).some((k) => ['__proto__', 'prototype', 'constructor'].includes(k)),
        'unsafe task JSON key',
      )
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([k, v]) => [k, await visit(v, depth + 1)]),
        ),
      )
    }
    return value
  }
  return visit(data)
}
export async function packTasks(source: TaskData) {
  const data = structuredClone(source)
  data.taskSettings = []
  validateTasks(data)
  await validateTaskAssets(data)
  const resources: { id: string; type: string; bytes: number; sha256: string; base64: string }[] =
      [],
    seen = new Set<string>()
  const encoded = await encodeTaskResources(data, async (id, blob) => {
    if (!seen.has(id)) {
      seen.add(id)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
      resources.push({
        id,
        type: blob.type,
        bytes: blob.size,
        sha256: await taskHash(blob),
        base64: btoa(binary),
      })
    }
    return id
  })
  const blob = new Blob(
    [
      JSON.stringify({
        format: 'new-world-tasks',
        schemaVersion: 1,
        appVersion: runningVersion,
        createdAt: Date.now(),
        detached: detachedTaskIds(data),
        data: encoded,
        resources,
      }),
    ],
    { type: 'application/json' },
  )
  taskAssert(blob.size <= 128 * 1024 * 1024, 'task file size limit')
  await readTaskFile(blob)
  return blob
}
export async function readTaskFile(blob: Blob): Promise<TaskData> {
  taskAssert(blob.size <= 128 * 1024 * 1024, 'task file size limit')
  const file = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer()),
  )
  closed(file, 'format schemaVersion appVersion createdAt detached data resources')
  taskAssert(
    file.format === 'new-world-tasks' && file.schemaVersion === 1,
    'unsupported task format version',
  )
  taskAssert(
    typeof file.appVersion === 'string' &&
      file.appVersion.length <= 100 &&
      Number.isSafeInteger(file.createdAt) &&
      file.createdAt >= 0 &&
      Array.isArray(file.resources) &&
      file.resources.length <= 30000,
    'task manifest',
  )
  const resources = new Map<string, Blob>(),
    used = new Set<string>()
  let total = 0
  for (const r of file.resources) {
    closed(r, 'id type bytes sha256 base64')
    taskAssert(
      /^[a-f0-9]{64}$/.test(r.id) &&
        !resources.has(r.id) &&
        typeof r.type === 'string' &&
        r.type.length <= 255 &&
        Number.isSafeInteger(r.bytes) &&
        r.bytes >= 0 &&
        r.bytes <= 16 * 1024 * 1024 &&
        typeof r.base64 === 'string' &&
        r.base64.length === 4 * Math.ceil(r.bytes / 3) &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.base64),
      'task resource',
    )
    total += r.bytes
    taskAssert(total <= 64 * 1024 * 1024, 'task asset total limit')
    const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)),
      content = new Blob([bytes], { type: r.type })
    taskAssert(
      content.size === r.bytes &&
        (await taskHash(content)) === r.sha256 &&
        (await taskHash(new Blob([r.sha256, '\n', r.type]))) === r.id,
      'task resource SHA-256',
    )
    resources.set(r.id, content)
  }
  const data = await decodeTaskResources(file.data, async (id) => {
    taskAssert(resources.has(id), 'missing task asset')
    used.add(id)
    return resources.get(id)!
  })
  taskAssert(used.size === resources.size, 'unreferenced task asset')
  validateTasks(data)
  taskAssert(
    JSON.stringify(file.detached) === JSON.stringify(detachedTaskIds(data)),
    'detached task history references',
  )
  taskAssert(data.taskSettings.length === 0, 'device settings cannot be imported')
  await validateTaskAssets(data)
  return data
}
export function taskConflicts(incoming: TaskData, current: TaskData) {
  const ids = taskIdentities(current)
  return [...taskIdentities(incoming)].filter((id) => ids.has(id)).length
}
export async function inspectTaskConflicts(data: TaskData) {
  return taskConflicts(data, await readTasks())
}
/** Standalone task imports never claim that external book IDs are trusted local bindings. */
export async function importTasks(source: TaskData, mode: 'preserve' | 'copy' | 'skip') {
  if (mode === 'skip') return
  const prepared = structuredClone(source)
  validateTasks(prepared)
  taskAssert(prepared.taskSettings.length === 0, 'import settings')
  await validateTaskAssets(prepared)
  for (const task of [...prepared.tasks, ...prepared.taskTemplates.flatMap((t) => t.tasks)])
    if (task.link) task.link.unconfirmed = true
  return changeTasks((current) => {
    if (mode === 'preserve')
      taskAssert(!taskConflicts(prepared, current), 'task ID conflict; import a copy')
    const incoming = structuredClone(prepared)
    if (mode === 'copy') {
      const reserved = taskIdentities(current),
        mapping = new Map<string, string>()
      for (const id of taskIdentities(incoming)) {
        let next: string
        do {
          next = crypto.randomUUID()
        } while (reserved.has(next))
        reserved.add(next)
        mapping.set(id, next)
      }
      remapTasks(incoming, mapping)
    }
    for (const name of taskStores)
      if (name !== 'taskSettings') (current[name] as unknown[]).push(...incoming[name])
    return incoming.tasks.length
  })
}
