import { t } from './i18n'
import { acceptedExtensions } from './formats'
import { importBook, storageError } from './library'
import type { LibraryId } from './library'
import { button, element } from './ui'

export function bookImport(id: LibraryId, label: string, onImport: () => void, workId?: string) {
  const choose = button(label, 'button button-primary', 'plus')
  const input = element('input')
  input.type = 'file'
  input.multiple = true
  input.accept = acceptedExtensions
  input.hidden = true
  input.setAttribute('aria-label', t('bookImport.chooseBookFiles'))
  choose.addEventListener('click', () => input.click())
  const progress = element('section', 'import-notice')
  progress.hidden = true
  const summary = element('p')
  summary.setAttribute('role', 'status')
  const failures = element('ul')
  failures.hidden = true
  progress.append(summary, failures)
  input.addEventListener('change', async () => {
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (!files.length || choose.disabled) return
    choose.disabled = true
    progress.hidden = false
    failures.hidden = true
    failures.replaceChildren()
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
  })

  return { choose, input, progress }
}
