import { changeLanguage, locale, t } from './i18n'
import type { Locale } from '../shared/language-packs.mjs'
import { desktopFeedbackPlatform, feedbackLinks } from '../shared/feedback.mjs'
import { button, element, icon, link } from './ui'
import { mountStorageView } from './storage-view'
import { mountUpdateView } from './update-view'
import { runningVersion } from './updates'
import { mountAppearanceSettings } from './appearance-view'
import { mountAiSettings } from './ai/settings-view'
import { mountProviderSettings } from './ai/provider-settings-view'
import { mountStyleLibrary } from './ai/styles-view'
import { mountBackupView } from './backup-view'
import { mountCaptureSettings } from './idea-capture'
import { readSearchEngine, saveSearchEngine, searchEngines } from './web-search'
import type { SearchEngine } from './web-search'

export type SettingsCategory = 'general' | 'appearance' | 'capture' | 'storage' | 'backup' | 'ai' | 'updates'

interface CategorySpec {
  id: SettingsCategory
  icon: 'general' | 'appearance' | 'idea' | 'storage' | 'backup' | 'ai' | 'updates'
  label: string
  description: string
}

const categories: readonly CategorySpec[] = [
  { id: 'general', icon: 'general', label: t('settings.categoryGeneral'), description: t('settings.categoryGeneralDesc') },
  { id: 'appearance', icon: 'appearance', label: t('settings.categoryAppearance'), description: t('settings.categoryAppearanceDesc') },
  { id: 'capture', icon: 'idea', label: t('settings.categoryCapture'), description: t('settings.categoryCaptureDesc') },
  { id: 'storage', icon: 'storage', label: t('settings.categoryStorage'), description: t('settings.categoryStorageDesc') },
  { id: 'backup', icon: 'backup', label: t('settings.categoryBackup'), description: t('settings.categoryBackupDesc') },
  { id: 'ai', icon: 'ai', label: t('settings.categoryAi'), description: t('settings.categoryAiDesc') },
  { id: 'updates', icon: 'updates', label: t('settings.categoryUpdates'), description: t('settings.categoryUpdatesDesc') },
]

const categoryIds = new Set<string>(categories.map((item) => item.id))
const returnStorageKey = 'new-world:settings-return'

export function parseSettingsCategory(hash: string): SettingsCategory | null {
  const match = /^#\/settings(?:\/([a-z-]+))?\/?$/.exec(hash)
  if (!match) return null
  const candidate = match[1] as SettingsCategory | undefined
  return candidate && categoryIds.has(candidate) ? candidate : 'general'
}

const closeChoices: { value: CloseBehavior; label: string }[] = [
  { value: 'quit', label: t('settings.quit') },
  { value: 'background', label: t('settings.background') },
]

function readStoredReturnHash(): string {
  try {
    const saved = sessionStorage.getItem(returnStorageKey) || ''
    return saved && !parseSettingsCategory(saved) ? saved : '#/'
  } catch {
    return '#/'
  }
}

