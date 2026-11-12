import { changeLanguage, locale, t } from './i18n'
import type { Locale } from '../shared/language-packs.mjs'
import { button, element } from './ui'
import { mountStorageView } from './storage-view'
import { mountUpdateView } from './update-view'

const choices: { value: CloseBehavior; label: string }[] = [
  { value: 'quit', label: t('settings.quit') },
  { value: 'background', label: t('settings.background') },
]

export function mountSettingsView(saveBeforeLeaving: () => Promise<boolean>) {
  const desktop = window.newWorldDesktop
  const entry = document.querySelector<HTMLButtonElement>('#settings')!

  const title = element('h2', '', t('settings.title'))
  title.id = 'settings-dialog-title'
  const dialog = element('dialog', 'manage-dialog settings-dialog')
  dialog.id = 'settings-dialog'
  dialog.setAttribute('aria-labelledby', title.id)
  const content = element('div', 'manage-form')

  const fields = element('fieldset', 'settings-fields')
  const scroll = element('div', 'settings-scroll')
  const list = element('ul', 'settings-list')
  list.setAttribute('aria-label', t('settings.list'))
  function section(name: string, id: string) {
    const item = element('li')
    const panel = element('section', 'settings-section')
    const heading = element('h3', 'settings-heading', name)
    heading.id = id
    heading.tabIndex = -1
    panel.setAttribute('aria-labelledby', id)
    panel.append(heading)
    item.append(panel)
    list.append(item)
    return panel
  }
  const languageSection = section(t('settings.language'), 'language-settings-title')
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
  languageSection.append(languageLabel, element('p', 'dialog-help', t('settings.languageHint')), languageActions, languageState, languageError)
  const windowSection = section(t('settings.closeBehavior'), 'window-settings-title')
  const storageSection = section(t('settings.storage'), 'storage-settings-title')
  const updateSection = section(t('settings.updates'), 'update-settings-title')
  const options = element('div', 'settings-options')
  options.setAttribute('role', 'radiogroup')
  options.setAttribute('aria-label', t('settings.closeBehavior'))
  const inputs: HTMLInputElement[] = []
  for (const choice of choices) {
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
  const close = button(t('common.close'), 'button button-quiet')
  const controls = element('div', 'dialog-controls')
  controls.append(close)
  windowSection.append(options, badge, state, error)
  fields.append(list)
  scroll.append(fields)
  content.append(title, scroll, controls)
  dialog.append(content)
  document.body.append(dialog)

  let behavior: CloseBehavior = 'quit'
  let busy = false
  let locked = false
  let loaded = false

  function setBusy(value: boolean, allowClose = false) {
    busy = fields.disabled = value
    locked = close.disabled = value && !allowClose
  }

  language.addEventListener('change', () => { applyLanguage.disabled = language.value === locale })
  applyLanguage.addEventListener('click', async () => {
    if (busy || language.value === locale) return
    setBusy(true)
    languageError.hidden = true
    languageState.textContent = t('settings.languageDownloading')
    try {
      if (!await saveBeforeLeaving()) throw new Error(t('settings.languageSaveRequired'))
      await changeLanguage(language.value as Locale)
      try { sessionStorage.setItem('new-world:settings-open', '1') } catch { /* Language selection is already saved. */ }
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

  function open(section?: HTMLElement) {
    if (!busy) {
      state.textContent = ''
      void refresh()
      void refreshStorage()
    }
    if (!dialog.open) dialog.showModal()
    if (section) {
      section.scrollIntoView({ block: 'start' })
      section.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true })
    } else {
      scroll.scrollTop = 0
    }
  }

  const refreshStorage = mountStorageView(storageSection, saveBeforeLeaving, setBusy)
  mountUpdateView(updateSection, saveBeforeLeaving, () => open(updateSection), setBusy)

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
  entry.addEventListener('click', () => open())
  desktop?.onSettingsRequested?.(() => open())
  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('cancel', (event) => { if (locked) event.preventDefault() })
  paint()
  try {
    if (sessionStorage.getItem('new-world:settings-open') === '1') {
      sessionStorage.removeItem('new-world:settings-open')
      open(languageSection)
    }
  } catch { /* Settings can still be opened from the header. */ }
}
