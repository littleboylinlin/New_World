import { enqueueProject } from './projects/view'
import { t } from './i18n'
import { acceptedExtensions } from './formats'
import { importBook, storageError } from './library'
import type { LibraryId } from './library'
import { button, element } from './ui'
import { showWorkInformation } from './work-information-view'

export function bookImport(target: LibraryId | (() => Promise<LibraryId | null>), label: string, onImport: () => void, workId?: string) {
  const choose = button(label, 'button button-primary', 'plus')
  const input = element('input')
  input.type = 'file'
  input.multiple = true
  input.accept = typeof target === 'function' ? acceptedExtensions + ',.newworld' : acceptedExtensions
  input.hidden = true
  input.setAttribute('aria-label', t('bookImport.chooseBookFiles'))
  choose.addEventListener('click', () => input.click())
  const progress = element('section', 'import-notice')
  progress.hidden = true
  const summary = element('p')
  summary.setAttribute('role', 'status')
  const failures = element('ul')
  const information = element('div', 'version-actions')
  failures.hidden = true
  progress.append(summary, failures, information)
  input.addEventListener('change', async () => {
    const picked = Array.from(input.files ?? [])
    input.value = ''
    if (!picked.length || choose.disabled) return
    const projects = typeof target === 'function' ? picked.filter((file) => /\.newworld$/i.test(file.name)) : []
    const files = picked.filter((file) => !projects.includes(file))
    const importProjects = () => {
      for (const file of projects) void enqueueProject(async () => file)
    }
    if (!files.length) { importProjects(); return }
    choose.disabled = true
    const id = typeof target === 'function' ? await target() : target
    if (!id) {
      choose.disabled = false
      importProjects()
      return
    }
    progress.hidden = false
    failures.hidden = true
    failures.replaceChildren()
    information.replaceChildren()
    void navigator.storage?.persist?.().catch(() => {})
    let imported = 0
    let duplicates = 0
    let failed = 0
    for (const [index, file] of files.entries()) {
      summary.textContent = t('bookImport.importing', [index + 1, files.length])
      try {
        const result = await importBook(id, file, workId)
        if (result.duplicate) {
          duplicates++
          failures.append(element('li', '', t('bookImport.matchesTheOriginalFileOfAndWasSkipped', [file.name, result.book.title])))
        } else {
          imported++
          if (!workId) {
            const edit = button(t('work.afterImport', [result.book.title]), 'button button-quiet button-small', 'edit')
            edit.addEventListener('click', () => showWorkInformation(result.book))
            information.append(edit)
          }
        }
      } catch (error) {
        failed++
        failures.append(element('li', '', `${file.name} · ${storageError(error)}`))
      }
    }
    if (imported) onImport()
    summary.textContent = t('bookImport.importedBookS', [imported, duplicates ? t('bookImport.skippedDuplicateS', [duplicates]) : '', failed ? t('bookImport.fileSFailed', [failed]) : ''])
    failures.hidden = !duplicates && !failed
    choose.disabled = false
    importProjects()
  })

  return { choose, input, progress }
}
