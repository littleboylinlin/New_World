import { t } from '../i18n'
import { listBooks } from '../library'
import { chapterText } from '../documents/model'
import { listEditions, readChapter } from '../documents/store'
import { setExpanded } from '../shell/collapse'
import { button, downloadFile, element } from '../ui'
import { confirmDialog, requireAi } from './access'
import { describeAiError } from './errors'
import { draftStyle, excerptsFrom, styleFeature } from './style-analysis'
import type { StyleSource } from './style-analysis'
import {
  allStyles, cleanStyle, deleteStyle, exportStyles, importStyles, isBuiltin, maxSamples, saveStyle, styleChanges, styleInstructions,
} from './styles'
import type { StyleInput, WritingStyle } from './styles'
import './styles.css'

const maxChapters = 5

let sequence = 0
const uid = (name: string) => `styles-${name}-${++sequence}`

function kindLabel(style: WritingStyle) {
  if (isBuiltin(style.id)) return t('styles.kindBuiltin')
  return t(`styles.kind.${style.kind}`)
}

/** The style library on the AI settings page: built-in examples and the user's own styles. */
export function mountStyleLibrary(card: HTMLElement): () => Promise<void> {
  let styles: WritingStyle[] = []
  let editing: { id?: string; draft: StyleInput; readOnly: boolean } | null = null
  let loading = 0

  const actions = element('div', 'styles-actions')
  const create = button(t('styles.new'), 'button button-small', 'plus')
  const fromAuthor = button(t('styles.fromAuthor'), 'button button-quiet button-small', 'ai')
  const fromOwn = button(t('styles.fromOwn'), 'button button-quiet button-small', 'ai')
  const importButton = button(t('styles.import'), 'button button-quiet button-small')
  const exportButton = button(t('styles.exportAll'), 'button button-quiet button-small')
  const importInput = element('input')
  importInput.type = 'file'
  importInput.accept = 'application/json,.json'
  importInput.hidden = true
  actions.append(create, fromAuthor, fromOwn, importButton, exportButton, importInput)

  const list = element('ul', 'styles-list')
  list.setAttribute('aria-label', t('styles.listLabel'))
  const editorRegion = element('div', 'styles-editor-region')
  editorRegion.hidden = true
  const status = element('p', 'settings-state styles-status')
  status.setAttribute('role', 'status')
  card.append(element('p', 'dialog-help', t('styles.intro')), actions, list, editorRegion, status)

  const say = (text: string) => { status.textContent = text }

  // ——— List ———
  function render() {
    list.replaceChildren()
    for (const style of styles) {
      const item = element('li', 'styles-item')
      item.dataset.style = style.id
      const head = element('div', 'styles-item-head')
      const name = element('strong', 'styles-item-name', style.name)
      head.append(name, element('span', 'styles-tag', kindLabel(style)))
      const summary = element('p', 'styles-item-summary', style.summary || style.basis || '')
      const controls = element('div', 'styles-item-actions')
      const builtin = isBuiltin(style.id)
      const open = button(builtin ? t('styles.view') : t('styles.edit'), 'button button-quiet button-small')
      open.setAttribute('aria-label', `${builtin ? t('styles.view') : t('styles.edit')}：${style.name}`)
      open.addEventListener('click', () => openEditor(style))
      controls.append(open)
      if (builtin) {
        const copy = button(t('styles.copy'), 'button button-quiet button-small')
        copy.setAttribute('aria-label', `${t('styles.copy')}：${style.name}`)
        copy.addEventListener('click', () => openEditor({ ...style, name: t('styles.copyName', [style.name]) }, true))
        controls.append(copy)
      } else {
        const exportOne = button(t('styles.export'), 'button button-quiet button-small')
        exportOne.setAttribute('aria-label', `${t('styles.export')}：${style.name}`)
        exportOne.addEventListener('click', () => { void download([style.id], style.name) })
        const remove = button(t('styles.delete'), 'button button-quiet button-small styles-delete')
        remove.setAttribute('aria-label', `${t('styles.delete')}：${style.name}`)
        remove.addEventListener('click', () => { void removeStyle(style) })
        controls.append(exportOne, remove)
      }
      item.append(head, summary, controls)
      list.append(item)
    }
    exportButton.disabled = !styles.some((style) => !isBuiltin(style.id))
  }

  async function refresh() {
    const turn = ++loading
    try {
      const next = await allStyles()
      if (turn !== loading) return
      styles = next
      render()
    } catch (cause) {
      say(cause instanceof Error ? cause.message : String(cause))
    }
  }
  styleChanges.addEventListener('change', () => { void refresh() })

  // ——— Editor ———
  function textArea(label: string, value: string, hint?: string, rows = 3) {
    const wrap = element('label', 'field-label styles-field')
    const name = element('span', 'aip-label', label)
    name.id = uid('label')
    const area = element('textarea', 'title-input styles-textarea')
    area.rows = rows
    area.value = value
    area.setAttribute('aria-labelledby', name.id)
    wrap.append(name, area)
    if (hint) wrap.append(element('span', 'aip-hint', hint))
    return { wrap, area }
  }

  /** Opens a style in the form; `copy` saves it as a new style of the user's. */
  function openEditor(style: WritingStyle | StyleInput & { id?: string }, copy = false) {
    const readOnly = Boolean(style.id && isBuiltin(style.id)) && !copy
    const { id: _id, ...rest } = style as WritingStyle
    editing = { id: copy ? undefined : style.id, draft: cleanStyleSafe(rest), readOnly }
    const current = editing
    const form = element('form', 'styles-editor')
    form.noValidate = true
    const heading = element('h4', 'styles-editor-title', readOnly ? t('styles.viewTitle', [style.name]) : current.id ? t('styles.editTitle', [style.name]) : t('styles.newTitle'))
    const nameField = element('label', 'field-label styles-field')
    const nameLabel = element('span', 'aip-label', t('styles.name'))
    nameLabel.id = uid('label')
    const name = element('input', 'title-input')
    name.value = current.draft.name
    name.maxLength = 80
    name.setAttribute('aria-labelledby', nameLabel.id)
    nameField.append(nameLabel, name)
    const summary = textArea(t('styles.summary'), current.draft.summary, t('styles.summaryHint'), 2)
    const vocabulary = textArea(t('styles.vocabulary'), current.draft.vocabulary)
    const rhythm = textArea(t('styles.rhythm'), current.draft.rhythm)
    const perspective = textArea(t('styles.perspective'), current.draft.perspective, undefined, 2)
    const samples = textArea(t('styles.samples'), current.draft.samples.join('\n\n'), t('styles.samplesHint', [maxSamples]), 5)
    const basis = textArea(t('styles.basis'), current.draft.basis ?? '', t('styles.basisHint'), 1)
    const fields = [name, summary.area, vocabulary.area, rhythm.area, perspective.area, samples.area, basis.area]
    for (const field of fields) field.readOnly = readOnly

    const preview = element('details', 'styles-preview')
    const previewTitle = element('summary', '', t('styles.preview'))
    const previewText = element('pre', 'styles-preview-text')
    preview.append(previewTitle, previewText)
    const read = (): StyleInput => ({
      name: name.value, kind: current.draft.kind, summary: summary.area.value, vocabulary: vocabulary.area.value,
      rhythm: rhythm.area.value, perspective: perspective.area.value, basis: basis.area.value,
      samples: samples.area.value.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean),
    })
    const paintPreview = () => {
      try {
        previewText.textContent = styleInstructions({ ...cleanStyle(read()), id: '', createdAt: 0, updatedAt: 0 })
      } catch {
        previewText.textContent = t('styles.needName')
      }
    }
    preview.addEventListener('toggle', paintPreview)
    form.addEventListener('input', () => { if (preview.open) paintPreview() })

    const error = element('p', 'field-error')
    error.setAttribute('role', 'alert')
    error.hidden = true
    const controls = element('div', 'settings-actions')
    const save = button(t('styles.save'), 'button button-primary')
    save.type = 'submit'
    save.hidden = readOnly
    const copyButton = button(t('styles.copy'), 'button button-quiet')
    copyButton.hidden = !readOnly
    copyButton.addEventListener('click', () => openEditor({ ...(style as WritingStyle), name: t('styles.copyName', [style.name]) }, true))
    const cancel = button(readOnly ? t('common.close') : t('common.cancel'), 'button button-quiet')
    cancel.addEventListener('click', closeEditor)
    controls.append(save, copyButton, cancel)
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (readOnly) return
      error.hidden = true
      try {
        const saved = await saveStyle(read(), current.id)
        say(t('styles.saved', [saved.name]))
        closeEditor()
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : String(cause)
        error.hidden = false
      }
    })
    form.append(heading, nameField, summary.wrap, vocabulary.wrap, rhythm.wrap, perspective.wrap, samples.wrap, basis.wrap, preview, error, controls)
    editorRegion.replaceChildren(form)
    setExpanded(editorRegion, true, () => editorRegion.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
    if (!readOnly) name.focus({ preventScroll: true })
  }

  function cleanStyleSafe(input: StyleInput): StyleInput {
    try { return cleanStyle(input) } catch { return { ...input, samples: [...(input.samples ?? [])] } }
  }

  function closeEditor() {
    editing = null
    setExpanded(editorRegion, false)
  }

  async function removeStyle(style: WritingStyle) {
    if (!await confirmDialog(t('styles.deleteTitle', [style.name]), [t('styles.deleteCopy')], t('styles.delete'), true)) return
    await deleteStyle(style.id)
    if (editing?.id === style.id) closeEditor()
    say(t('styles.deleted'))
  }

  create.addEventListener('click', () => openEditor({ name: '', kind: 'custom', summary: '', vocabulary: '', rhythm: '', perspective: '', samples: [] }))

  // ——— Files ———
  async function download(ids?: string[], name?: string) {
    const file = await exportStyles(ids)
    downloadFile(new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' }), `${name ?? 'new-world-styles'}.json`)
    say(t('styles.exported', [file.styles.length]))
  }
  exportButton.addEventListener('click', () => { void download() })
  importButton.addEventListener('click', () => importInput.click())
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0]
    importInput.value = ''
    if (!file) return
    try {
      const count = await importStyles(JSON.parse(await file.text()))
      say(t('styles.imported', [count]))
    } catch (cause) {
      say(cause instanceof SyntaxError ? t('styles.importFormat') : cause instanceof Error ? cause.message : String(cause))
    }
  })

  // ——— Drafting with AI ———
  function generationDialog(title: string, body: HTMLElement[], source: () => Promise<StyleSource | null>) {
    const dialog = element('dialog', 'manage-dialog styles-dialog')
    const form = element('form', 'manage-form')
    const heading = element('h2', '', title)
    heading.id = uid('dialog')
    dialog.setAttribute('aria-labelledby', heading.id)
    const note = element('p', 'dialog-help styles-dialog-status')
    note.setAttribute('role', 'status')
    const controls = element('div', 'dialog-controls')
    const cancel = button(t('common.cancel'), 'button button-quiet')
    const go = button(t('styles.generate'), 'button button-primary')
    go.type = 'submit'
    controls.append(cancel, go)
    form.append(heading, ...body, note, controls)
    dialog.append(form)
    document.body.append(dialog)
    let running: { cancel: () => void } | undefined
    cancel.addEventListener('click', () => { running?.cancel(); dialog.close() })
    dialog.addEventListener('close', () => { running?.cancel(); dialog.remove() }, { once: true })
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (running) return
      note.classList.remove('field-error')
      const chosen = await source()
      if (!chosen) return
      const profile = await requireAi(styleFeature)
      if (!profile || !dialog.open) return
      go.disabled = true
      note.textContent = t('styles.generating', [profile.config.name])
      const { run, result } = draftStyle(chosen, profile.id)
      running = run
      const outcome = await result
      running = undefined
      go.disabled = false
      if (!dialog.open) return
      if (outcome.ok) {
        dialog.close()
        openEditor(outcome.style)
        say(t('styles.drafted'))
        return
      }
      if (outcome.cancelled) { note.textContent = ''; return }
      note.classList.add('field-error')
      note.textContent = outcome.error ? describeAiError(outcome.error) : t('styles.unreadable')
    })
    dialog.showModal()
    return dialog
  }

  fromAuthor.addEventListener('click', () => {
    const field = element('label', 'field-label')
    const label = element('span', '', t('styles.authorLabel'))
    const input = element('input', 'title-input')
    input.maxLength = 200
    input.placeholder = t('styles.authorPlaceholder')
    field.append(label, input)
    const note = element('p', 'dialog-help', t('styles.authorNote'))
    generationDialog(t('styles.fromAuthor'), [field, note], async () => {
      const who = input.value.trim()
      if (!who) { input.focus(); return null }
      return { kind: 'author', who }
    })
    input.focus()
  })

  fromOwn.addEventListener('click', async () => {
    const works = (await listBooks('original')).filter((book) => !book.archivedAt)
    const workField = element('label', 'field-label')
    const workSelect = element('select', 'editor-select')
    workField.append(element('span', '', t('styles.ownWork')), workSelect)
    for (const book of works) {
      const option = element('option', '', book.title)
      option.value = book.id
      workSelect.append(option)
    }
    const chapters = element('fieldset', 'styles-chapters')
    chapters.append(element('legend', '', t('styles.ownChapters', [maxChapters])))
    const hint = element('p', 'dialog-help', t('styles.ownNote'))
    let editions: Awaited<ReturnType<typeof listEditions>> = []
    async function loadChapters() {
      chapters.querySelectorAll('label, p').forEach((node) => node.remove())
      const book = works.find((item) => item.id === workSelect.value)
      editions = book ? await listEditions('original', book.id) : []
      const edition = editions[0]
      if (!edition) { chapters.append(element('p', 'dialog-help', t('styles.ownNone'))); return }
      edition.chapters.forEach((chapter, index) => {
        const row = element('label', 'appearance-check')
        const box = element('input')
        box.type = 'checkbox'
        box.value = chapter.id
        box.checked = index < 3
        row.append(box, element('span', '', chapter.title))
        chapters.append(row)
      })
    }
    workSelect.addEventListener('change', () => { void loadChapters() })
    if (!works.length) {
      const empty = element('p', 'dialog-help', t('styles.ownNoWorks'))
      generationDialog(t('styles.fromOwn'), [empty], async () => null)
      return
    }
    await loadChapters()
    generationDialog(t('styles.fromOwn'), [workField, chapters, hint], async () => {
      const edition = editions[0]
      const picked = [...chapters.querySelectorAll<HTMLInputElement>('input:checked')].map((box) => box.value)
      if (!edition || !picked.length || picked.length > maxChapters) {
        hint.textContent = t('styles.ownPick', [maxChapters])
        return null
      }
      const texts: string[] = []
      for (const id of picked) texts.push(chapterText((await readChapter({ library: 'original', bookId: edition.bookId, id: edition.id }, id)).content, '\n'))
      const titles = edition.chapters.filter((chapter) => picked.includes(chapter.id)).map((chapter) => chapter.title)
      const book = works.find((item) => item.id === workSelect.value)
      return { kind: 'own', excerpts: excerptsFrom(texts), basis: `${book?.title ?? ''}：${titles.join('、')}` }
    })
  })

  void refresh()
  return refresh
}
