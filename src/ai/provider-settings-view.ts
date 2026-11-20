import { ai } from '../ai-provider'
import type {
  AiError, Auth, ConfigState, ConnectionTarget, ConnectionTest, CredentialPatch, Feature, GenerationOptions,
  Header, JsonObject, ProfileConfig, Protocol, Routing, SavedProfile,
} from '../ai-provider'
import { t } from '../i18n'
import { setExpanded } from '../shell/collapse'
import { button, downloadFile, element, icon } from '../ui'
import { confirmDialog } from './access'
import { describeAiError, mayBeCors } from './errors'
import { alignMembers, assignFeature, featureGroups } from './features'
import './provider-settings.css'

const protocols: { value: Protocol; label: string }[] = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'gemini-generate-content', label: 'Gemini generateContent' },
]
const authKinds: Auth['kind'][] = ['none', 'bearer', 'x-api-key', 'header', 'query']
/** Below this many output tokens a whole chapter may not fit in the reply. */
const smallOutput = 1024
const roomyOutput = 8192

interface Editing {
  id?: string
  saved?: SavedProfile
  config: ProfileConfig
  patch: CredentialPatch
  remember: boolean
  dirty: boolean
}

let sequence = 0
const uid = (name: string) => `aip-${name}-${++sequence}`

/** Wraps a call so a missing or failing bridge reads as an error result. */
async function safely<T>(call: () => Promise<{ ok: true; data: T } | { ok: false; error: AiError }>) {
  try {
    return await call()
  } catch (cause) {
    return { ok: false as const, error: { code: 'storage' as const, message: cause instanceof Error ? cause.message : String(cause) } }
  }
}

function errorLines(error: AiError) {
  const lines = [describeAiError(error)]
  if (error.message && error.message !== lines[0]) lines.push(t('aiProvider.errorOriginal', [error.message]))
  return lines
}

