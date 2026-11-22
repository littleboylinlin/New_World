import { formDialog } from '../dialogs'
import { t } from '../i18n'
import { storageError } from '../library'
import { button, element } from '../ui'
import type { TrashEntry } from '../library'
import type { Edition } from '../documents/model'
import { storyCategories, storyChapterKey, storyFields, storyLimits } from './model'
import type { StoryCard, StoryCardInput, StoryCategory, StoryChapter, StoryField, StoryWork } from './model'
import { deleteStoryCard, saveStoryCard } from './store'

interface Choice {
  value: string
  label: string
}

interface ChoiceGroup {
  label?: string
  options: Choice[]
}

function fillChoices(select: HTMLSelectElement, groups: ChoiceGroup[], value: string, missing: string) {
  const placeholder = element('option', '', t('story.choose'))
  placeholder.value = ''
  select.replaceChildren(placeholder)
  let found = false
  for (const group of groups) {
    const parent = group.label ? element('optgroup') : select
    if (parent instanceof HTMLOptGroupElement) {
      parent.label = group.label!
      select.append(parent)
    }
    for (const { value: key, label } of group.options) {
      const option = element('option', '', label)
      option.value = key
      parent.append(option)
      if (key === value) found = true
    }
  }
  if (value && !found) {
    const removed = element('option', '', missing)
    removed.value = value
    select.append(removed)
  }
  select.value = value
}

function labeled<C extends HTMLElement>(text: string, control: C) {
  const label = element('label', 'field-label', text)
  label.append(control)
  return label
}

function input(value: string, length: number) {
  const field = element('input', 'title-input')
  field.value = value
  field.maxLength = length
  return field
}

function textarea(value: string, length: number, rows: number) {
  const field = element('textarea', 'title-input story-textarea')
  field.value = value
  field.maxLength = length
  field.rows = rows
  return field
}

function section(label: string, help?: string) {
  const node = element('section', 'story-form-section')
  node.append(element('h3', '', t(label)))
  if (help) node.append(element('p', 'dialog-help', t(help)))
  return node
}

interface EditorOptions {
  host: HTMLElement
  work: StoryWork
  input: StoryCardInput
  record?: StoryCard
  onSaved: () => void
  onDeleted: (entry: TrashEntry) => void
  onClose: () => void
}

