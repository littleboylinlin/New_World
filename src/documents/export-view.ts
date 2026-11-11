import { formDialog } from '../dialogs'
import { element } from '../ui'
import { exportStyles } from './export-style'
import type { ExportStyle } from './export-style'
import { exportEdition, isTextFormat, outputFormats, renderExportPreview } from './export'
import type { OutputFormat } from './export'
import type { ChapterInfo, ChapterInput } from './model'

export function showExportDialog(
  root: HTMLElement, title: string, chapters: ChapterInfo[],
  readPreview: (chapter: ChapterInfo) => Promise<ChapterInput>,
  readSelection: (ids: Set<string>) => Promise<ChapterInput[]>,
) {
  const formats = element('div', 'export-formats')
  formats.setAttribute('role', 'radiogroup')
  formats.setAttribute('aria-label', '导出格式')
  for (const [value, label] of Object.entries(outputFormats)) {
    const item = element('label', 'export-format')
    const radio = element('input')
    radio.type = 'radio'
    radio.name = 'format'
    radio.value = value
    radio.checked = value === 'txt'
    item.append(radio, element('span', '', label))
    formats.append(item)
  }
  const selectedFormat = () => formats.querySelector<HTMLInputElement>('input:checked')!.value as OutputFormat

  const styleLabel = element('label', 'field-label export-style', '导出样式')
  const style = element('select', 'title-input')
  for (const [value, preset] of Object.entries(exportStyles)) {
    const option = element('option', '', preset.label)
    option.value = value
    style.append(option)
  }
  styleLabel.append(style)
  const styleHint = element('p', 'export-style-hint', '字体和颜色由阅读器决定。')
  const selectedStyle = () => exportStyles[style.value as ExportStyle]

  const chapterBox = element('div', 'export-chapters')
  chapterBox.setAttribute('role', 'group')
  chapterBox.setAttribute('aria-label', '选择章节')
  const allRow = element('label', 'export-chapter export-chapter-all')
  const allInput = element('input')
  allInput.type = 'checkbox'
  allInput.checked = true
  allRow.append(allInput, element('span', '', '全选'))
  chapterBox.append(allRow)
  const boxes = chapters.map((info) => {
    const row = element('label', 'export-chapter')
    const box = element('input')
    box.type = 'checkbox'
    box.name = 'chapter'
    box.value = info.id
    box.checked = true
    row.append(box, element('span', '', info.title))
    chapterBox.append(row)
    return box
  })

  const preview = element('section', 'export-preview')
  preview.setAttribute('aria-label', '导出预览')
  const page = element('div', 'export-preview-page')
  page.tabIndex = 0
  preview.append(element('h3', '', '导出预览'), page)
  const options = element('div')
  options.append(formats, styleLabel, styleHint, chapterBox)
  const layout = element('div', 'export-layout')
  layout.append(options, preview)

  let sample: { id: string; chapter: Promise<ChapterInput> } | undefined
  let request = 0
  async function refreshPreview() {
    const token = ++request
    const format = selectedFormat()
    const preset = selectedStyle()
    style.disabled = isTextFormat(format)
    styleHint.hidden = !style.disabled
    const first = chapters.find((_, index) => boxes[index].checked)
    if (!first) {
      page.removeAttribute('aria-busy')
      page.replaceChildren(element('p', 'export-preview-message', '请选择要预览的章节。'))
      return
    }
    if (sample?.id !== first.id) sample = { id: first.id, chapter: readPreview(first) }
    const current = sample
    page.setAttribute('aria-busy', 'true')
    try {
      const content = await renderExportPreview(format, preset, await current.chapter)
      if (token !== request || !page.isConnected) return
      page.replaceChildren(content)
      page.scrollTop = 0
    } catch {
      if (sample === current) sample = undefined
      if (token === request && page.isConnected) {
        page.replaceChildren(element('p', 'export-preview-message', '无法读取章节预览。'))
      }
    } finally {
      if (token === request) page.removeAttribute('aria-busy')
    }
  }

  formats.addEventListener('change', () => { void refreshPreview() })
  style.addEventListener('change', () => { void refreshPreview() })
  chapterBox.addEventListener('change', (event) => {
    if (event.target === allInput) {
      for (const box of boxes) box.checked = allInput.checked
    } else {
      allInput.checked = boxes.every((box) => box.checked)
      allInput.indeterminate = !allInput.checked && boxes.some((box) => box.checked)
    }
    void refreshPreview()
  })
  formDialog(root, { title: '导出编辑稿', action: '开始导出', fields: [layout] }, async (data) => {
    const ids = new Set(data.getAll('chapter').map(String))
    if (!ids.size) throw new Error('请至少选择一章。')
    const format = selectedFormat()
    const preset = selectedStyle()
    const selection = await readSelection(ids)
    if (!selection.length) throw new Error('所选章节已移除，请重新选择。')
    await exportEdition(format, title, selection, preset)
  })
  void refreshPreview()
}
