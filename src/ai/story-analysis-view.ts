import { t } from '../i18n'
import { storageError } from '../library'
import { applyExtraction, extractionMatches, extractionProposals } from '../story-settings/ai-extraction'
import type { ExtractionProposal } from '../story-settings/ai-extraction'
import { storyInput, storyLabel } from '../story-settings/card-editor'
import { storyCards, uniqueAliases } from '../story-settings/model'
import type { Point, StoryScene, StoryWork } from '../story-settings/model'
import { readStorySettings } from '../story-settings/store'
import { button, element } from '../ui'
import { showNotice } from '../undo'
import { aiSettingsHash, requireBookAi } from './access'
import { analyzeStory, ignoreStoryConflict, storyFeature } from './story-analysis'
import type { StoryAnalysis, StoryConflict } from './story-analysis'
import { openStoryTarget } from './story-jump'
import { readStoryManuscript, sourceId, sourceLabel, storySources } from './story-manuscript'
import type { LiveStoryChapter, StoryManuscriptChapter, StorySource } from './story-manuscript'
import './story-analysis.css'

type Scope = 'selection' | 'chapter' | 'chapters' | 'book'
type Manuscript = Awaited<ReturnType<typeof readStoryManuscript>>
type AnalysisResult = Awaited<ReturnType<typeof analyzeStory>>
type ChapterOption = { id: string; title: string; number: number }

type Actions =
  | { mode: 'extract'; board: () => StoryScene; origin: () => Point; apply: (scene: StoryScene, changed: string[]) => Promise<boolean> }
  | { mode: 'check'; jump: (source: StorySource, conflict: StoryConflict, profileName: string, fix: boolean) => Promise<void>; card: (source: StorySource, conflict: StoryConflict) => Promise<void> }

type Options = Actions & {
  work: StoryWork
  current?: { editionId: string; chapterId: string }
  live?: LiveStoryChapter
  scope: Scope
  signal: AbortSignal
}

const small = 'button button-small button-quiet'
const primary = 'button button-primary'

function warnings(result: AnalysisResult) {
  return [
    result.error,
    result.errorDetail,
    result.stopped ? t('storyAi.stopped') : undefined,
    result.unreadable ? t('storyAi.unreadable', [result.unreadable]) : undefined,
    result.contextOmitted ? t('storyAi.contextOmitted') : undefined,
  ].flatMap((note) => note ? [element('p', 'dialog-help story-ai-warning', note)] : [])
}

