import { locale, t } from '../i18n'
import { fixedPage } from '../shell/fixed-page'
import { menuButton } from '../shell/popover'
import { button, element, icon, notice } from '../ui'
import { storageError } from '../library'
import { restoreTrash } from '../trash'
import { offerUndo } from '../undo'
import { watchStoryChanges } from './changes'
import { storyCardEditor } from './card-editor'
import { blankStoryCard, matchesStoryCard, storyCategories, storyFields } from './model'
import type { StoryCard, StoryCategory } from './model'
import { parseStoryRoute } from './route'
import { readStorySettings } from './store'
import './window.css'

const main = element('main', 'story-window')
document.body.replaceChildren(main)
document.title = t('story.title')
const work = parseStoryRoute(location.hash)
if (work) mount(work)
else main.append(notice(t('story.workUnavailable'), true))

function mount(scope: NonNullable<typeof work>) {
  const signal = new AbortController().signal
  fixedPage(main, signal)
  const header = element('header', 'story-header')
  const headerIcon = element('span', 'story-header-icon')
  headerIcon.append(icon('cards'))
  const titles = element('div', 'story-header-titles')
  const heading = element('h1', '', t('story.title'))
  const workTitle = element('p')
  titles.append(heading, workTitle)
  header.append(headerIcon, titles)
  const message = element('div', 'story-window-message')
  message.setAttribute('aria-live', 'polite')

  const layout = element('div', 'story-layout')
  const filters = element('aside', 'story-filters')
  const search = element('input', 'title-input story-search')
  search.type = 'search'
  search.placeholder = t('story.search')
  search.setAttribute('aria-label', t('story.search'))
  const nav = element('nav', 'story-nav')
  nav.setAttribute('aria-label', t('story.categoryLabel'))

  const list = element('section', 'story-list')
  const listHeader = element('div', 'story-list-header')
  const listTitle = element('h2')
  listTitle.id = 'story-list-heading'
  list.setAttribute('aria-labelledby', listTitle.id)
  const add = button(t('story.newCard'), 'button button-small button-primary', 'plus')
  listHeader.append(listTitle, add)
  const entries = element('div', 'story-entries')
  list.append(listHeader, entries)

  const panel = element('aside', 'story-panel')
  panel.hidden = true
  layout.append(filters, list, panel)
  main.append(header, message, layout)
  filters.append(search, nav)

  type Filter = StoryCategory | 'all' | 'trash'
  type Snapshot = Awaited<ReturnType<typeof readStorySettings>>
  let filter: Filter = 'all'
  let snapshot: Snapshot | undefined
  let editor: ReturnType<typeof storyCardEditor> | undefined
  let turn = 0
  const categoryLabel = (category: StoryCategory) => t(`story.category.${category}`)
  const labels = { all: t('story.all'), trash: t('trash.title') }
  const filterLabel = (id: Filter) => id === 'all' || id === 'trash' ? labels[id] : categoryLabel(id)
  const tabs = (['all', ...storyCategories, 'trash'] as const).map((id) => {
    const node = button(filterLabel(id), 'story-filter')
    const count = element('span', 'story-filter-count')
    count.setAttribute('aria-hidden', 'true')
    node.append(count)
    node.onclick = () => {
      if (id === 'trash' && !leaveEditor()) return
      filter = id
      paintList()
    }
    nav.append(node)
    return { id, node, count }
  })

  function leaveEditor(focus = false) {
    if (editor?.hasDraft()) {
      editor.askToFinish()
      return false
    }
    const selected = editor?.record()?.id
    editor = undefined
    panel.replaceChildren()
    panel.hidden = true
    paintList()
    if (focus) {
      const card = selected && [...entries.querySelectorAll<HTMLButtonElement>('.story-card')].find((node) => node.dataset.id === selected)
      ;(card || add).focus()
    }
    return true
  }

  function showEditor(category: StoryCategory, record?: StoryCard, template = false, focus = true) {
    if (!snapshot?.book) return
    if (focus && editor?.hasDraft()) {
      editor.askToFinish()
      return
    }
    const wasOpen = Boolean(editor)
    const scroll = editor?.body.scrollTop ?? 0
    const input = record ?? blankStoryCard(category)
    if (template) {
      input.name = t(`story.template.${category}.name`)
      input.aliases = [t(`story.template.${category}.alias`)]
      input.fields[storyFields[category][0]] = t(`story.template.${category}.field`)
      input.summary = t(`story.template.${category}.summary`)
      input.details = t(`story.template.${category}.details`)
    }
    editor = storyCardEditor({
      host: main, work: scope, input, record,
      onClose: () => leaveEditor(true),
      onSaved: () => {
        const saved = editor?.record()
        if (saved && filter !== 'all' && filter !== 'trash') filter = saved.category
        if (saved && !matchesStoryCard(saved, search.value)) search.value = ''
        void refresh()
      },
      onDeleted: (entry) => { leaveEditor(true); offerUndo(entry); void refresh() },
    })
    panel.replaceChildren(editor.form)
    panel.hidden = false
    if (!wasOpen) editor.form.classList.add('story-panel-enter')
    editor.refresh(snapshot.editions, snapshot.cards, true)
    if (focus) {
      paintList()
      editor.focus()
    } else editor.body.scrollTop = scroll
  }

  function paintList() {
    const cards = snapshot?.cards ?? []
    const trash = snapshot?.trash ?? []
    const counts = new Map<StoryCategory, number>()
    for (const card of cards) counts.set(card.category, (counts.get(card.category) ?? 0) + 1)
    for (const { id, node, count } of tabs) {
      node.setAttribute('aria-pressed', String(id === filter))
      count.textContent = String(id === 'all' ? cards.length : id === 'trash' ? trash.length : counts.get(id) ?? 0)
      node.disabled = !snapshot?.book
    }
    search.disabled = !snapshot?.book
    add.hidden = !snapshot?.book || filter === 'trash'
    listTitle.textContent = filterLabel(filter)
    if (!snapshot?.book) {
      entries.replaceChildren(notice(t(snapshot ? 'story.workUnavailable' : 'story.loading')))
      return
    }
    const grid = element('ul', 'story-cards')
    const selected = editor?.record()?.id
    if (filter === 'trash') {
      for (const entry of trash) {
        const card = entry.storyCards?.[0]
        if (!card || !matchesStoryCard(card, search.value)) continue
        const item = element('li', 'story-trash-card')
        const text = element('div')
        text.append(element('strong', '', card.name), element('p', 'story-card-category', categoryLabel(card.category)))
        const restore = button(t('trash.restore'), 'button button-small', 'undo')
        restore.onclick = async () => {
          restore.disabled = true
          try { await restoreTrash(entry.id) } catch (error) {
            message.replaceChildren(notice(storageError(error), true))
            restore.disabled = false
          }
        }
        item.append(text, restore)
        grid.append(item)
      }
    } else {
      for (const card of cards) {
        if ((filter !== 'all' && card.category !== filter) || !matchesStoryCard(card, search.value)) continue
        const item = element('li')
        const open = button('', 'story-card')
        open.dataset.id = card.id
        open.setAttribute('aria-label', card.name)
        open.setAttribute('aria-pressed', String(selected === card.id))
        open.append(element('span', 'story-card-category', categoryLabel(card.category)), element('strong', '', card.name))
        if (card.aliases.length) open.append(element('span', 'story-card-aliases', card.aliases.join(t('story.nameSeparator'))))
        const preview = card.summary || card.details
        if (preview) open.append(element('span', 'story-card-preview', preview))
        open.onclick = () => showEditor(card.category, card)
        item.append(open)
        grid.append(item)
      }
    }
    if (grid.childElementCount) {
      const focused = document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.id : undefined
      entries.replaceChildren(grid)
      if (focused) [...grid.querySelectorAll<HTMLButtonElement>('.story-card')].find((node) => node.dataset.id === focused)?.focus({ preventScroll: true })
      return
    }
    const empty = element('div', 'story-empty')
    const symbol = element('div', 'story-empty-icon')
    symbol.append(icon(filter === 'trash' ? 'trash' : search.value.trim() ? 'search' : 'cards'))
    const fromTemplate = !cards.length && filter !== 'trash' && !search.value.trim()
    empty.append(symbol, element('p', '', t(search.value.trim() ? 'story.noMatch' : filter === 'trash' ? 'trash.theTrashIsEmpty' : fromTemplate ? 'story.empty' : 'story.emptyCategory')))
    if (fromTemplate) {
      const template = button(t('story.fromTemplate'), 'button button-small', 'chevron')
      menuButton(template, t('story.fromTemplate'), () => storyCategories.map((category) => ({
        label: categoryLabel(category), action: () => { filter = 'all'; showEditor(category, undefined, true) },
      })))
      empty.append(template)
    }
    entries.replaceChildren(empty)
  }

  async function refresh() {
    const request = ++turn
    try {
      const next = await readStorySettings(scope)
      if (request !== turn) return
      snapshot = next
      next.cards.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, locale))
      workTitle.textContent = next.book?.title ?? ''
      document.title = next.book ? t('story.windowTitle', [next.book.title]) : t('story.title')
      message.replaceChildren()
      const opened = editor?.record()
      const latest = next.cards.find((card) => card.id === opened?.id)
      if (opened && !editor?.hasDraft()) {
        if (!latest || !next.book) leaveEditor()
        else if (latest.revision !== opened.revision) showEditor(latest.category, latest, false, false)
      }
      editor?.refresh(next.editions, next.cards, Boolean(next.book))
      paintList()
    } catch (error) {
      if (request === turn) message.replaceChildren(notice(storageError(error), true))
    }
  }

  add.onclick = () => showEditor(filter === 'all' || filter === 'trash' ? 'character' : filter)
  search.oninput = paintList
  window.addEventListener('beforeunload', (event) => {
    if (!editor?.hasDraft()) return
    editor.askToFinish()
    event.preventDefault()
    event.returnValue = true
  })
  window.addEventListener('focus', () => { void refresh() }, { signal })
  watchStoryChanges(scope, () => { void refresh() }, signal)
  paintList()
  void refresh()
}
