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
  input.setAttribute('aria-label', '选择小说文件')
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
      summary.textContent = `正在导入 ${index + 1} / ${files.length}…`
      try {
        const result = await importBook(id, file, workId)
        if (result.duplicate) {
          duplicates++
          failures.append(element('li', '', `${file.name} 与「${result.book.title}」的原文件相同，已跳过。`))
        } else {
          imported++
        }
      } catch (error) {
        failed++
        failures.append(element('li', '', `${file.name} · ${storageError(error)}`))
      }
    }
    if (imported) onImport()
    summary.textContent = `已导入 ${imported} 部${duplicates ? `，跳过 ${duplicates} 部重复文件` : ''}${failed ? `，${failed} 个文件导入失败` : ''}。`
    failures.hidden = !duplicates && !failed
    choose.disabled = false
  })

  return { choose, input, progress }
}