/** Opens a local scope picker. The model is contacted only from its Run button. */
export function openStoryAnalysis(options: Options) {
  if (document.querySelector('dialog[data-story-analysis][open]')) return
  const dialog = element('dialog', 'manage-dialog story-ai-dialog')
  dialog.dataset.storyAnalysis = options.mode
  const body = element('div', 'manage-form')
  const title = element('h2', '', t(`storyAi.${options.mode}`))
  title.id = `story-analysis-${crypto.randomUUID()}`
  dialog.setAttribute('aria-labelledby', title.id)
  const area = element('div', 'story-ai-scope')
  const close = button(t('common.cancel'), small)
  const runButton = button(t('storyAi.run'), primary)
  runButton.disabled = true
  const error = element('p', 'field-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  const controls = element('div', 'dialog-controls')
  controls.append(close, runButton)
  body.append(title, area, error, controls)
  dialog.append(body)
  document.body.append(dialog)
  dialog.showModal()

  const lifetime = new AbortController()
  const signal = AbortSignal.any([lifetime.signal, options.signal])
  options.signal.addEventListener('abort', () => dialog.close(), { once: true, signal: lifetime.signal })
  dialog.addEventListener('close', () => { lifetime.abort(); dialog.remove() }, { once: true })
  close.onclick = () => dialog.close()
  const report = (cause: unknown) => { error.textContent = storageError(cause); error.hidden = false }
  const version = element('select', 'title-input')
  const scopeList = element('fieldset', 'story-ai-scope-options')
  scopeList.append(element('legend', '', t('storyAi.scope')))
  const chaptersField = element('div', 'story-ai-chapters')
  const loadStatus = element('p', 'dialog-help')
  loadStatus.setAttribute('role', 'status')
  area.append(storyLabel(t('storyAi.version'), version), scopeList, chaptersField, loadStatus)

  let sources: StorySource[] = []
  let scope = options.scope
  let chapterId = ''
  let chapterOptions: ChapterOption[] = []
  let loading = false
  let working = false
  let preview: Manuscript | undefined
  let load: AbortController | undefined
  const picked = new Set<string>()
  const scopes = [ ...(options.mode === 'check' ? ['selection'] : []), 'chapter', ...(options.mode === 'extract' ? ['chapters'] : []), 'book'] as Scope[]
  const radios = new Map(scopes.map((kind) => {
    const radio = element('input')
    radio.type = 'radio'
    radio.name = title.id
    radio.value = kind
    radio.onchange = () => { scope = kind; paint() }
    const label = element('label', 'story-ai-check')
    label.append(radio, element('span', '', t(`storyAi.scope.${kind}`)))
    scopeList.append(label)
    return [kind, radio] as const
  }))

  function paint() {
    const selected = sources[version.selectedIndex]
    const allowSelection = options.live?.selection && selected?.kind === 'edition' && selected.edition.id === options.live.editionId
    if (scope === 'selection' && !allowSelection) scope = 'chapter'
    for (const [kind, radio] of radios) {
      radio.checked = kind === scope
      radio.disabled = working || !selected || (kind === 'selection' && !allowSelection)
    }
    version.disabled = working || !sources.length
    chaptersField.replaceChildren()
    if (scope === 'chapter' && chapterOptions.length) {
      const select = element('select', 'title-input')
      select.disabled = working
      for (const chapter of chapterOptions) select.add(new Option(t('story.chapterOption', [chapter.number, chapter.title]), chapter.id))
      select.value = chapterId
      select.onchange = () => { chapterId = select.value }
      chaptersField.append(storyLabel(t('storyAi.chapter'), select))
    } else if (scope === 'chapters' && chapterOptions.length) {
      const list = element('div', 'story-ai-chapter-list')
      list.setAttribute('role', 'group')
      list.setAttribute('aria-label', t('storyAi.chapter'))
      for (const chapter of chapterOptions) {
        const check = element('input')
        check.type = 'checkbox'
        check.checked = picked.has(chapter.id)
        check.disabled = working
        check.onchange = () => {
          if (check.checked) picked.add(chapter.id)
          else picked.delete(chapter.id)
          runButton.disabled = !picked.size
        }
        const label = element('label', 'story-ai-check')
        label.append(check, element('span', '', t('story.chapterOption', [chapter.number, chapter.title])))
        list.append(label)
      }
      chaptersField.append(list)
    }
    runButton.disabled = working || loading || !selected || !chapterOptions.length || (scope === 'chapters' && !picked.size)
  }

  async function switchSource() {
    load?.abort()
    load = new AbortController()
    const reading = AbortSignal.any([signal, load.signal])
    const source = sources[version.selectedIndex]
    preview = undefined
    chapterOptions = []
    picked.clear()
    loading = false
    error.hidden = true
    loadStatus.textContent = ''
    if (!source) {
      loadStatus.textContent = t('storyAi.noSource')
      paint()
      return
    }
    if (source.kind === 'edition') {
      chapterOptions = source.edition.chapters.map(({ id, title }, index) => ({ id, title, number: index + 1 }))
    } else {
      loading = true
      loadStatus.textContent = t('storyAi.reading')
      paint()
      try {
        const data = await readStoryManuscript(options.work, source, reading)
        if (reading.aborted) return
        preview = data
        chapterOptions = data.chapters
        loadStatus.textContent = options.mode === 'check' ? t('storyAi.originalStates') : ''
        if (data.notes.length) loadStatus.textContent = [loadStatus.textContent, ...data.notes].filter(Boolean).join(' ')
      } catch (cause) {
        if (!reading.aborted) { report(cause); loadStatus.textContent = '' }
      }
      if (reading.aborted) return
      loading = false
    }
    const current = options.current
    chapterId = source.kind === 'edition' && current?.editionId === source.edition.id && chapterOptions.some(({ id }) => id === current.chapterId)
      ? current.chapterId : chapterOptions[0]?.id ?? ''
    if (chapterId) picked.add(chapterId)
    paint()
  }

  version.onchange = () => { void switchSource() }
  loadStatus.textContent = t('storyAi.reading')
  void storySources(options.work).then((available) => {
    if (signal.aborted) return
    sources = available
    version.replaceChildren(...sources.map((source) => new Option(sourceLabel(source), sourceId(source))))
    const current = sources.findIndex((source) => source.kind === 'edition' && source.edition.id === options.current?.editionId)
    if (current >= 0) version.selectedIndex = current
    void switchSource()
  }, (cause) => { if (!signal.aborted) { report(cause); loadStatus.textContent = '' } })

  runButton.onclick = async () => {
    const selected = sources[version.selectedIndex]
    if (!selected || working) return
    working = true
    error.hidden = true
    paint()
    const selectedScope = scope
    const chosen = selectedScope === 'chapters' ? new Set(picked)
      : new Set([selectedScope === 'selection' ? options.live?.chapterId : chapterId])
    try {
      const profile = await requireBookAi(storyFeature(options.mode), () => {
        void openStoryTarget(aiSettingsHash).catch((cause) => showNotice(storageError(cause)))
      })
      if (!profile || signal.aborted) return
      const operation = new AbortController()
      const requestSignal = AbortSignal.any([signal, operation.signal])
      const status = element('p', 'story-ai-progress-text', t('storyAi.reading'))
      status.setAttribute('role', 'status')
      const progress = element('progress', 'story-ai-progress')
      progress.setAttribute('aria-label', t('storyAi.progressLabel'))
      const stop = button(t('storyAi.stop'), small)
      const stopNow = () => {
        stop.disabled = true
        status.textContent = t('storyAi.stopping')
        operation.abort()
      }
      const interceptCancel = (event: Event) => { event.preventDefault(); stopNow() }
      stop.onclick = stopNow
      dialog.addEventListener('cancel', interceptCancel)
      area.replaceChildren(element('p', 'dialog-help', sourceLabel(selected)), progress, status)
      controls.replaceChildren(stop)
      stop.focus()
      try {
        const manuscript = preview
          ? { ...preview, scene: (await readStorySettings(options.work)).board.scene }
          : await readStoryManuscript(options.work, selected, requestSignal, options.live)
        requestSignal.throwIfAborted()
        const chapters = selectedScope === 'book' ? manuscript.chapters : manuscript.chapters.filter(({ id }) => chosen.has(id))
        if (!chapters.length) throw new Error(t('storyAi.noChapters'))
        progress.max = chapters.length
        progress.value = 0
        const result = await analyzeStory({
          mode: options.mode, work: options.work, source: selected, manuscript, chapters, profile, signal: requestSignal,
          selection: selectedScope === 'selection' ? options.live?.selection : undefined,
          progress(done, name, part) {
            if (requestSignal.aborted) return
            progress.value = done
            status.textContent = part ? t('storyAi.progressPart', [done + 1, chapters.length, name, part])
              : t('storyAi.progress', [done, chapters.length])
          },
        })
        if (signal.aborted) return
        if (options.mode === 'extract') renderExtraction(options, { dialog, area, controls, error, report }, selected, manuscript, result)
        else {
          dialog.close()
          const { jump, card } = options
          showConflicts({ jump, card }, selected, profile.config.name, result)
        }
      } catch (cause) {
        if (signal.aborted) return
        area.replaceChildren(element('p', 'dialog-help', sourceLabel(selected)))
        controls.replaceChildren(close)
        close.textContent = t('common.close')
        report(requestSignal.aborted ? new Error(t('storyAi.stopped')) : cause)
      } finally {
        dialog.removeEventListener('cancel', interceptCancel)
      }
    } catch (cause) {
      if (!signal.aborted) report(cause)
    } finally {
      working = false
      if (area.contains(scopeList)) paint()
    }
  }
}

function textArea(value: string, rows = 2) {
  const control = element('textarea', 'title-input story-ai-textarea')
  control.rows = rows
  control.value = value
  return control
}

function editedLines(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.some((line) => line.length > 255 || /[\x00-\x1f]/.test(line))) throw new Error(t('storyAi.invalidLine'))
  return lines
}