export function storyCardEditor(options: EditorOptions) {
  let record = options.record
  let dirty = false
  let busy = false
  let stale = false
  let chapterGroups: ChoiceGroup[] = []
  let cardGroups: ChoiceGroup[] = []
  let chaptersSignature = ''
  let cardsSignature = ''

  const form = element('form', 'story-editor')
  form.setAttribute('aria-labelledby', 'story-panel-title')
  const header = element('div', 'story-panel-header')
  const heading = element('h2', '', record?.name ?? t('story.newCard'))
  heading.id = 'story-panel-title'
  const close = button('', 'button button-small button-quiet story-icon-button', 'close')
  close.setAttribute('aria-label', t('story.closePanel'))
  close.title = t('story.closePanel')
  close.onclick = options.onClose
  header.append(heading, close)

  const body = element('fieldset', 'story-panel-body')
  const category = element('select', 'title-input')
  for (const id of storyCategories) {
    const choice = element('option', '', t(`story.category.${id}`))
    choice.value = id
    category.append(choice)
  }
  category.value = options.input.category
  const name = input(options.input.name, storyLimits.name)
  name.required = true
  const aliases = textarea(options.input.aliases.join('\n'), storyLimits.aliases * (storyLimits.name + 1), 2)
  aliases.placeholder = t('story.aliasHint')
  const basic = element('div', 'story-form-basics')
  basic.append(labeled(t('story.name'), name), labeled(t('story.categoryLabel'), category))
  body.append(basic, labeled(t('story.aliases'), aliases))

  const fields = section('story.fields')
  const fieldGrid = element('div', 'story-form-basics')
  fields.append(fieldGrid)
  const commonFields = new Map<StoryField, HTMLInputElement>()
  function paintFields() {
    // Keep filled fields visible when moving a card to another category.
    const visible = new Set<StoryField>(storyFields[category.value as StoryCategory])
    for (const [key, control] of commonFields) if (control.value.trim()) visible.add(key)
    fieldGrid.replaceChildren(...[...visible].map((key) => {
      const control = commonFields.get(key) ?? input(options.input.fields[key] ?? '', storyLimits.field)
      commonFields.set(key, control)
      return labeled(t(`story.field.${key}`), control)
    }))
  }
  for (const [key, value] of Object.entries(options.input.fields)) commonFields.set(key as StoryField, input(value, storyLimits.field))
  category.addEventListener('change', paintFields)
  paintFields()
  const summary = textarea(options.input.summary, storyLimits.summary, 3)
  const details = textarea(options.input.details, storyLimits.details, 5)
  body.append(fields, labeled(t('story.summary'), summary), labeled(t('story.details'), details))

  const links = section('story.chapters')
  const stateList = section('story.states', 'story.statesHelp')
  const relationList = section('story.relations', 'story.relationsHelp')
  const addLink = button(t('story.addChapter'), 'button button-small button-quiet', 'plus')
  const addState = button(t('story.addState'), 'button button-small button-quiet', 'plus')
  const addRelation = button(t('story.addRelation'), 'button button-small button-quiet', 'plus')
  links.append(addLink)
  stateList.append(addState)
  relationList.append(addRelation)

  const chapterRows: { row: HTMLElement; select: HTMLSelectElement; text?: HTMLTextAreaElement }[] = []
  const relationRows: { row: HTMLElement; select: HTMLSelectElement; name: HTMLInputElement }[] = []

  function removeButton<T extends { row: HTMLElement }>(label: string, items: T[], item: T, after: HTMLElement) {
    const remove = button('', 'button button-small button-quiet remove-button story-icon-button', 'close')
    remove.setAttribute('aria-label', label)
    remove.title = label
    remove.onclick = () => {
      items.splice(items.indexOf(item), 1)
      item.row.remove()
      markDirty()
      after.focus()
    }
    return remove
  }

  function addChapterRow(ref: StoryChapter | undefined, isState: boolean, value = '') {
    const row = element('div', 'story-edit-row')
    const select = element('select', 'title-input')
    select.required = true
    select.setAttribute('aria-label', t(isState ? 'story.fromChapter' : 'story.linkedChapter'))
    fillChoices(select, chapterGroups, ref ? storyChapterKey(ref) : '', t('story.chapterUnavailable'))
    const text = isState ? textarea(value, storyLimits.state, 2) : undefined
    const item = { row, select, text }
    chapterRows.push(item)
    const add = isState ? addState : addLink
    row.append(select, removeButton(t(isState ? 'story.removeState' : 'story.removeChapter'), chapterRows, item, add))
    if (text) {
      text.required = true
      row.append(labeled(t('story.stateText'), text))
    }
    add.before(row)
    return select
  }

  function addRelationRow(target = '', value = '') {
    const row = element('div', 'story-edit-row')
    const select = element('select', 'title-input')
    select.required = true
    select.setAttribute('aria-label', t('story.relationTarget'))
    fillChoices(select, cardGroups, target, t('story.cardUnavailable'))
    const name = input(value, storyLimits.name)
    name.required = true
    const item = { row, select, name }
    relationRows.push(item)
    row.append(select, removeButton(t('story.removeRelation'), relationRows, item, addRelation), labeled(t('story.relationName'), name))
    addRelation.before(row)
    return select
  }

  for (const ref of options.input.chapters) addChapterRow(ref, false)
  for (const state of options.input.states) addChapterRow(state, true, state.text)
  for (const relation of options.input.relations) addRelationRow(relation.targetCardId, relation.name)
  addLink.onclick = () => { addChapterRow(undefined, false).focus(); markDirty() }
  addState.onclick = () => { addChapterRow(undefined, true).focus(); markDirty() }
  addRelation.onclick = () => { addRelationRow().focus(); markDirty() }
  body.append(links, stateList, relationList)

  const footer = element('div', 'story-panel-footer')
  const status = element('p', 'story-panel-status')
  status.setAttribute('role', 'status')
  const actions = element('div', 'story-panel-actions')
  const remove = button(t('story.delete'), 'button button-small button-quiet remove-button', 'trash')
  const save = button(t('story.save'), 'button button-small button-primary')
  save.type = 'submit'
  const discard = button(t('story.discard'), 'button button-small button-quiet')
  discard.onclick = () => {
    if (busy) return
    dirty = false
    options.onClose()
  }
  actions.append(remove, discard, save)
  footer.append(status, actions)
  form.append(header, body, footer)

  function buttons() {
    close.disabled = body.disabled = busy
    save.disabled = busy || stale || Boolean(record && !dirty)
    discard.disabled = busy
    discard.hidden = !dirty
    remove.hidden = !record
    remove.disabled = busy || dirty || stale
    addLink.disabled = !chapterGroups.length || chapterRows.filter((row) => !row.text).length >= storyLimits.chapters
    addState.disabled = !chapterGroups.length || chapterRows.filter((row) => row.text).length >= storyLimits.chapters
    addRelation.disabled = !cardGroups[0]?.options.length || relationRows.length >= storyLimits.relations
  }

  function markDirty() {
    dirty = true
    if (!stale) status.textContent = t('story.unsaved')
    buttons()
  }

  function refresh(editions: Edition[], cards: StoryCard[], hasBook: boolean) {
    const chapters = editions.filter((edition) => edition.chapters.length).map((edition) => ({
      label: edition.name,
      options: edition.chapters.map((chapter, index) => ({
        value: storyChapterKey({ editionId: edition.id, chapterId: chapter.id }),
        label: t('story.chapterOption', [index + 1, chapter.title]),
      })),
    }))
    const targets = cards.filter((card) => card.id !== record?.id).map((card) => ({
      value: card.id, label: `${card.name} · ${t(`story.category.${card.category}`)}`,
    }))
    const nextChapters = JSON.stringify(chapters)
    if (nextChapters !== chaptersSignature) {
      chaptersSignature = nextChapters
      chapterGroups = chapters
      for (const { select } of chapterRows) fillChoices(select, chapterGroups, select.value, t('story.chapterUnavailable'))
    }
    const nextCards = JSON.stringify(targets)
    if (nextCards !== cardsSignature) {
      cardsSignature = nextCards
      cardGroups = [{ options: targets }]
      for (const { select } of relationRows) fillChoices(select, cardGroups, select.value, t('story.cardUnavailable'))
    }
    const wasStale = stale
    stale = !hasBook || Boolean(record && !cards.some((card) => card.id === record?.id && card.revision === record.revision))
    if (stale) status.textContent = t(hasBook ? 'story.conflict' : 'story.workUnavailable')
    else if (wasStale) status.textContent = dirty ? t('story.unsaved') : ''
    buttons()
  }

  function collect(): StoryCardInput {
    const chapters: StoryCardInput['chapters'] = []
    const states: StoryCardInput['states'] = []
    for (const { select, text } of chapterRows) {
      const [editionId, chapterId]: [string, string] = JSON.parse(select.value)
      if (text) states.push({ editionId, chapterId, text: text.value })
      else chapters.push({ editionId, chapterId })
    }
    const fields = Object.fromEntries([...commonFields].filter(([, field]) => field.value.trim()).map(([key, field]) => [key, field.value]))
    return {
      category: category.value as StoryCategory, name: name.value, aliases: aliases.value.split(/\r?\n/), fields,
      summary: summary.value, details: details.value, chapters, states,
      relations: relationRows.map((row) => ({ name: row.name.value, targetCardId: row.select.value })),
    }
  }

  form.addEventListener('input', markDirty)
  form.addEventListener('change', markDirty)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (save.disabled) return
    busy = true
    buttons()
    try {
      record = await saveStoryCard(options.work, collect(), record)
      dirty = stale = false
      heading.textContent = record.name
      aliases.value = record.aliases.join('\n')
      status.textContent = t('story.saved')
      options.onSaved()
    } catch (error) {
      status.textContent = storageError(error)
    } finally {
      busy = false
      buttons()
    }
  })
  remove.onclick = () => {
    const card = record
    if (!card || remove.disabled) return
    formDialog(options.host, {
      title: t('story.deleteTitle'), action: t('story.deleteConfirm'), danger: true,
      description: t('story.deleteDescription', [card.name]),
    }, async () => {
      const entry = await deleteStoryCard(card)
      options.onDeleted(entry)
    })
  }

  buttons()
  return {
    form, body, refresh, record: () => record, hasDraft: () => dirty || busy, focus: () => name.focus({ preventScroll: true }),
    askToFinish() { if (!stale) status.textContent = t('story.finishEditing') },
  }
}
