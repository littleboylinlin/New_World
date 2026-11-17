import { taskAssert } from './model'
import type { TaskAttachment, TaskData } from './model'

export const attachmentTypes: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}
export async function taskHash(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
export async function verifyAttachment(a: TaskAttachment) {
  const ext = a.name.split('.').at(-1)!.toLowerCase()
  taskAssert(attachmentTypes[ext] === a.type, 'unsupported attachment type: ' + ext)
  taskAssert(
    a.content.size === a.bytes && (await taskHash(a.content)) === a.sha256,
    'attachment SHA-256',
  )
  const bytes = new Uint8Array(await a.content.slice(0, 16).arrayBuffer()),
    starts = (values: number[]) => values.every((v, i) => bytes[i] === v)
  if (['txt', 'md', 'csv'].includes(ext)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await a.content.arrayBuffer())
    taskAssert(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text), 'attachment must be UTF-8 text')
  } else if (ext === 'png') taskAssert(starts([137, 80, 78, 71, 13, 10, 26, 10]), 'PNG signature')
  else if (ext === 'jpg' || ext === 'jpeg') taskAssert(starts([255, 216, 255]), 'JPEG signature')
  else if (ext === 'gif')
    taskAssert(
      starts([71, 73, 70, 56]) && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97,
      'GIF signature',
    )
  else if (ext === 'webp')
    taskAssert(
      starts([82, 73, 70, 70]) && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP',
      'WebP signature',
    )
  else if (ext === 'pdf') taskAssert(starts([37, 80, 68, 70, 45]), 'PDF signature')
  else taskAssert(starts([80, 75, 3, 4]), 'DOCX ZIP signature')
}
export async function validateTaskAssets(data: TaskData) {
  for (const a of [...data.taskAttachments, ...data.taskTemplates.flatMap((t) => t.attachments)])
    await verifyAttachment(a)
}
export async function attachmentFrom(file: File, taskId: string): Promise<TaskAttachment> {
  taskAssert(file.size <= 16 * 1024 * 1024, 'attachment size limit (16 MiB)')
  const ext = file.name.split('.').at(-1)!.toLowerCase(),
    type = attachmentTypes[ext]
  taskAssert(type, 'unsupported attachment extension')
  const content = new Blob([file], { type }),
    a = {
      id: crypto.randomUUID(),
      taskId,
      name: file.name,
      type,
      bytes: content.size,
      sha256: await taskHash(content),
      content,
    }
  await verifyAttachment(a)
  return a
}