function editFields(fields: ExtractionProposal['fields']) {
  const group = element('div', 'story-ai-fields')
  const rows = element('div', 'story-ai-field-rows')
  const entries = new Map<HTMLElement, { key: HTMLInputElement; value: HTMLTextAreaElement }>()
  function add(key = '', value = '') {
    const row = element('div', 'story-ai-field')
    const keyInput = storyInput(key)
    keyInput.maxLength = 255
    const valueInput = textArea(value)
    const remove = button(t('storyAi.removeField'), small)
    remove.onclick = () => { entries.delete(row); row.remove() }
    row.append(storyLabel(t('storyAi.fieldName'), keyInput), storyLabel(t('storyAi.fieldValue'), valueInput), remove)
    entries.set(row, { key: keyInput, value: valueInput })
    rows.append(row)
  }
  for (const field of fields) add(field.key, field.value)
  const more = button(t('storyAi.addField'), small)
  more.onclick = () => { add(); Array.from(entries.values()).at(-1)?.key.focus() }
  group.append(rows, more)
  return {
    group,
    read: () => [...entries.values()].flatMap(({ key, value }) => {
      if (!key.value.trim() && !value.value.trim()) return []
      const [name] = editedLines(key.value)
      if (!name || !value.value.trim()) throw new Error(t('storyAi.invalidField'))
      return [{ key: name, value: value.value.trim() }]
    }),
  }
}

