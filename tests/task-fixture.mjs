// Seeds genuine task records for closure/copy tests; UI tests below cover normal creation.
export async function seedOwnedTasks({ root, library, firstEdition, first, content }) {
  const id = () => crypto.randomUUID(),
    now = 1794844800000
  const project = id(),
    subproject = id(),
    section = id(),
    label = id(),
    parent = id(),
    child = id(),
    deleted = id(),
    global = id(),
    foreign = id(),
    unconfirmed = id(),
    deletionId = id()
  const hash = (text) => {
    let h1 = 0x811c9dc5,
      h2 = 0x811c9dc5 ^ 0x9e3779b9
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
      h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
  }
  const row = (taskId, title, patch = {}) => ({
    id: taskId,
    title,
    description: '说明\n第二行',
    notes: '独立备注',
    projectId: subproject,
    sectionId: section,
    parentId: null,
    priority: 2,
    labelIds: [label],
    order: 1024,
    expanded: true,
    planDate: '2026-11-30',
    completedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    revision: 2,
    ...patch,
  })
  const link = {
    library,
    bookId: root,
    title: '雾港',
    editionId: firstEdition,
    chapterId: first,
    position: { from: 1, to: 3, quote: '雾港', contentHash: hash(JSON.stringify(content)) },
  }
  const data = {
    tasks: [
      row(parent, '作品任务 · ' + root, {
        link,
        planTime: '15:00',
        zone: 'Asia/Shanghai',
        reminderMinutes: 45,
        deadline: '2027-01-01',
        durationMinutes: 45,
        repeat: { frequency: 'month', interval: 1, anchorDate: '2026-10-31' },
        comments: [
          { id: id(), text: '评论\n保留换行', createdAt: now, updatedAt: now, deletedAt: null },
        ],
      }),
      row(child, '已完成子任务', {
        parentId: parent,
        link: { library, bookId: root, title: '雾港' },
        completedAt: now,
      }),
      row(deleted, '回收的子任务', {
        parentId: parent,
        link: { library, bookId: root, title: '雾港' },
        deletedAt: now,
        deletionId,
      }),
      row(global, 'PRIVATE-GLOBAL-TASK'),
      row(foreign, 'PRIVATE-OTHER-WORK', {
        link: { library: 'original', bookId: id(), title: 'PRIVATE-OTHER-BOOK' },
      }),
      row(unconfirmed, 'PRIVATE-UNCONFIRMED', {
        link: { library, bookId: root, title: '未确认外部关联', unconfirmed: true },
      }),
    ],
    taskProjects: [
      {
        id: project,
        name: '写作总计划',
        color: '#5274a5',
        icon: '📚',
        parentId: null,
        order: 1024,
        favorite: true,
        archivedAt: null,
        deletedAt: null,
        revision: 1,
      },
      {
        id: subproject,
        name: '章节计划',
        color: '#aabbcc',
        icon: '港',
        parentId: project,
        order: 1024,
        favorite: false,
        archivedAt: null,
        deletedAt: null,
        revision: 1,
        view: { mode: 'board', calendar: 'week', sort: 'priority' },
      },
    ],
    taskSections: [
      { id: section, projectId: subproject, name: '待修订', order: 1024, deletedAt: null },
    ],
    taskLabels: [
      { id: label, name: '创作', color: '#123456', favorite: true, deletedAt: null },
      { id: id(), name: 'PRIVATE-LABEL', color: '#654321', favorite: false, deletedAt: null },
    ],
    taskCompletions: [
      { id: id(), taskId: child, title: '已完成子任务', at: now, occurrence: '2026-11-29' },
    ],
    taskSettings: [{ id: 'view:PRIVATE-VIEW', value: 'PRIVATE-DEVICE-SETTING' }],
    taskFilters: [
      {
        id: id(),
        name: 'PRIVATE-FILTER',
        favorite: true,
        group: {
          operator: 'all',
          conditions: [
            { field: 'text', op: 'is', value: 'PRIVATE-QUERY' },
            { field: 'project', op: 'is', value: subproject },
          ],
        },
      },
    ],
    taskTemplates: [
      {
        id: id(),
        name: 'PRIVATE-TEMPLATE',
        tasks: [row(id(), 'PRIVATE-TEMPLATE-TEXT', { projectId: null, sectionId: null })],
        attachments: [],
      },
    ],
    taskAttachments: [],
  }
  const blob = new Blob(['附件原始字节\r\n第二行\n'], { type: 'text/plain' }),
    sha = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('')
  data.taskAttachments.push({
    id: id(),
    taskId: parent,
    name: '参考「雾港」.txt',
    type: blob.type,
    bytes: blob.size,
    sha256: sha,
    content: blob,
  })
  const db = await new Promise((r) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => r(q.result)
    }),
    tx = db.transaction([...Object.keys(data), 'books'], 'readwrite')
  const bookRequest = tx.objectStore('books').get([library, root])
  bookRequest.onsuccess = () =>
    tx.objectStore('books').put({
      ...bookRequest.result,
      metadata: {
        author: '验收作者',
        subtitle: '创作任务示例',
        synopsis: '含完整任务的验收小说。\n\n用于跨书库迁移。',
        tags: ['验收'],
        status: 'serializing',
      },
    })
  for (const [name, rows] of Object.entries(data))
    for (const row of rows) tx.objectStore(name).add(row)
  await new Promise((r, j) => {
    tx.oncomplete = r
    tx.onabort = () => j(tx.error)
  })
  db.close()
  return {
    parent,
    child,
    deleted,
    global,
    foreign,
    unconfirmed,
    project,
    subproject,
    section,
    label,
  }
}