export function mountSettingsView(
  saveBeforeLeaving: () => Promise<boolean>,
  navigate: (hash: string) => void,
) {
  const desktop = window.newWorldDesktop

  const page = element('section', 'settings-page')
  page.setAttribute('aria-labelledby', 'settings-page-title')

  const sidebar = element('aside', 'settings-sidebar')
  const sidebarTop = element('div', 'settings-sidebar-top')
  const backButton = button('', 'button button-quiet button-small settings-back')
  const backLabel = element('span', 'settings-back-label', t('settings.backToApp'))
  backButton.append(icon('back'), backLabel)
  const pageTitle = element('h1', 'settings-page-title', t('settings.title'))
  pageTitle.id = 'settings-page-title'
  sidebarTop.append(backButton, pageTitle)

  const nav = element('nav', 'settings-nav')
  nav.setAttribute('aria-label', t('settings.navLabel'))
  const navLinks = new Map<SettingsCategory, HTMLAnchorElement>()

  const content = element('div', 'settings-content')
  content.tabIndex = -1
  const fields = element('fieldset', 'settings-fields')
  const panels = new Map<SettingsCategory, HTMLElement>()
  const panelBodies = new Map<SettingsCategory, HTMLElement>()
  const panelHeadings = new Map<SettingsCategory, HTMLHeadingElement>()

  for (const spec of categories) {
    const link = element('a', 'settings-nav-item')
    link.href = `#/settings/${spec.id}`
    link.dataset.category = spec.id
    link.append(icon(spec.icon), element('span', 'settings-nav-label', spec.label))
    nav.append(link)
    navLinks.set(spec.id, link)

    const panel = element('section', 'settings-panel')
    panel.dataset.category = spec.id
    const headingId = `settings-panel-heading-${spec.id}`
    panel.setAttribute('aria-labelledby', headingId)
    panel.hidden = true

    const header = element('header', 'settings-panel-header')
    const heading = element('h2', 'settings-panel-title', spec.label)
    heading.id = headingId
    heading.tabIndex = -1
    const description = element('p', 'settings-panel-desc', spec.description)
    header.append(heading, description)

    const body = element('div', 'settings-panel-body')
    panel.append(header, body)
    fields.append(panel)

    panels.set(spec.id, panel)
    panelBodies.set(spec.id, body)
    panelHeadings.set(spec.id, heading)
  }

  sidebar.append(sidebarTop, nav)
  content.append(fields)
  page.append(sidebar, content)

  function createCard(parent: HTMLElement, headingText?: string, headingId?: string) {
    const card = element('div', 'settings-card')
    if (headingText) {
      const heading = element('h3', 'settings-heading', headingText)
      if (headingId) heading.id = headingId
      card.append(heading)
    }
    parent.append(card)
    return card
  }

  // Category 1: General (Language & Close behavior)
  const generalBody = panelBodies.get('general')!
  const layoutEntry = link('#/settings/appearance', t('settings.appearanceGroupTypography'), 'button button-quiet settings-layout-link')
  generalBody.append(layoutEntry)
  const languageCard = createCard(generalBody, t('settings.language'), 'language-settings-title')
  const languageLabel = element('label', 'field-label')
  const language = element('select', 'editor-select')
  language.setAttribute('aria-labelledby', 'language-settings-title')
  for (const [value, name] of [['zh-CN', '简体中文'], ['en', 'English']]) {
    const option = element('option', '', name)
    option.value = value!
    language.append(option)
  }
  language.value = locale
  languageLabel.append(language)
  const applyLanguage = button(t('settings.languageApply'), 'button button-primary')
  applyLanguage.disabled = true
  const languageActions = element('div', 'settings-actions')
  languageActions.append(applyLanguage)
  const languageState = element('p', 'settings-state language-state')
  languageState.setAttribute('role', 'status')
  const languageError = element('p', 'field-error language-error')
  languageError.setAttribute('role', 'alert')
  languageError.hidden = true
  languageCard.append(languageLabel, languageActions, languageState, languageError)

  const windowCard = createCard(generalBody, t('settings.closeBehavior'), 'window-settings-title')
  const options = element('div', 'settings-options')
  options.setAttribute('role', 'radiogroup')
  options.setAttribute('aria-label', t('settings.closeBehavior'))
  const inputs: HTMLInputElement[] = []
  for (const choice of closeChoices) {
    const item = element('label', 'settings-option')
    const input = element('input')
    input.type = 'radio'
    input.name = 'close-behavior'
    input.value = choice.value
    item.append(input, element('span', '', choice.label))
    options.append(item)
    inputs.push(input)
  }
  const badge = element('span', 'settings-badge', t('settings.browserManaged'))
  const state = element('p', 'settings-state')
  state.setAttribute('role', 'status')
  const error = element('p', 'field-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  windowCard.append(options, badge, state, error)

  // The web pane's address bar searches with this engine (desktop only, where web panes exist).
  if (desktop?.web) {
    const card = createCard(generalBody, t('settings.webSearch'), 'web-search-title')
    const select = element('select', 'editor-select web-search-engine')
    select.setAttribute('aria-labelledby', 'web-search-title')
    for (const [value, engine] of Object.entries(searchEngines)) {
      const option = element('option', '', engine.name)
      option.value = value
      select.append(option)
    }
    select.value = readSearchEngine()
    select.addEventListener('change', () => saveSearchEngine(select.value as SearchEngine))
    const field = element('label', 'field-label')
    field.append(select)
    card.append(field)
  }

  let refreshLogin: (() => Promise<void>) | undefined
  if (desktop?.getLoginItem && desktop.setLoginItem && ['darwin', 'win32'].includes(desktop.platform)) {
    const { getLoginItem, setLoginItem } = desktop
    const card = createCard(generalBody)
    const label = element('label', 'appearance-check')
    const toggle = element('input')
    toggle.type = 'checkbox'
    toggle.setAttribute('role', 'switch')
    toggle.disabled = true
    label.append(toggle, t('settings.loginItem'))
    const status = element('p', 'settings-state')
    status.setAttribute('role', 'status')
    card.append(label, status)
    let request = 0
    let saving = false
    function showLogin(state: LoginItemState) {
      toggle.checked = state !== 'off'
      status.textContent = state === 'approval' ? t('settings.loginApproval') : ''
    }
    refreshLogin = async () => {
      if (saving) return
      const turn = ++request
      try {
        const state = await getLoginItem()
        if (turn === request) { showLogin(state); toggle.disabled = false }
      } catch {
        if (turn === request) status.textContent = t('settings.loginReadError')
      }
    }
    toggle.onchange = async () => {
      request++
      toggle.disabled = saving = true
      try {
        showLogin(await setLoginItem(toggle.checked))
      } catch {
        toggle.checked = !toggle.checked
        status.textContent = t('settings.settingsCouldNotBeSavedTryAgain')
      } finally { toggle.disabled = saving = false }
    }
  }

  // Category 2: Appearance
  mountAppearanceSettings(panelBodies.get('appearance')!)

  // Category 3: Quick Capture
  const captureCard = createCard(panelBodies.get('capture')!, t('ideas.settingsTitle'), 'capture-settings-title')
  const refreshCapture = mountCaptureSettings(captureCard)

  // Category 4: Storage
  const storageCard = createCard(panelBodies.get('storage')!, t('settings.storage'), 'storage-settings-title')
  // Category 5: Backup & Restore
  const backupCard = createCard(panelBodies.get('backup')!, t('backup.title'), 'backup-settings-title')
  // Category 6: AI Integration — services the app calls, which feature uses which, then the v1 local endpoint
  const aiBody = panelBodies.get('ai')!
  const providerCard = createCard(aiBody, t('aiProvider.title'), 'ai-provider-title')
  const routingCard = createCard(aiBody, t('aiProvider.routingTitle'), 'ai-routing-title')
  const styleCard = createCard(aiBody, t('styles.title'), 'ai-styles-title')
  const aiCard = createCard(aiBody, t('ai.settingsTitle'), 'ai-settings-title')
  // Category 7: Updates & About
  const updatesBody = panelBodies.get('updates')!
  const updateCard = createCard(updatesBody, t('settings.updates'), 'update-settings-title')
  const aboutCard = createCard(updatesBody, t('settings.aboutSection'), 'about-settings-title')
  aboutCard.append(
    element('p', 'dialog-help', t('settings.aboutCopy')),
    element('p', 'dialog-help', desktop ? t('settings.aboutEnvironmentDesktop') : t('settings.aboutEnvironmentWeb')),
  )

  const feedback = element('details', 'settings-card settings-feedback')
  const mobileBrowser = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  const platform = desktop
    ? desktopFeedbackPlatform(desktop.platform) ?? t('feedback.platformDesktop')
    : t(mobileBrowser ? 'feedback.platformMobile' : 'feedback.platformWeb')
  const links = feedbackLinks(runningVersion, platform, t)
  const github = link(links.github, t('feedback.github'), 'button button-quiet')
  github.target = '_blank'
  github.rel = 'noopener noreferrer'
  const email = link(links.email, t('feedback.email'), 'button button-quiet')
  if (desktop) email.target = '_blank'
  email.rel = 'noopener noreferrer'
  const feedbackActions = element('div', 'settings-actions')
  feedbackActions.append(github, email)
  feedback.append(element('summary', '', t('feedback.title')), feedbackActions)
  updatesBody.append(feedback)

  let behavior: CloseBehavior = 'quit'
  let busy = false
  let locked = false
  let loaded = false
  let activeCategory: SettingsCategory = 'general'
  let returnHash = readStoredReturnHash()
  let pendingHeadingFocus = false

  function updateBackButtonLabel() {
    backLabel.textContent = (!returnHash || returnHash === '#/')
      ? t('settings.backToApp')
      : t('settings.backPrevious')
  }
  updateBackButtonLabel()

  function setBusy(value: boolean, allowClose = false) {
    busy = fields.disabled = value
    locked = backButton.disabled = value && !allowClose
    for (const link of navLinks.values()) {
      if (locked) link.setAttribute('aria-disabled', 'true')
      else link.removeAttribute('aria-disabled')
    }
    if (locked) layoutEntry.setAttribute('aria-disabled', 'true')
    else layoutEntry.removeAttribute('aria-disabled')
  }

  function recordOrigin(hash: string) {
    if (parseSettingsCategory(hash)) return
    returnHash = hash || '#/'
    try { sessionStorage.setItem(returnStorageKey, returnHash) } catch { /* In-memory return target still works. */ }
    updateBackButtonLabel()
  }

  function refreshAll() {
    if (busy) return
    state.textContent = ''
    void refresh()
    void refreshStorage()
    void refreshBackups()
    void refreshCapture?.()
    void refreshLogin?.()
    void refreshAi()
    void refreshProviders()
    void refreshStyles()
  }

  function showCategory(category: SettingsCategory, fromWithinSettings: boolean, focusHeading = false) {
    const changed = category !== activeCategory
    activeCategory = category
    if (!fromWithinSettings) refreshAll()

    for (const [id, link] of navLinks) {
      if (id === category) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    for (const [id, panel] of panels) {
      const show = id === category
      panel.hidden = !show
      panel.classList.remove('settings-panel-enter')
      if (show && (changed || fromWithinSettings)) {
        void panel.offsetWidth
        panel.classList.add('settings-panel-enter')
      }
    }

    const spec = categories.find((item) => item.id === category)!
    document.title = `${spec.label} · ${t('settings.pageTitle')}`
    content.scrollTop = 0

    if (focusHeading || pendingHeadingFocus) {
      pendingHeadingFocus = false
      panelHeadings.get(category)?.focus({ preventScroll: true })
      return true
    }
    return false
  }

  function openCategory(category: SettingsCategory = 'general') {
    pendingHeadingFocus = true
    const target = `#/settings/${category}`
    if (parseSettingsCategory(location.hash) === category && location.hash === target) {
      showCategory(category, true, true)
      return
    }
    navigate(target)
  }

  const refreshStorage = mountStorageView(storageCard, saveBeforeLeaving, setBusy)
  mountUpdateView(updateCard, saveBeforeLeaving, () => openCategory('updates'), setBusy)
  const refreshBackups = mountBackupView(backupCard, saveBeforeLeaving, setBusy)
  const refreshAi = mountAiSettings(aiCard)
  const refreshProviders = mountProviderSettings(providerCard, routingCard)
  const refreshStyles = mountStyleLibrary(styleCard)

  language.addEventListener('change', () => { applyLanguage.disabled = language.value === locale })
  applyLanguage.addEventListener('click', async () => {
    if (busy || language.value === locale) return
    setBusy(true)
    languageError.hidden = true
    languageState.textContent = t('settings.languageDownloading')
    try {
      if (!await saveBeforeLeaving()) throw new Error(t('settings.languageSaveRequired'))
      await changeLanguage(language.value as Locale)
      try { sessionStorage.setItem(returnStorageKey, returnHash) } catch { /* Language selection is already saved. */ }
      if (desktop?.reloadForLanguage) await desktop.reloadForLanguage()
      else location.reload()
    } catch (cause) {
      languageError.textContent = cause instanceof Error && cause.message === t('settings.languageSaveRequired')
        ? cause.message : t('settings.languageFailed')
      languageError.hidden = false
      languageState.textContent = ''
      language.value = locale
      applyLanguage.disabled = true
      setBusy(false)
    }
  })

  function paint() {
    if (!desktop) {
      options.hidden = true
      badge.hidden = false
      state.textContent = ''
      return
    }
    options.hidden = false
    badge.hidden = true
    for (const input of inputs) {
      input.checked = loaded && input.value === behavior
      input.disabled = !loaded
    }
  }

  async function refresh() {
    if (!desktop) return paint()
    loaded = false
    error.hidden = true
    paint()
    try {
      behavior = await desktop.getCloseBehavior()
      loaded = true
    } catch {
      error.textContent = t('settings.theCloseBehaviorCouldNotBeReadReopen')
      error.hidden = false
    }
    paint()
  }

  async function save(mode: CloseBehavior) {
    if (!desktop || busy || !loaded) return
    setBusy(true)
    error.hidden = true
    state.textContent = ''
    try {
      behavior = await desktop.setCloseBehavior(mode)
      state.textContent = t('editor.saved')
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : t('settings.settingsCouldNotBeSavedTryAgain')
      error.hidden = false
    } finally {
      paint()
      setBusy(false)
    }
  }

  for (const input of inputs) {
    input.addEventListener('change', () => { void save(input.value as CloseBehavior) })
  }

  backButton.addEventListener('click', () => {
    if (locked) return
    navigate(returnHash || '#/')
  })
  layoutEntry.addEventListener('click', (event) => { if (locked) event.preventDefault() })

  nav.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement | null)?.closest('a')
    if (!target) return
    if (locked) {
      event.preventDefault()
    }
  })

  nav.addEventListener('keydown', (event) => {
    const items = [...nav.querySelectorAll<HTMLAnchorElement>('.settings-nav-item')]
    const current = items.indexOf(document.activeElement as HTMLAnchorElement)
    if (current === -1) return
    let next = -1
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (current + 1) % items.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (current - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next === -1) return
    event.preventDefault()
    items[next]?.focus()
  })

  desktop?.onSettingsRequested?.(() => openCategory('general'))
  window.addEventListener('new-world:open-appearance-settings', () => openCategory('appearance'))
  paint()

  return {
    element: page,
    showCategory,
    recordOrigin,
    isLocked: () => locked,
  }
}