function proposalRow(proposal: ExtractionProposal, cards: ReturnType<typeof storyCards>, chapters: StoryManuscriptChapter[], changed: () => void) {
  const article = element('article', 'story-ai-proposal')
  const check = element('input')
  check.type = 'checkbox'
  check.checked = proposal.picked
  check.onchange = () => { proposal.picked = check.checked; changed() }
  const heading = element('span', '', proposal.name)
  const label = element('label', 'story-ai-check story-ai-proposal-name')
  label.append(check, heading)
  const match = element('div', 'story-ai-match')
  const destination = element('select', 'title-input')
  destination.onchange = () => { proposal.target = destination.value || null }
  const name = storyInput(proposal.name)
  name.maxLength = 255
  const aliases = textArea(proposal.aliases.join('\n'))
  const tags = textArea(proposal.tags.join('\n'))
  const body = textArea(proposal.body, 3)
  const links = storyInput(proposal.chapters.join(', '))
  const linked = element('p', 'dialog-help')
  const fields = editFields(proposal.fields)
  const details = element('details', 'story-ai-proposal-edit')
  details.append(element('summary', '', t('storyAi.editProposal')))
  if (!proposal.cardId) details.append(storyLabel(t('story.name'), name))
  details.append(storyLabel(t('story.aliases'), aliases))
  if (!proposal.cardId) details.append(storyLabel(t('story.tags'), tags))
  details.append(fields.group)
  if (!proposal.cardId) details.append(storyLabel(t('story.body'), body), storyLabel(t('storyAi.appears'), links))
  article.append(label, match, linked, details)
  const chapterNumbers = () => links.value.trim().split(/[、,，\s]+/).filter(Boolean).map(Number)
  function paintLinks() {
    const selected = new Set(chapterNumbers())
    linked.textContent = chapters.filter(({ number }) => selected.has(number)).map(({ number, title }) => t('story.chapterOption', [number, title])).join(' · ')
    linked.hidden = !linked.textContent
  }
  function paintMatches() {
    if (proposal.cardId) { match.textContent = t('storyAi.supplement'); return }
    const matches = extractionMatches({ name: name.value, aliases: aliases.value.split(/\r?\n/) }, cards)
    if (proposal.target && !matches.some(({ id }) => id === proposal.target)) proposal.target = undefined
    match.hidden = !matches.length
    if (!matches.length) return
    destination.replaceChildren(...matches.map((card) => new Option(t('storyAi.mergeInto', [card.name]), card.id)), new Option(t('storyAi.createSeparate'), ''))
    destination.value = proposal.target === undefined ? matches[0].id : proposal.target ?? ''
    match.replaceChildren(storyLabel(t('storyAi.possibleDuplicate'), destination), element('p', 'dialog-help', t('storyAi.mergePolicy')))
  }
  name.oninput = () => { heading.textContent = name.value; paintMatches() }
  aliases.oninput = paintMatches
  links.oninput = paintLinks
  paintMatches()
  paintLinks()
  return {
    article,
    select(picked: boolean) { proposal.picked = check.checked = picked },
    read(): ExtractionProposal {
      const [title] = editedLines(name.value)
      const numbers = chapterNumbers()
      if (!title) throw new Error(t('story.problem.cardName'))
      if (!numbers.every((number) => Number.isInteger(number) && chapters.some((chapter) => chapter.number === number))) {
        throw new Error(t('storyAi.invalidChapters'))
      }
      return {
        ...proposal, name: title, aliases: uniqueAliases(title, editedLines(aliases.value)),
        tags: editedLines(tags.value), fields: fields.read(), body: body.value, chapters: numbers,
      }
    },
  }
}

