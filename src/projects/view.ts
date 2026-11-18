import { recordExport } from '../web-storage'
import { t } from '../i18n'
import { formDialog } from '../dialogs'
import { bookPath, button, downloadFile, element, libraries } from '../ui'
import { showNotice } from '../undo'
import { storageError } from '../library'
import type { ProjectRoot } from './model'
import { ProjectError } from './model'
import { projectMime, readProject } from './archive'
import { exportProject, importProject, inspectConflicts } from './store'

export function projectMessage(error: unknown) {
  if (error instanceof ProjectError && ['metadata', 'unsupported'].includes(error.code)) return t(`project.${error.code}`, [error.detail])
  return error instanceof ProjectError ? t(`project.${error.code}`) : storageError(error)
}

export function showProjectExport(root: ProjectRoot, title: string) {
  const label = element('label', 'field-label', t('project.filename'))
  const name = element('input', 'title-input')
  name.name = 'filename'; name.required = true; name.maxLength = 240
  name.value = `${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180)}.newworld`
  label.append(name)
  formDialog(document.body, {
    title: t('project.export'), action: t('project.save'), description: t('project.exportHint'), fields: [label],
  }, async () => {
    const filename = /\.newworld$/i.test(name.value) ? name.value : `${name.value}.newworld`
    if (/[<>:"/\\|?*\x00-\x1f]/.test(filename) || !filename.trim()) throw new Error(t('project.badFilename'))
    try {
      // Invoke the browser's picker during the click, while user activation is available.
      const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable: () => Promise<WritableStream & { write: (data: Blob) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }> }> }).showSaveFilePicker
      const handle = !window.newWorldDesktop?.saveProject && picker ? await picker.call(window, { suggestedName: filename, types: [{ description: 'New_World', accept: { [projectMime]: ['.newworld'] } }] }) : undefined
      const blob = await exportProject(root)
      if (window.newWorldDesktop?.saveProject) {
        if (!await window.newWorldDesktop.saveProject(filename, new Uint8Array(await blob.arrayBuffer()))) return
      } else if (handle) {
        const stream = await handle.createWritable()
        try { await stream.write(blob); await stream.close() } catch (error) { await stream.abort().catch(() => {}); throw error }
      } else downloadFile(blob, filename)
      if (!window.newWorldDesktop) recordExport()
      showNotice(t('project.exported'))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      throw new Error(projectMessage(error))
    }
  })
}

let beforeImport: () => Promise<boolean> = async () => true
let pending = Promise.resolve()
export function mountProjectImports(guard: () => Promise<boolean>) { beforeImport = guard }

function waitForDialogs() {
  if (!document.querySelector('dialog[open]')) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector('dialog[open]')) { observer.disconnect(); resolve() }
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] })
  })
}
async function previewImport(file: Blob) {
  const contents = await readProject(file)
  const conflicts = await inspectConflicts(contents)
  const root = contents.data.books.find((b) => b.id === contents.manifest.root.id)!
  const conflict = conflicts.ids > 0 || conflicts.works > 0 || conflicts.originals > 0
  const summary = element('div', 'project-summary')
  summary.append(element('p', '', t('project.summary', [root.title, contents.data.chapters.length, contents.data.editions.length, contents.data.files.length])),
    element('p', 'dialog-help', t('project.library', [libraries[root.library].name])))
  summary.append(element('p', 'dialog-help', t('project.historySummary', [contents.data.revisions.length, contents.data.ideas.length, contents.data.trash.length])))
  summary.append(element('p','dialog-help',t('tasks.projectSummary',[contents.data.tasks.length,contents.data.taskAttachments.length])))
  if (conflict) summary.append(element('p', 'dialog-help', t('project.conflicts', [conflicts.works, conflicts.originals, conflicts.ids])))
  const choices = element('label', 'field-label', t('project.mode'))
  const mode = element('select', 'title-input')
  for (const [value, key] of [...(!conflict ? [['preserve', 'project.preserve']] : []), ['copy', 'project.copy'], ['skip', 'project.skip']]) {
    const option = element('option', '', t(key)); option.value = value; mode.append(option)
  }
  mode.name = 'mode'; choices.append(mode)
  summary.append(choices, element('p', 'dialog-help', t('project.importHint')))
  await new Promise<void>((resolve) => {
    formDialog(document.body, { title: t('project.importPreview'), action: t('project.confirm'), fields: [summary] }, async () => {
      if (mode.value === 'skip') return
      if (!await beforeImport()) throw new Error(t('project.saveFirst'))
      try {
        const imported = await importProject(contents, mode.value as 'copy' | 'preserve')
        if (imported) { showNotice(t('project.imported')); location.hash = bookPath(imported.library, imported.id) }
      } catch (error) { throw new Error(projectMessage(error)) }
    })
    document.body.lastElementChild!.addEventListener('close', () => resolve(), { once: true })
  })
}
export function enqueueProject(file: () => Promise<Blob | null>) {
  pending = pending.then(async () => {
    await waitForDialogs()
    try { const picked = await file(); if (picked) await previewImport(picked) }
    catch (error) { showNotice(projectMessage(error)) }
  })
  return pending
}
export function projectImportButton() {
  const choose = button(t('project.import'), 'button button-quiet', 'file')
  choose.addEventListener('click', () => {
    if (window.newWorldDesktop?.openProject) {
      void enqueueProject(async () => { const file = await window.newWorldDesktop!.openProject!(); return file ? new Blob([Uint8Array.from(file.bytes)]) : null })
      return
    }
    const input = element('input'); input.type = 'file'; input.accept = '.newworld'; input.hidden = true
    input.addEventListener('change', () => { const file = input.files?.[0]; input.remove(); if (file) void enqueueProject(async () => file) }, { once: true })
    input.addEventListener('cancel', () => input.remove(), { once: true })
    document.body.append(input); input.click()
  })
  return choose
}
