import { t } from '../i18n'
import { storageError } from '../library'
import { button, element } from '../ui'
import type { Edition } from '../documents/model'
import { blankStoryCard, maxStoryName, storyChapterKey, storyDirections, storyStrokes, uniqueAliases } from './model'
import type { StoryCardInput, StoryChapter, StoryEdge, StoryGroup, StoryImage, StoryTag, StoryText } from './model'

export function storyLabel<C extends HTMLElement>(name: string, control: C) {
  const label = element('label', 'field-label')
  label.append(element('span', '', name), control)
  return label
}

export function storyInput(value: string, type = 'text') {
  const field = element('input', 'title-input')
  field.type = type
  field.value = value
  return field
}

function textarea(value: string, rows: number) {
  const field = element('textarea', 'title-input story-textarea')
  field.rows = rows
  field.value = value
  return field
}

function optionsList(label: string, values: readonly string[], value: string, prefix: string) {
  const field = element('select', 'title-input')
  field.setAttribute('aria-label', label)
  for (const item of values) field.add(new Option(t(prefix + item), item))
  field.value = value
  return field
}

interface InspectorOptions<T> {
  heading: string
  save: (value: T) => Promise<void>
  close: () => void
  remove?: () => void
}

function inspector<T>(options: InspectorOptions<T>, read: () => T, focus: HTMLElement) {
  const form = element('form', 'story-inspector-form')
  form.setAttribute('aria-label', options.heading)
  const head = element('header', 'story-inspector-head')
  const close = button('', 'button button-small button-quiet story-square', 'close')
  close.setAttribute('aria-label', t('story.closePanel'))
  close.onclick = options.close
  head.append(element('h2', '', options.heading), close)
  const body = element('fieldset', 'story-inspector-body')
  const footer = element('footer', 'story-inspector-foot')
  const status = element('p', 'story-status')
  status.setAttribute('role', 'status')
  const actions = element('div', 'story-inspector-actions')
  const save = button(t('story.save'), 'button button-small button-primary')
  save.type = 'submit'
  if (options.remove) {
    const remove = button(t('story.delete'), 'button button-small button-quiet remove-button', 'trash')
    remove.onclick = options.remove
    actions.append(remove)
  }
  actions.append(save)
  footer.append(status, actions)
  form.append(head, body, footer)
  let dirty = false
  let busy = false

  function changed() { dirty = true; status.textContent = t('story.unsaved') }
  form.addEventListener('input', changed)
  form.addEventListener('change', changed)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (busy) return
    busy = body.disabled = save.disabled = true
    try {
      await options.save(read())
      dirty = false
      status.textContent = t('story.saved')
    } catch (error) {
      status.textContent = storageError(error)
    } finally {
      busy = body.disabled = save.disabled = false
    }
  })
  return {
    form, body, changed, focus: () => focus.focus({ preventScroll: true }),
    editing: () => dirty || busy,
    status: (message: string) => { status.textContent = message },
  }
}