function renderExtraction(
  options: Extract<Actions, { mode: 'extract' }>,
  view: { dialog: HTMLDialogElement; area: HTMLElement; controls: HTMLElement; error: HTMLElement; report: (error: unknown) => void },
  source: StorySource, manuscript: Manuscript, result: AnalysisResult,
) {
  const { dialog, area, controls, error, report } = view
  const cards = storyCards(options.board())
  const proposals = extractionProposals(options.board(), result.cards, result.additions)
  const rows = proposals.map((item) => proposalRow(item, cards, manuscript.chapters, paint))
  const list = element('div', 'story-ai-list')
  const count = element('p', 'dialog-help')
  count.setAttribute('role', 'status')
  const selectAll = button(t('storyAi.selectAll'), small)
  const selectNone = button(t('storyAi.selectNone'), small)
  const bar = element('div', 'story-ai-actions')
  bar.append(selectAll, selectNone)
  const close = button(t('common.close'), small)
  const apply = button(t('storyAi.apply'), primary)
  close.onclick = () => dialog.close()
  selectAll.onclick = () => { for (const row of rows) row.select(true); paint() }
  selectNone.onclick = () => { for (const row of rows) row.select(false); paint() }
  function paint() {
    const selected = proposals.filter(({ picked }) => picked).length
    apply.disabled = !selected
    count.textContent = t('storyAi.proposalCount', [selected, proposals.length])
  }

  area.replaceChildren(element('p', 'dialog-help', sourceLabel(source)), ...warnings(result))
  controls.replaceChildren(close)
  if (!proposals.length) {
    if (!result.error && !result.stopped && !result.unreadable && !result.contextOmitted) area.append(element('p', '', t('storyAi.noProposals')))
    close.focus()
    return
  }
  if (source.kind === 'original') area.append(element('p', 'dialog-help', t('storyAi.originalLinks')))
  list.append(...rows.map(({ article }) => article))
  area.append(count, bar, list)
  controls.append(apply)
  paint()
  selectAll.focus()
  let saving = false
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault() })
  apply.onclick = async () => {
    if (saving) return
    saving = apply.disabled = close.disabled = true
    error.hidden = true
    try {
      const chosen = rows.flatMap((row, index) => proposals[index].picked ? [row.read()] : [])
      const next = applyExtraction(options.board(), chosen, source, manuscript.chapters, options.origin())
      if (next.changed.length && !await options.apply(next.scene, next.changed)) throw new Error(t('story.conflict'))
      showNotice(next.changed.length ? t('storyAi.applied', [next.changed.length]) : t('storyAi.noChanges'))
      dialog.close()
    } catch (cause) {
      report(cause)
    } finally {
      saving = close.disabled = false
      paint()
    }
  }
}

