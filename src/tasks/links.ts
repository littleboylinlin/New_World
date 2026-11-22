import { t } from '../i18n'
import { bookPath, button, element, link } from '../ui'
import { listBooks, readBook, storageError } from '../library'
import type { Book } from '../library'
import { listEditions, readChapter } from '../documents/store'
import type { Edition } from '../documents/model'
import { hashDocumentContent } from '../confirm-state'
import { showNotice } from '../undo'
import { choices } from './forms'
import type { TaskWorkLink, Task } from './model'

const key = (name: string) => t('tasks.' + name)
export const workTaskPath = (library: string, id: string) => `#/notes/tasks/work/${library}/${id}`
let pending: { link: TaskWorkLink; at: number } | undefined
export function takeTaskJump(edition: Edition) {
  const request = pending
  if (!request || Date.now() - request.at > 60000) {
    pending = undefined
    return
  }
  if (
    request.link.library !== edition.library ||
    request.link.bookId !== edition.bookId ||
    request.link.editionId !== edition.id
  )
    return
  pending = undefined
  return request.link
}
/** Opens the linked work, at the linked chapter and passage when the task points at one. */
export function openTaskLink(value: TaskWorkLink) {
  return (async () => {
      if (value.unconfirmed) throw new Error(key('unconfirmedLink'))
      const stored = await readBook(value.library, value.bookId)
      if (!stored || stored.book.workId) throw new Error(key('missingWork'))
      if (value.editionId) {
        const editions = await listEditions(value.library, value.bookId),
          edition = editions.find((e) => e.id === value.editionId)
        if (!edition) throw new Error(key('missingTarget'))
        if (value.chapterId) {
          const chapter = await readChapter(edition, value.chapterId)
          if (value.position && hashDocumentContent(chapter.content) !== value.position.contentHash)
            showNotice(key('stalePosition'))
        }
      }
      pending = { link: structuredClone(value), at: Date.now() }
      location.hash = bookPath(value.library, value.bookId, value.editionId)
    })().catch((e) => showNotice(storageError(e)))
}
export function taskLinkButton(value: TaskWorkLink) {
  const open = button(t('tasks.openWork', [value.title]), 'button button-quiet button-small')
  open.onclick = () => void openTaskLink(value)
  return open
}
export async function taskLinkFields(initial: Task['link']) {
  const books = (await Promise.all([listBooks('original'), listBooks('reference')]))
    .flat()
    .filter((b) => !b.workId)
  const identity = (value: { library: string; id: string }) => value.library + ':' + value.id,
    initialId = initial ? initial.library + ':' + initial.bookId : ''
  const options: [string, string][] = [
    ['', key('personal')],
    ...books.map(
      (b) =>
        [identity(b), b.title + (b.archivedAt ? ' · ' + key('archived') : '')] as [string, string],
    ),
  ]
  if (initial && !books.some((b) => identity(b) === initialId))
    options.push([initialId, initial.title + ' · ' + key('missingWork')])
  const work = choices(key('linkedWork'), options, initialId),
    edition = choices(key('linkedEdition'), []),
    chapter = choices(key('linkedChapter'), []),
    hint = element('p', 'dialog-help')
  let editions: Edition[] = [],
    changed = false,
    loading = false,
    generation = 0,
    loadError: unknown
  const set = (select: HTMLSelectElement, rows: [string, string][], value = '') => {
    select.replaceChildren(
      ...rows.map(([id, text]) => {
        const option = element('option', '', text)
        option.value = id
        return option
      }),
    )
    select.value = value
  }
  function chapters(value = '') {
    set(
      chapter.input,
      [
        ['', key('none')],
        ...(editions
          .find((e) => e.id === edition.input.value)
          ?.chapters.map((c) => [c.id, c.title] as [string, string]) ?? []),
      ],
      value,
    )
  }
  async function versions(first = false) {
    const turn = ++generation
    loading = true
    loadError = undefined
    try {
      const book = books.find((b) => identity(b) === work.input.value)
      editions = book ? await listEditions(book.library, book.id) : []
      if (turn !== generation) return
      set(
        edition.input,
        [['', key('none')], ...editions.map((e) => [e.id, e.name] as [string, string])],
        first ? (initial?.editionId ?? '') : '',
      )
      if (first && initial?.editionId && !editions.some((e) => e.id === initial.editionId))
        set(
          edition.input,
          [
            ['', key('none')],
            [initial.editionId, key('missingTarget')],
          ],
          initial.editionId,
        )
      chapters(first ? (initial?.chapterId ?? '') : '')
      if (first && initial?.chapterId && !chapter.input.value)
        set(
          chapter.input,
          [
            ['', key('none')],
            [initial.chapterId, key('missingTarget')],
          ],
          initial.chapterId,
        )
    } catch (error) {
      if (turn === generation) loadError = error
      throw error
    } finally {
      if (turn === generation) loading = false
    }
  }
  work.input.onchange = () => {
    changed = true
    void versions().catch((e) => {
      hint.textContent = storageError(e)
    })
  }
  edition.input.onchange = () => {
    changed = true
    chapters()
  }
  chapter.input.onchange = () => {
    changed = true
  }
  const confirm = button(key('confirmLink'), 'button button-quiet button-small')
  confirm.hidden = !initial?.unconfirmed
  confirm.onclick = () => {
    if (books.some((b) => identity(b) === work.input.value)) {
      changed = true
      confirm.hidden = true
      hint.textContent = key('linkConfirmed')
    }
  }
  await versions(true)
  return {
    fields: [
      work.wrapper,
      edition.wrapper,
      chapter.wrapper,
      confirm,
      hint,
      ...(initial ? [taskLinkButton(initial)] : []),
    ],
    read(): TaskWorkLink | undefined {
      if (loading) throw new Error(key('loadingLink'))
      if (loadError) throw loadError
      if (!work.input.value) return undefined
      if (!changed && initial) return structuredClone(initial)
      const book = books.find((b) => identity(b) === work.input.value)
      if (!book) throw new Error(key('missingWork'))
      return {
        library: book.library,
        bookId: book.id,
        title: book.title,
        ...(edition.input.value ? { editionId: edition.input.value } : {}),
        ...(chapter.input.value ? { chapterId: chapter.input.value } : {}),
        ...(initial?.position &&
        initial.bookId === book.id &&
        initial.editionId === edition.input.value &&
        initial.chapterId === chapter.input.value
          ? { position: initial.position }
          : {}),
      }
    },
  }
}
export async function createLinkedTask(value: TaskWorkLink, patch: Partial<Task> = {}, onCreated?: (task: Task) => void) {
  const { readTasks } = await import('./store'),
    { taskDialog } = await import('./view')
  await taskDialog(await readTasks(), undefined, { ...patch, link: value }, onCreated)
}
export function workTaskControls(book: Book) {
  const controls = element('div', 'task-actions'),
    add = button(key('addLinked'), 'button button-quiet button-small')
  add.onclick = () =>
    void createLinkedTask({
      library: book.library,
      bookId: book.workId ?? book.id,
      title: book.title,
    }).catch((e) => showNotice(storageError(e)))
  controls.append(
    add,
    link(
      workTaskPath(book.library, book.workId ?? book.id),
      key('workTasks'),
      'button button-quiet button-small',
    ),
  )
  return controls
}