export function cardInspector(options: InspectorOptions<StoryCardInput>, value = blankStoryCard(), template = false, manageTags?: () => void) {
  const name = storyInput(value.name)
  name.required = true
  name.maxLength = maxStoryName
  const aliases = textarea(value.aliases.join('\n'), 2)
  aliases.placeholder = t('story.aliasHint')
  const details = textarea(value.body, 5)
  let tags = [...value.tagIds]
  const tagList = element('div', 'story-tag-choices')
  const fields = element('div', 'story-field-rows')
  const fieldInputs: { key: HTMLInputElement; value: HTMLTextAreaElement }[] = []
  const chapters = element('div', 'story-chapter-rows')
  const states = element('div', 'story-chapter-rows')
  const chapterRows: { field: HTMLSelectElement; text?: HTMLTextAreaElement }[] = []
  let chapterGroups: HTMLOptGroupElement[] = []
  let chapterNames = new Set<string>()

  const panel = inspector(options, () => {
    const linked: StoryCardInput['chapters'] = []
    const history: StoryCardInput['states'] = []
    for (const { field, text } of chapterRows) {
      if (!field.value && text?.value.trim()) throw new Error(t('story.chapterUnavailable'))
      if (!field.value) continue
      const [editionId, chapterId]: [string, string] = JSON.parse(field.value)
      if (text) {
        if (text.value.trim()) history.push({ editionId, chapterId, text: text.value })
      } else linked.push({ editionId, chapterId })
    }
    const clean = name.value.trim()
    return {
      name: clean, aliases: uniqueAliases(clean, aliases.value.split(/\r?\n/)), tagIds: tags,
      body: details.value, chapters: linked, states: history,
      fields: fieldInputs.map((row) => ({ key: row.key.value, value: row.value.value })).filter((row) => row.key || row.value),
    }
  }, name)

  function removeRow<T>(container: HTMLElement, list: T[], item: T, label: string) {
    const remove = button('', 'button button-quiet button-small story-square', 'close')
    remove.setAttribute('aria-label', label)
    remove.onclick = () => {
      list.splice(list.indexOf(item), 1)
      container.remove()
      panel.changed()
    }
    return remove
  }

  function appendField(key = '', value = '') {
    const row = element('div', 'story-field-row')
    const item = { key: storyInput(key), value: textarea(value, 2) }
    fieldInputs.push(item)
    row.append(storyLabel(t('story.fieldKey'), item.key), removeRow(row, fieldInputs, item, t('story.removeField')),
      storyLabel(t('story.fieldValue'), item.value))
    fields.append(row)
    return item.key
  }

  function fillChapters(field: HTMLSelectElement, chosen: string) {
    field.replaceChildren(new Option(t('story.choose'), ''), ...chapterGroups.map((group) => group.cloneNode(true)))
    if (chosen && !chapterNames.has(chosen)) field.add(new Option(t('story.chapterUnavailable'), chosen))
    field.value = chosen
  }

  function appendChapter(parent: HTMLElement, isState: boolean, ref?: StoryChapter, value = '') {
    const row = element('div', 'story-field-row')
    const field = element('select', 'title-input')
    field.setAttribute('aria-label', t(isState ? 'story.fromChapter' : 'story.linkedChapter'))
    fillChapters(field, ref ? storyChapterKey(ref) : '')
    const text = isState ? textarea(value, 2) : undefined
    const item = { field, text }
    chapterRows.push(item)
    row.append(field, removeRow(row, chapterRows, item, t(isState ? 'story.removeState' : 'story.removeChapter')))
    if (text) row.append(storyLabel(t('story.stateText'), text))
    parent.append(row)
    return field
  }

  function addButton(label: string, add: () => HTMLElement) {
    const control = button(t(label), 'button button-small button-quiet', 'plus')
    control.onclick = () => { add().focus(); panel.changed() }
    return control
  }

  const tagSection = element('section', 'story-inspector-section')
  const manage = button(t('story.manageTags'), 'button button-small button-quiet')
  manage.onclick = () => manageTags?.()
  tagSection.append(element('h3', '', t('story.tags')), tagList, manage)
  const fieldSection = element('section', 'story-inspector-section')
  fieldSection.append(element('h3', '', t('story.fields')), fields, addButton('story.addField', () => appendField()))
  for (const field of value.fields) appendField(field.key, field.value)
  const links = element('section', 'story-inspector-section')
  links.append(element('h3', '', t('story.chapters')), chapters, addButton('story.addChapter', () => appendChapter(chapters, false)))
  const stateSection = element('details', 'story-inspector-section')
  stateSection.open = Boolean(value.states.length)
  stateSection.append(element('summary', '', t('story.states')), element('p', 'dialog-help', t('story.statesHelp')), states,
    addButton('story.addState', () => appendChapter(states, true)))
  for (const chapter of value.chapters) appendChapter(chapters, false, chapter)
  for (const state of value.states) appendChapter(states, true, state, state.text)
  if (template) {
    const choose = optionsList(t('story.template'), ['blank', 'character', 'location'], 'blank', 'story.template.')
    choose.onchange = () => {
      const keys = choose.value === 'character' ? ['role', 'motivation', 'appearance'] : choose.value === 'location' ? ['region', 'features'] : []
      for (const key of keys.map((key) => t(`story.field.${key}`))) {
        if (!fieldInputs.some((row) => row.key.value === key)) appendField(key)
      }
    }
    panel.body.append(storyLabel(t('story.template'), choose))
  }
  panel.body.append(storyLabel(t('story.name'), name), storyLabel(t('story.aliases'), aliases), tagSection,
    fieldSection, storyLabel(t('story.body'), details), links, stateSection)
  let chapterSignature = ''
  let tagSignature = ''
  return {
    ...panel,
    refresh(editions: Edition[], available: StoryTag[]) {
      const nextChapters = JSON.stringify(editions.map(({ id, name, chapters }) => [id, name, chapters]))
      if (nextChapters !== chapterSignature) {
        chapterSignature = nextChapters
        chapterNames = new Set()
        chapterGroups = editions.map((edition) => {
          const group = element('optgroup')
          group.label = edition.name
          edition.chapters.forEach((chapter, index) => {
            const id = storyChapterKey({ editionId: edition.id, chapterId: chapter.id })
            chapterNames.add(id)
            group.append(new Option(t('story.chapterOption', [index + 1, chapter.title]), id))
          })
          return group
        })
        for (const { field } of chapterRows) fillChapters(field, field.value)
      }
      const nextTags = JSON.stringify(available)
      if (nextTags !== tagSignature) {
        tagSignature = nextTags
        tags = tags.filter((id) => available.some((item) => item.id === id))
        tagList.replaceChildren(...available.map((tag) => {
          const input = element('input')
          input.type = 'checkbox'
          input.checked = tags.includes(tag.id)
          input.onchange = () => { tags = input.checked ? [...tags, tag.id] : tags.filter((id) => id !== tag.id) }
          const label = storyLabel(tag.name, input)
          label.className = 'story-tag-choice'
          label.style.setProperty('--tag-color', tag.color)
          return label
        }))
      }
    },
  }
}

export function edgeInspector(options: InspectorOptions<StoryEdge>, edge: StoryEdge) {
  const name = storyInput(edge.name)
  const direction = optionsList(t('story.direction'), storyDirections, edge.direction, 'story.direction.')
  const stroke = optionsList(t('story.stroke'), storyStrokes, edge.stroke, 'story.stroke.')
  const color = storyInput(edge.color, 'color')
  const panel = inspector(options, () => ({
    ...edge, name: name.value.trim(), color: color.value,
    direction: direction.value as StoryEdge['direction'], stroke: stroke.value as StoryEdge['stroke'],
  }), name)
  panel.body.append(storyLabel(t('story.relationName'), name), storyLabel(t('story.direction'), direction),
    storyLabel(t('story.stroke'), stroke), storyLabel(t('story.color'), color))
  return panel
}

type SimpleNode = StoryText | StoryGroup | StoryImage
export function objectInspector(options: InspectorOptions<SimpleNode>, node: SimpleNode) {
  const field = node.kind === 'text' ? textarea(node.text, 6) : storyInput(node.name)
  const panel = inspector(options, (): SimpleNode => node.kind === 'text' ? { ...node, text: field.value } : { ...node, name: field.value }, field)
  panel.body.append(storyLabel(t(node.kind === 'text' ? 'story.body' : 'story.name'), field))
  return panel
}