function showConflicts(options: Pick<Extract<Actions, { mode: 'check' }>, 'jump' | 'card'>, source: StorySource, profileName: string, result: AnalysisResult) {
  document.querySelector('[data-story-check-results]')?.remove()
  const panel = element('section', 'story-ai-results')
  panel.dataset.storyCheckResults = ''
  panel.setAttribute('role', 'region')
  panel.setAttribute('aria-label', t('storyAi.results'))
  const header = element('div', 'story-ai-results-head')
  const toggle = button(t('storyAi.collapse'), small)
  const close = button(t('common.close'), small)
  close.onclick = () => panel.remove()
  const title = element('h2', '', t('storyAi.results'))
  header.append(title, toggle, close)
  const content = element('div', 'story-ai-results-content')
  const list = element('div', 'story-ai-list')
  const status = element('p', 'dialog-help')
  status.setAttribute('role', 'status')
  const count = () => {
    const size = list.childElementCount
    title.textContent = t('storyAi.resultsCount', [size])
    status.textContent = size ? '' : warnings(result).length ? t('storyAi.noReadableConflicts') : t('storyAi.noConflicts')
  }
  function expanded(open: boolean) {
    content.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    toggle.textContent = t(open ? 'storyAi.collapse' : 'storyAi.expand')
  }
  toggle.onclick = () => expanded(content.hidden)
  content.append(element('p', 'dialog-help', sourceLabel(source)), ...warnings(result), status, list)
  if (source.kind === 'original') content.append(element('p', 'dialog-help', t('storyAi.readOnly')))
  for (const conflict of result.conflicts) {
    const item = element('article', 'story-ai-conflict')
    item.append(element('h3', '', t('story.chapterOption', [conflict.chapter.number, conflict.chapter.title])))
    const follow = async (action: () => Promise<void>) => {
      try { await action(); expanded(false) } catch (cause) { showNotice(storageError(cause)) }
    }
    const quote = button(conflict.anchor.quote, 'story-ai-result-link')
    quote.title = t('storyAi.viewText')
    quote.onclick = () => { void follow(() => options.jump(source, conflict, profileName, false)) }
    const field = conflict.field === '@body' ? t('story.body') : conflict.field === '@state' ? t('storyAi.activeState') : conflict.field
    const card = button(t('storyAi.conflictingField', [conflict.cardName, field]), 'story-ai-result-link')
    card.onclick = () => { void follow(() => options.card(source, conflict)) }
    const controls = element('div', 'story-ai-actions')
    const fixText = button(t('storyAi.fixText'), small)
    fixText.onclick = () => { void follow(() => options.jump(source, conflict, profileName, true)) }
    const fixCard = button(t('storyAi.fixCard'), small)
    fixCard.onclick = () => { void follow(() => options.card(source, conflict)) }
    const ignore = button(t('storyAi.ignore'), small)
    ignore.onclick = () => {
      ignore.disabled = true
      void ignoreStoryConflict(conflict).then(() => { item.remove(); count(); toggle.focus() }, (cause) => {
        ignore.disabled = false
        showNotice(storageError(cause))
      })
    }
    controls.append(...(source.kind === 'edition' ? [fixText] : []), fixCard, ignore)
    item.append(quote, card, element('p', 'story-ai-fact', conflict.value), element('p', '', conflict.reason), controls)
    list.append(item)
  }
  count()
  expanded(true)
  panel.append(header, content)
  document.body.append(panel)
  toggle.focus()
}