/** The AI service profiles, their feature assignment, import and export, and the connection test. */
export function mountProviderSettings(card: HTMLElement, routingCard: HTMLElement): () => Promise<void> {
  let state: ConfigState | null = null
  let editing: Editing | null = null
  let loading = 0

  const root = element('div', 'aip')
  const loadError = element('p', 'field-error')
  loadError.setAttribute('role', 'alert')
  loadError.hidden = true

  // ——— Profile list and file actions ———
  const bar = element('div', 'aip-bar')
  const list = element('div', 'aip-list')
  list.setAttribute('role', 'group')
  list.setAttribute('aria-label', t('aiProvider.profiles'))
  const actions = element('div', 'aip-bar-actions')
  const addButton = button(t('aiProvider.addProfile'), 'button button-small', 'plus')
  addButton.setAttribute('aria-expanded', 'false')
  const importButton = button(t('aiProvider.import'), 'button button-quiet button-small')
  const exportButton = button(t('aiProvider.export'), 'button button-quiet button-small')
  const importInput = element('input')
  importInput.type = 'file'
  importInput.accept = 'application/json,.json'
  importInput.hidden = true
  actions.append(addButton, importButton, exportButton, importInput)
  bar.append(list, actions)

  const presetRegion = element('div', 'aip-presets')
  presetRegion.hidden = true
  presetRegion.append(element('p', 'dialog-help', t('aiProvider.presetHint')))
  const presetGrid = element('div', 'aip-preset-grid')
  for (const preset of ai.listPresets()) {
    const choice = button(preset.config.name, 'button button-quiet button-small aip-preset')
    choice.addEventListener('click', () => { void startNew(preset.config) })
    presetGrid.append(choice)
  }
  const blank = button(t('aiProvider.presetBlank'), 'button button-quiet button-small aip-preset')
  blank.addEventListener('click', () => {
    void startNew({ name: t('aiProvider.newProfileName'), protocol: 'openai-chat', baseUrl: '', auth: { kind: 'bearer' } })
  })
  presetGrid.append(blank)
  presetRegion.append(presetGrid)

  const status = element('p', 'settings-state aip-status')
  status.setAttribute('role', 'status')
  const editorRegion = element('div', 'aip-editor-region')
  editorRegion.hidden = true
  const empty = element('p', 'dialog-help aip-empty', t('aiProvider.empty'))

  root.append(loadError, bar, presetRegion, empty, editorRegion, status)
  card.append(element('p', 'dialog-help', t('aiProvider.intro')), root)

  // ——— Feature assignment ———
  const routingBody = element('div', 'aip-routing')
  const routingStatus = element('p', 'settings-state')
  routingStatus.setAttribute('role', 'status')
  // The book summary keeps each chapter's summary until that chapter changes; this forgets them all.
  const cacheRow = element('div', 'settings-actions aip-cache')
  const clearCache = button(t('aiProvider.clearSummaryCache'), 'button button-quiet button-small')
  cacheRow.append(clearCache, element('span', 'aip-hint', t('aiProvider.clearSummaryCacheHint')))
  clearCache.addEventListener('click', async () => {
    if (!await confirmDialog(t('aiProvider.clearSummaryCacheTitle'), [t('aiProvider.clearSummaryCacheCopy')], t('aiProvider.clearSummaryCache'), true)) return
    const result = await safely(() => ai.clearSummaryCache())
    routingStatus.textContent = result.ok ? t('aiProvider.summaryCacheCleared') : errorLines(result.error).join(' ')
  })
  routingCard.append(element('p', 'dialog-help', t('aiProvider.routingHint')), routingBody, cacheRow, routingStatus)

  function say(message: string) {
    status.textContent = message
  }

  function togglePresets(open?: boolean) {
    const next = open ?? presetRegion.hidden
    addButton.setAttribute('aria-expanded', String(next))
    setExpanded(presetRegion, next)
  }
  addButton.addEventListener('click', () => togglePresets())

  async function leaveEditing() {
    if (!editing?.dirty) return true
    return confirmDialog(t('aiProvider.discardTitle'), [t('aiProvider.discardCopy')], t('aiProvider.discard'), true)
  }

  async function startNew(config: ProfileConfig) {
    if (!await leaveEditing()) return
    togglePresets(false)
    editing = { config: structuredClone(config), patch: {}, remember: false, dirty: true }
    renderList()
    renderEditor()
  }

  async function select(id: string) {
    if (editing?.id === id && !editing.dirty) return
    if (!await leaveEditing()) return
    const saved = state?.profiles.find((profile) => profile.id === id)
    if (!saved) return
    editing = { id, saved, config: structuredClone(saved.config), patch: {}, remember: saved.rememberCredentials, dirty: false }
    renderList()
    renderEditor()
  }

  function renderList() {
    list.replaceChildren()
    for (const profile of state?.profiles ?? []) {
      const item = button(profile.config.name, 'aip-item')
      item.setAttribute('aria-pressed', String(editing?.id === profile.id))
      if (state?.routing.defaultProfileId === profile.id) item.append(element('span', 'aip-item-tag', t('aiProvider.defaultTag')))
      item.addEventListener('click', () => { void select(profile.id) })
      list.append(item)
    }
    if (editing && !editing.id) {
      const item = button(editing.config.name || t('aiProvider.newProfileName'), 'aip-item')
      item.setAttribute('aria-pressed', 'true')
      item.append(element('span', 'aip-item-tag', t('aiProvider.unsavedTag')))
      list.append(item)
    }
    empty.hidden = Boolean(state?.profiles.length) || Boolean(editing)
    exportButton.disabled = !state?.profiles.length
  }

  // ——— Field builders ———
  function field(label: string, control: HTMLElement, hint?: string) {
    const wrap = element('label', 'field-label aip-field')
    const name = element('span', 'aip-label', label)
    name.id = uid('label')
    // Named by the label text alone, so a select's options or the hint don't join its name.
    control.setAttribute('aria-labelledby', name.id)
    wrap.append(name, control)
    if (hint) {
      const note = element('span', 'aip-hint', hint)
      note.id = uid('hint')
      control.setAttribute('aria-describedby', note.id)
      wrap.append(note)
    }
    return wrap
  }

  function input(value: string | undefined, onInput: (value: string) => void, type = 'text') {
    const node = element('input', 'title-input')
    node.type = type
    node.value = value ?? ''
    node.spellcheck = false
    node.autocomplete = 'off'
    node.addEventListener('input', () => { onInput(node.value); changed() })
    return node
  }

  function numberInput(value: number | undefined, onInput: (value: number | undefined) => void, options: { min?: number; max?: number; step?: string } = {}) {
    const node = input(value === undefined ? '' : String(value), (text) => {
      const trimmed = text.trim()
      const parsed = trimmed === '' ? undefined : Number(trimmed)
      onInput(parsed === undefined || Number.isNaN(parsed) ? undefined : parsed)
    }, 'number')
    node.inputMode = options.step ? 'decimal' : 'numeric'
    if (options.min !== undefined) node.min = String(options.min)
    if (options.max !== undefined) node.max = String(options.max)
    node.step = options.step ?? '1'
    return node
  }

  function selectInput<T extends string>(choices: { value: T; label: string }[], value: T, onChange: (value: T) => void) {
    const node = element('select', 'editor-select')
    for (const choice of choices) {
      const option = element('option', '', choice.label)
      option.value = choice.value
      node.append(option)
    }
    node.value = value
    node.addEventListener('change', () => { onChange(node.value as T); changed() })
    return node
  }

  function checkbox(label: string, checked: boolean, onChange: (checked: boolean) => void) {
    const wrap = element('label', 'appearance-check aip-check')
    const node = element('input')
    node.type = 'checkbox'
    node.checked = checked
    node.addEventListener('change', () => { onChange(node.checked); changed() })
    wrap.append(node, element('span', '', label))
    return { wrap, node }
  }

  /** A titled block that opens and closes with the shared height animation. */
  function section(title: string, open: boolean, ...children: HTMLElement[]) {
    const wrap = element('section', 'aip-section')
    const toggle = button('', 'aip-section-toggle')
    const body = element('div', 'aip-section-body')
    body.id = uid('section')
    toggle.setAttribute('aria-controls', body.id)
    toggle.setAttribute('aria-expanded', String(open))
    toggle.append(element('span', '', title), icon('chevron'))
    body.append(...children)
    body.hidden = !open
    toggle.addEventListener('click', () => {
      const next = toggle.getAttribute('aria-expanded') !== 'true'
      toggle.setAttribute('aria-expanded', String(next))
      setExpanded(body, next)
    })
    wrap.append(toggle, body)
    return wrap
  }

  /** Opens or closes a block; a call matching where it is already heading does nothing. */
  function reveal(node: HTMLElement, show: boolean) {
    setExpanded(node, show)
  }

  let onChange: (() => void) | null = null
  function changed() {
    if (!editing) return
    editing.dirty = true
    onChange?.()
  }

  function cleanGeneration(generation: GenerationOptions | undefined) {
    const next = Object.fromEntries(Object.entries(generation ?? {}).filter(([, value]) => value !== undefined && value !== ''))
    return Object.keys(next).length ? next as GenerationOptions : undefined
  }

  // ——— The profile form ———
  function renderEditor() {
    onChange = null
    if (!editing) {
      reveal(editorRegion, false)
      return
    }
    const current = editing
    const config = current.config
    const web = state?.credentialStorage === 'web'
    const form = element('form', 'aip-editor')
    form.noValidate = true
    form.addEventListener('submit', (event) => { event.preventDefault(); void save() })

    // Connection
    const name = input(config.name, (value) => { config.name = value; renderList() })
    name.maxLength = 80
    const protocol = selectInput(protocols, config.protocol, (value) => { config.protocol = value; refreshProtocol() })
    const baseUrl = input(config.baseUrl, (value) => { config.baseUrl = value.trim() }, 'url')
    baseUrl.placeholder = 'https://api.example.com/v1'

    const authName = input(config.auth.kind === 'header' || config.auth.kind === 'query' ? config.auth.name : '', (value) => {
      if (config.auth.kind === 'header' || config.auth.kind === 'query') config.auth.name = value.trim()
    })
    const authPrefix = input(config.auth.kind === 'header' ? config.auth.prefix : '', (value) => {
      if (config.auth.kind === 'header') config.auth.prefix = value || undefined
    })
    const authNameField = field(t('aiProvider.authName'), authName)
    const authPrefixField = field(t('aiProvider.authPrefix'), authPrefix, t('aiProvider.authPrefixHint'))
    const auth = selectInput(authKinds.map((kind) => ({ value: kind, label: t(`aiProvider.auth.${kind}`) })), config.auth.kind, (kind) => {
      const previousName = authName.value.trim()
      config.auth = kind === 'header' ? { kind, name: previousName || 'Authorization', prefix: authPrefix.value || undefined }
        : kind === 'query' ? { kind, name: previousName || 'key' }
          : { kind }
      if (kind === 'header' || kind === 'query') authName.value = config.auth.kind === 'header' || config.auth.kind === 'query' ? config.auth.name : ''
      refreshAuth()
    })

    const apiKey = input('', (value) => {
      if (value) current.patch.apiKey = value
      else delete current.patch.apiKey
      refreshKey()
    }, 'password')
    const keyState = element('span', 'aip-hint')
    const clearKey = button(t('aiProvider.clearKey'), 'button button-quiet button-small')
    clearKey.addEventListener('click', () => {
      apiKey.value = ''
      current.patch.apiKey = null
      changed()
      refreshKey()
    })
    const keyRow = element('div', 'aip-inline')
    keyRow.append(apiKey, clearKey)
    const keyField = element('div', 'field-label aip-field')
    const keyLabel = element('label', 'aip-label', t('aiProvider.apiKey'))
    apiKey.id = uid('key')
    keyLabel.htmlFor = apiKey.id
    keyField.append(keyLabel, keyRow, keyState)

    const rememberBox = checkbox(t('aiProvider.rememberKey'), current.remember, (on) => { current.remember = on; refreshRemember() })
    const rememberNote = element('p', 'dialog-help aip-warning', t('aiProvider.rememberKeyWarning'))
    const rememberHelp = element('p', 'dialog-help', t('aiProvider.rememberKeyOff'))
    const rememberGroup = element('div', 'aip-group')
    rememberGroup.append(rememberBox.wrap, rememberHelp, rememberNote)
    rememberGroup.hidden = !web

    const directBox = checkbox(t('aiProvider.anthropicDirect'), Boolean(config.anthropicDirectBrowserAccess), (on) => {
      config.anthropicDirectBrowserAccess = on || undefined
      reveal(directNote, on)
    })
    const directNote = element('p', 'dialog-help aip-warning', t('aiProvider.anthropicDirectWarning'))
    directNote.hidden = !config.anthropicDirectBrowserAccess
    const directGroup = element('div', 'aip-group')
    directGroup.append(directBox.wrap, directNote)

    // Model
    const model = input(config.model, (value) => { config.model = value.trim() || undefined })
    model.placeholder = t('aiProvider.modelPlaceholder')
    const fetchModels = button(t('aiProvider.fetchModels'), 'button button-quiet button-small')
    const modelRow = element('div', 'aip-inline')
    modelRow.append(model, fetchModels)
    const modelField = element('div', 'field-label aip-field')
    const modelLabel = element('label', 'aip-label', t('aiProvider.model'))
    model.id = uid('model')
    modelLabel.htmlFor = model.id
    modelField.append(modelLabel, modelRow, element('span', 'aip-hint', t('aiProvider.modelHint')))
    const modelPicker = element('div', 'aip-model-picker')
    modelPicker.hidden = true
    const modelSelect = element('select', 'editor-select')
    modelSelect.setAttribute('aria-label', t('aiProvider.modelList'))
    const moreModels = button(t('aiProvider.moreModels'), 'button button-quiet button-small')
    const modelError = element('p', 'field-error')
    modelError.setAttribute('role', 'alert')
    modelError.hidden = true
    modelPicker.append(modelSelect, moreModels)
    let modelCursor: string | undefined
    modelSelect.addEventListener('change', () => {
      if (!modelSelect.value) return
      model.value = modelSelect.value
      config.model = modelSelect.value
      changed()
    })
    async function loadModels(more: boolean) {
      fetchModels.disabled = moreModels.disabled = true
      modelError.hidden = true
      const result = await safely(() => ai.listModels(target(), more ? modelCursor : undefined))
      fetchModels.disabled = moreModels.disabled = false
      if (!result.ok) {
        modelError.textContent = errorLines(result.error).join(' ')
        modelError.hidden = false
        return
      }
      if (!more) {
        modelSelect.replaceChildren()
        const prompt = element('option', '', t('aiProvider.modelChoose'))
        prompt.value = ''
        modelSelect.append(prompt)
      }
      for (const entry of result.data.models) {
        const option = element('option', '', entry.displayName && entry.displayName !== entry.id ? `${entry.displayName} · ${entry.id}` : entry.id)
        option.value = entry.id
        modelSelect.append(option)
      }
      modelSelect.value = config.model && result.data.models.some((entry) => entry.id === config.model) ? config.model : modelSelect.value
      modelCursor = result.data.nextCursor
      moreModels.hidden = !modelCursor
      reveal(modelPicker, true)
      say(t('aiProvider.modelsLoaded', [modelSelect.options.length - 1]))
    }
    fetchModels.addEventListener('click', () => { void loadModels(false) })
    moreModels.addEventListener('click', () => { void loadModels(true) })

    // Output budget: small limits are called out where they can be seen and raised in one click.
    const generation = config.generation ??= {}
    const maxOutput = numberInput(generation.maxOutputTokens, (value) => { generation.maxOutputTokens = value; refreshOutput() }, { min: 1 })
    const outputCallout = element('div', 'aip-callout')
    outputCallout.setAttribute('role', 'note')
    const outputText = element('p', '')
    const raiseOutput = button(t('aiProvider.raiseOutput', [roomyOutput]), 'button button-small')
    raiseOutput.addEventListener('click', () => {
      generation.maxOutputTokens = roomyOutput
      maxOutput.value = String(roomyOutput)
      changed()
      refreshOutput()
    })
    outputCallout.append(outputText, raiseOutput)

    // Generation
    const temperature = numberInput(generation.temperature, (value) => { generation.temperature = value }, { min: 0, max: 2, step: '0.1' })
    const topP = numberInput(generation.topP, (value) => { generation.topP = value }, { min: 0, max: 1, step: '0.05' })
    const contextTokens = numberInput(generation.contextTokens, (value) => { generation.contextTokens = value }, { min: 1 })
    const reasoning = input(generation.reasoningEffort, (value) => { generation.reasoningEffort = value.trim() || undefined })
    reasoning.placeholder = 'low / medium / high'
    const thinking = numberInput(generation.thinkingBudgetTokens, (value) => { generation.thinkingBudgetTokens = value }, { min: 0 })
    const stream = checkbox(t('aiProvider.stream'), config.stream !== false, (on) => { config.stream = on })
    const timeout = numberInput(config.timeoutMs === undefined ? undefined : config.timeoutMs / 1000, (value) => {
      config.timeoutMs = value === undefined ? undefined : Math.round(value * 1000)
    }, { min: 1 })
    timeout.placeholder = '120'
    const retries = numberInput(config.retries, (value) => { config.retries = value }, { min: 0, max: 10 })
    retries.placeholder = '0'
    const grid = (...nodes: HTMLElement[]) => {
      const node = element('div', 'aip-grid')
      node.append(...nodes)
      return node
    }

    // Advanced: paths, headers, extra JSON
    config.paths ??= {}
    const paths = config.paths
    const pathInput = (key: 'generate' | 'stream' | 'models') => {
      const node = input(paths[key], (value) => { paths[key] = value.trim() || undefined })
      node.placeholder = t('aiProvider.pathDefault')
      return node
    }
    const streamPathField = field(t('aiProvider.pathStream'), pathInput('stream'), t('aiProvider.pathStreamHint'))
    const headerRows = element('div', 'aip-headers')
    const addHeader = button(t('aiProvider.addHeader'), 'button button-quiet button-small', 'plus')
    config.headers ??= []
    const headers = config.headers
    function headerRow(index: number) {
      const row = element('div', 'aip-header-row')
      const header = headers[index]!
      const secret = 'secretRef' in header
      const nameNode = element('input', 'title-input')
      nameNode.value = header.name
      nameNode.placeholder = t('aiProvider.headerName')
      nameNode.setAttribute('aria-label', t('aiProvider.headerName'))
      nameNode.spellcheck = false
      nameNode.addEventListener('input', () => { headers[index] = { ...headers[index]!, name: nameNode.value.trim() } as Header; changed() })
      const valueNode = element('input', 'title-input')
      valueNode.type = secret ? 'password' : 'text'
      valueNode.spellcheck = false
      valueNode.autocomplete = 'off'
      valueNode.setAttribute('aria-label', t('aiProvider.headerValue'))
      if ('secretRef' in header) {
        valueNode.value = current.patch.headerSecrets?.[header.secretRef] ?? ''
        valueNode.placeholder = current.saved?.savedSecretRefs.includes(header.secretRef) ? t('aiProvider.secretSaved') : t('aiProvider.headerValue')
      } else {
        valueNode.value = header.value
        valueNode.placeholder = t('aiProvider.headerValue')
      }
      valueNode.addEventListener('input', () => {
        const entry = headers[index]!
        if ('secretRef' in entry) {
          current.patch.headerSecrets ??= {}
          if (valueNode.value) current.patch.headerSecrets[entry.secretRef] = valueNode.value
          else delete current.patch.headerSecrets[entry.secretRef]
        } else headers[index] = { name: entry.name, value: valueNode.value }
        changed()
      })
      const secretBox = checkbox(t('aiProvider.headerSecret'), secret, (on) => {
        const entry = headers[index]!
        if (on && !('secretRef' in entry)) {
          const ref = crypto.randomUUID()
          headers[index] = { name: entry.name, secretRef: ref }
          if (entry.value) (current.patch.headerSecrets ??= {})[ref] = entry.value
        } else if (!on && 'secretRef' in entry) {
          if (current.saved?.savedSecretRefs.includes(entry.secretRef)) (current.patch.headerSecrets ??= {})[entry.secretRef] = null
          else delete current.patch.headerSecrets?.[entry.secretRef]
          headers[index] = { name: entry.name, value: '' }
        }
        renderHeaders()
      })
      const remove = button('', 'button button-quiet button-small aip-icon-button', 'close')
      remove.setAttribute('aria-label', t('aiProvider.removeHeader'))
      remove.addEventListener('click', () => {
        const entry = headers[index]!
        if ('secretRef' in entry && current.saved?.savedSecretRefs.includes(entry.secretRef)) {
          (current.patch.headerSecrets ??= {})[entry.secretRef] = null
        }
        headers.splice(index, 1)
        changed()
        renderHeaders()
      })
      row.append(nameNode, valueNode, secretBox.wrap, remove)
      return row
    }
    function renderHeaders() {
      headerRows.replaceChildren(...headers.map((_, index) => headerRow(index)))
    }
    renderHeaders()
    addHeader.addEventListener('click', () => {
      headers.push({ name: '', value: '' })
      changed()
      renderHeaders()
      headerRows.querySelector<HTMLInputElement>('.aip-header-row:last-child input')?.focus()
    })
    const headersField = element('div', 'field-label aip-field')
    headersField.append(element('span', 'aip-label', t('aiProvider.headers')), headerRows, addHeader,
      element('span', 'aip-hint', t('aiProvider.headersHint')))

    const extra = element('textarea', 'title-input aip-json')
    extra.rows = 4
    extra.spellcheck = false
    extra.value = config.extraBody ? JSON.stringify(config.extraBody, null, 2) : ''
    extra.placeholder = '{ "max_tokens": 8192 }'
    const extraError = element('span', 'aip-hint aip-hint-error')
    extraError.setAttribute('role', 'alert')
    let extraValid = true
    extra.addEventListener('input', () => {
      const text = extra.value.trim()
      extraValid = true
      extraError.textContent = ''
      if (!text) config.extraBody = undefined
      else {
        try {
          const parsed: unknown = JSON.parse(text)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object')
          config.extraBody = parsed as JsonObject
        } catch {
          extraValid = false
          extraError.textContent = t('aiProvider.extraBodyInvalid')
        }
      }
      changed()
      refreshOutput()
    })
    const extraField = field(t('aiProvider.extraBody'), extra, t('aiProvider.extraBodyHint'))
    extraField.append(extraError)

    // Actions and the connection test
    const saveButton = button(t('aiProvider.save'), 'button button-primary')
    saveButton.type = 'submit'
    const testButton = button(t('aiProvider.test'), 'button button-quiet')
    const revertButton = button(t('aiProvider.revert'), 'button button-quiet')
    const deleteButton = button(t('aiProvider.delete'), 'button button-quiet aip-delete')
    const formActions = element('div', 'settings-actions')
    formActions.append(saveButton, testButton, revertButton, deleteButton)
    const formError = element('div', 'field-error')
    formError.setAttribute('role', 'alert')
    formError.hidden = true
    const testResult = element('div', 'aip-test')
    testResult.setAttribute('role', 'status')
    testResult.hidden = true

    testButton.addEventListener('click', () => { void runTest() })
    revertButton.addEventListener('click', () => {
      if (current.saved) {
        editing = { id: current.id, saved: current.saved, config: structuredClone(current.saved.config), patch: {}, remember: current.saved.rememberCredentials, dirty: false }
      } else editing = null
      renderList()
      renderEditor()
    })
    deleteButton.addEventListener('click', () => { void remove() })

    form.append(
      section(t('aiProvider.sectionConnection'), true,
        field(t('aiProvider.name'), name),
        grid(field(t('aiProvider.protocol'), protocol), field(t('aiProvider.authKind'), auth)),
        field(t('aiProvider.baseUrl'), baseUrl, t('aiProvider.baseUrlHint')),
        grid(authNameField, authPrefixField),
        keyField, rememberGroup, directGroup),
      section(t('aiProvider.sectionModel'), true, modelField, modelPicker, modelError, outputCallout),
      section(t('aiProvider.sectionGeneration'), false,
        grid(
          field(t('aiProvider.maxOutput'), maxOutput, t('aiProvider.maxOutputHint')),
          field(t('aiProvider.contextTokens'), contextTokens, t('aiProvider.contextTokensHint')),
          field(t('aiProvider.temperature'), temperature),
          field(t('aiProvider.topP'), topP),
          field(t('aiProvider.reasoningEffort'), reasoning),
          field(t('aiProvider.thinkingBudget'), thinking),
          field(t('aiProvider.timeout'), timeout, t('aiProvider.timeoutHint')),
          field(t('aiProvider.retries'), retries, t('aiProvider.retriesHint')),
        ),
        stream.wrap),
      section(t('aiProvider.sectionAdvanced'), false,
        field(t('aiProvider.pathGenerate'), pathInput('generate'), t('aiProvider.pathHint')),
        streamPathField,
        field(t('aiProvider.pathModels'), pathInput('models')),
        headersField, extraField),
      formError, formActions, testResult,
    )

    function refreshAuth() {
      const kind = config.auth.kind
      authNameField.hidden = !(kind === 'header' || kind === 'query')
      authPrefixField.hidden = kind !== 'header'
      keyField.hidden = kind === 'none'
      rememberGroup.hidden = !web || kind === 'none'
      authName.placeholder = kind === 'query' ? 'key' : 'Authorization'
    }
    function refreshKey() {
      const saved = Boolean(current.saved?.hasApiKey) && current.patch.apiKey !== null
      apiKey.placeholder = saved ? t('aiProvider.keySavedPlaceholder') : t('aiProvider.keyPlaceholder')
      keyState.textContent = current.patch.apiKey === null ? t('aiProvider.keyWillClear')
        : current.patch.apiKey ? t('aiProvider.keyWillSave')
          : saved ? (web && !current.saved?.rememberCredentials ? t('aiProvider.keyInMemory') : t('aiProvider.keySaved'))
            : t('aiProvider.keyMissing')
      clearKey.hidden = !saved
    }
    function refreshRemember() {
      reveal(rememberNote, current.remember)
      rememberHelp.hidden = current.remember
    }
    function refreshProtocol() {
      const anthropic = config.protocol === 'anthropic-messages'
      directGroup.hidden = !web || !anthropic
      streamPathField.hidden = config.protocol !== 'gemini-generate-content'
      refreshOutput()
    }
    function refreshOutput() {
      const extraMax = typeof config.extraBody?.max_tokens === 'number' ? config.extraBody.max_tokens : undefined
      const limit = generation.maxOutputTokens ?? extraMax
      const missing = config.protocol === 'anthropic-messages' && limit === undefined
      const small = limit !== undefined && limit <= smallOutput
      outputText.textContent = missing ? t('aiProvider.outputMissing')
        : small ? t('aiProvider.outputSmall', [limit, Math.round(limit * 0.7)]) : ''
      outputCallout.classList.toggle('aip-callout-error', missing)
      raiseOutput.hidden = extraMax !== undefined && generation.maxOutputTokens === undefined
      reveal(outputCallout, missing || small)
    }
    function refreshButtons() {
      saveButton.disabled = !extraValid || !current.dirty
      revertButton.hidden = !current.dirty
      deleteButton.hidden = !current.id
      renderList()
    }
    onChange = () => { formError.hidden = true; refreshButtons() }

    refreshAuth()
    refreshKey()
    refreshRemember()
    refreshProtocol()
    outputCallout.hidden = outputText.textContent === ''
    refreshButtons()

    async function runTest() {
      testButton.disabled = true
      testResult.replaceChildren(element('p', '', t('aiProvider.testing')))
      reveal(testResult, true)
      let result: ConnectionTest
      try {
        result = await ai.testConnection(target(), { stream: config.stream !== false })
      } catch (cause) {
        result = { ok: false, error: { code: 'storage', message: cause instanceof Error ? cause.message : String(cause) } }
      }
      testButton.disabled = false
      showTest(result)
    }

    function showTest(result: ConnectionTest) {
      const nodes: HTMLElement[] = []
      if (result.ok) {
        const line = element('p', 'aip-test-ok', t('aiProvider.testOk', [result.httpStatus]))
        nodes.push(line)
      } else {
        const [summary, ...rest] = errorLines(result.error)
        nodes.push(element('p', 'aip-test-fail', summary))
        if (result.httpStatus !== undefined) nodes.push(element('p', 'aip-test-code', t('aiProvider.testStatus', [result.httpStatus])))
        const raw = result.rawErrorBody
        if (raw) {
          nodes.push(element('p', 'aip-label', t('aiProvider.testBody')))
          nodes.push(element('pre', 'aip-test-body', raw))
        }
        if (rest.length) nodes.push(element('p', 'dialog-help', rest.join(' ')))
        if (mayBeCors(result.error)) {
          const tips = element('ul', 'aip-test-tips')
          for (const key of ['aiProvider.corsTipEndpoint', 'aiProvider.corsTipProxy', ...(web ? ['aiProvider.corsTipDesktop'] : [])]) {
            tips.append(element('li', '', t(key)))
          }
          nodes.push(element('p', 'aip-label', t('aiProvider.corsTitle')), tips)
        }
      }
      testResult.classList.toggle('aip-test-failed', !result.ok)
      testResult.replaceChildren(...nodes)
    }

    editorRegion.replaceChildren(form)
    reveal(editorRegion, true)
  }

  function prepared(): ProfileConfig {
    const config = structuredClone(editing!.config)
    config.generation = cleanGeneration(config.generation)
    if (config.paths && !Object.values(config.paths).some(Boolean)) config.paths = undefined
    else if (config.paths) config.paths = Object.fromEntries(Object.entries(config.paths).filter(([, value]) => value))
    if (config.headers) config.headers = config.headers.filter((header) => header.name)
    if (config.headers && !config.headers.length) config.headers = undefined
    if (config.model === '') config.model = undefined
    return config
  }

  function credentialPatch(): CredentialPatch | undefined {
    const patch = editing!.patch
    const secrets = patch.headerSecrets && Object.keys(patch.headerSecrets).length ? patch.headerSecrets : undefined
    if (patch.apiKey === undefined && !secrets) return undefined
    return { ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {}), ...(secrets ? { headerSecrets: secrets } : {}) }
  }

  /** Tests and model lists use the saved profile when nothing changed, else the form as drafted. */
  function target(): ConnectionTarget {
    const current = editing!
    if (current.id && !current.dirty) return { profileId: current.id }
    const draft = prepared()
    const credentials = credentialPatch()
    let reuse: string | undefined
    if (current.saved) {
      try {
        if (new URL(current.saved.config.baseUrl).origin === new URL(draft.baseUrl).origin) reuse = current.saved.id
      } catch { /* An unreadable address is reported by the test itself. */ }
    }
    return { draft, ...(credentials ? { credentials } : {}), ...(reuse ? { reuseCredentialsFrom: reuse } : {}) }
  }

  function showFormError(lines: string[]) {
    const box = editorRegion.querySelector<HTMLElement>('.aip-editor > .field-error')
    if (!box) return
    box.replaceChildren(...lines.map((line) => element('p', '', line)))
    box.hidden = false
  }

  async function save() {
    const current = editing
    if (!current) return
    const config = prepared()
    if (!config.name.trim() || !config.baseUrl) { showFormError([t('aiProvider.needNameAndUrl')]); return }
    const credentials = credentialPatch()
    const result = await safely(() => ai.saveProfile({
      ...(current.id ? { id: current.id } : {}),
      config,
      ...(credentials ? { credentials } : {}),
      ...(state?.credentialStorage === 'web' ? { rememberCredentials: current.remember } : {}),
    }))
    if (!result.ok) { showFormError(errorLines(result.error)); return }
    const firstProfile = !state?.profiles.length
    editing = null
    await refresh(result.data.id)
    // The first profile becomes the default, so every feature works right away.
    if (firstProfile && state && !state.routing.defaultProfileId) await saveRouting({ ...state.routing, defaultProfileId: result.data.id })
    say(t('aiProvider.saved'))
  }

  async function remove() {
    const current = editing
    if (!current?.id) return
    if (!await confirmDialog(t('aiProvider.deleteTitle', [current.config.name]), [t('aiProvider.deleteCopy')], t('aiProvider.delete'), true)) return
    const result = await safely(() => ai.deleteProfile(current.id!))
    if (!result.ok) { showFormError(errorLines(result.error)); return }
    editing = null
    await refresh()
    say(t('aiProvider.deleted'))
  }

  // ——— Routing ———
  async function saveRouting(routing: Routing) {
    const result = await safely(() => ai.setRouting(routing))
    if (!result.ok) {
      routingStatus.textContent = errorLines(result.error).join(' ')
      return false
    }
    if (state) state.routing = routing
    routingStatus.textContent = t('aiProvider.routingSaved')
    renderList()
    renderRouting()
    return true
  }

  function renderRouting() {
    routingBody.replaceChildren()
    const profiles = state?.profiles ?? []
    if (!state || !profiles.length) {
      routingBody.append(element('p', 'dialog-help', t('aiProvider.routingEmpty')))
      return
    }
    const routing = state.routing
    const profileChoices = profiles.map((profile) => ({ value: profile.id, label: profile.config.name }))
    const defaultSelect = element('select', 'editor-select')
    for (const choice of [{ value: '', label: t('aiProvider.routingNone') }, ...profileChoices]) {
      const option = element('option', '', choice.label)
      option.value = choice.value
      defaultSelect.append(option)
    }
    defaultSelect.value = routing.defaultProfileId ?? ''
    defaultSelect.addEventListener('change', () => {
      void saveRouting({ ...routing, defaultProfileId: defaultSelect.value || null })
    })
    routingBody.append(field(t('aiProvider.routingDefault'), defaultSelect))
    const desktop = Boolean(window.newWorldDesktop)
    const grid = element('div', 'aip-grid')
    for (const group of featureGroups) {
      if (group.desktopOnly && !desktop) continue
      const select = element('select', 'editor-select')
      for (const choice of [
        { value: '', label: t('aiProvider.routingFollow') },
        { value: 'off', label: t('aiProvider.routingOff') },
        ...profileChoices,
      ]) {
        const option = element('option', '', choice.label)
        option.value = choice.value
        select.append(option)
      }
      const bound = Object.hasOwn(routing.byFeature, group.feature) ? routing.byFeature[group.feature] : undefined
      select.value = bound === null ? 'off' : bound ?? ''
      select.dataset.feature = group.feature
      select.addEventListener('change', () => {
        const value = select.value === 'off' ? null : select.value || undefined
        void saveRouting(assignFeature(routing, group.feature as Feature, value))
      })
      grid.append(field(t(group.label), select, group.members.length ? t(`${group.label}Hint`) : undefined))
    }
    routingBody.append(grid)
  }

  // ——— Import and export ———
  exportButton.addEventListener('click', async () => {
    const result = await safely(() => ai.exportConfig())
    if (!result.ok) { say(errorLines(result.error).join(' ')); return }
    downloadFile(new Blob([JSON.stringify(result.data, null, 2) + '\n'], { type: 'application/json' }), 'new-world-ai-providers.json')
    say(t('aiProvider.exported'))
  })
  importButton.addEventListener('click', () => importInput.click())
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0]
    importInput.value = ''
    if (!file) return
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      say(t('aiProvider.importUnreadable'))
      return
    }
    const result = await safely(() => ai.importConfig(parsed))
    if (!result.ok) { say(errorLines(result.error).join(' ')); return }
    await refresh()
    // Imported assignments fill in what is unset here; existing choices stay.
    if (state) {
      const imported = alignMembers(result.data.routing)
      const byFeature = { ...imported.byFeature, ...state.routing.byFeature }
      await saveRouting({ defaultProfileId: state.routing.defaultProfileId ?? imported.defaultProfileId, byFeature })
    }
    say(t('aiProvider.imported', [result.data.profiles.length]))
  })

  async function refresh(selectId?: string) {
    const turn = ++loading
    const result = await safely(() => ai.getConfig())
    if (turn !== loading) return
    if (!result.ok) {
      loadError.textContent = errorLines(result.error).join(' ')
      loadError.hidden = false
      bar.hidden = true
      return
    }
    loadError.hidden = true
    bar.hidden = false
    state = result.data
    if (editing?.id && !state.profiles.some((profile) => profile.id === editing!.id)) editing = null
    const keep = editing?.dirty ? editing : null
    const id = selectId ?? (keep ? undefined : editing?.id ?? state.profiles[0]?.id)
    if (!keep) {
      const saved = id ? state.profiles.find((profile) => profile.id === id) : undefined
      editing = saved ? { id: saved.id, saved, config: structuredClone(saved.config), patch: {}, remember: saved.rememberCredentials, dirty: false } : null
      renderEditor()
    }
    renderList()
    renderRouting()
  }

  // Loaded once now as well: the settings page skips its refresh while another task holds it busy.
  void refresh()
  return () => refresh()
}
