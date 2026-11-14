import { t } from '../i18n'
import { listBooks } from '../library'
import type { Book } from '../library'
import { button, element } from '../ui'

const ALL_PERMS: ('create' | 'read' | 'update' | 'delete')[] = ['create', 'read', 'update', 'delete']

export function mountAiSettings(container: HTMLElement): () => Promise<void> {
  const desktop = window.newWorldDesktop
  const isDesktopSupported = Boolean(desktop?.getAiState)

  const badge = element('span', 'ai-badge', isDesktopSupported ? t('ai.statusDisabled') : t('ai.desktopOnlyBadge'))
  container.append(badge)

  if (!desktop?.getAiState) {
    container.append(element('p', 'dialog-help', t('ai.desktopOnlyCopy')))
    return async () => {}
  }
  const desktopApi = desktop

  let currentState: AiSettingsState | null = null
  let libraryWorks: Book[] = []
  let auditEntries: AiAuditEntry[] = []
  let revealedToken: { clientId: string; clientName: string; token: string } | null = null
  let busy = false
  let refreshSeq = 0

  const root = element('div', 'ai-settings')
  const errorBox = element('p', 'field-error')
  errorBox.setAttribute('role', 'alert')
  errorBox.hidden = true

  // Global controls: master toggle + port + endpoint notice
  const globalCard = element('div', 'ai-global-card')
  const enableRow = element('label', 'ai-check-row')
  const enableCheckbox = document.createElement('input')
  enableCheckbox.type = 'checkbox'
  enableCheckbox.setAttribute('data-ai-global-enable', 'true')
  enableRow.append(enableCheckbox, element('span', undefined, t('ai.enableBridge')))

  const portRow = element('div', 'ai-port-row')
  const portLabel = element('label', 'ai-port-label', t('ai.portLabel'))
  const portInput = document.createElement('input')
  portInput.type = 'number'
  portInput.min = '1024'
  portInput.max = '65535'
  portInput.className = 'ai-port-input'
  portInput.setAttribute('aria-label', t('ai.portLabel'))
  const savePortBtn = button(t('ai.savePort'), 'button button-quiet button-small')
  portLabel.append(portInput)
  portRow.append(portLabel, savePortBtn)

  const endpointLine = element('p', 'dialog-help ai-endpoint-line')
  const deleteNotice = element('p', 'dialog-help ai-security-note', t('ai.deleteNotice'))
  globalCard.append(enableRow, portRow, endpointLine, deleteNotice)

  // Add AI client bar
  const createForm = element('form', 'ai-create-form')
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.maxLength = 64
  nameInput.placeholder = t('ai.clientNamePlaceholder')
  nameInput.setAttribute('aria-label', t('ai.clientNameLabel'))
  nameInput.className = 'ai-name-input'
  const createBtn = button(t('ai.createClient'), 'button button-small')
  createBtn.type = 'submit'
  createForm.append(nameInput, createBtn)

  // One-time token reveal banner
  const tokenBanner = element('div', 'ai-token-banner')
  tokenBanner.hidden = true
  const tokenTitle = element('p', 'ai-token-title')
  const tokenCode = element('code', 'ai-token-value')
  const tokenActions = element('div', 'ai-token-actions')
  const copyTokenBtn = button(t('ai.copyToken'), 'button button-small')
  const hideTokenBtn = button(t('ai.dismissToken'), 'button button-quiet button-small')
  const tokenHint = element('p', 'dialog-help', t('ai.tokenOnceHint'))
  tokenActions.append(copyTokenBtn, hideTokenBtn)
  tokenBanner.append(tokenTitle, tokenCode, tokenActions, tokenHint)

  const clientList = element('div', 'ai-client-list')

  // Audit log section
  const auditDetails = document.createElement('details')
  auditDetails.className = 'ai-audit-details'
  const auditSummary = document.createElement('summary')
  auditSummary.textContent = t('ai.auditTitle')
  const auditControls = element('div', 'ai-audit-controls')
  const auditRefreshBtn = button(t('ai.auditRefresh'), 'button button-quiet button-small')
  const auditClearBtn = button(t('ai.auditClear'), 'button button-quiet button-small')
  auditControls.append(auditRefreshBtn, auditClearBtn)
  const auditList = element('ul', 'ai-audit-list')
  auditDetails.append(auditSummary, auditControls, auditList)

  root.append(errorBox, globalCard, createForm, tokenBanner, clientList, auditDetails)
  container.append(root)

  function showError(message: string | null) {
    if (!message) {
      errorBox.hidden = true
      errorBox.textContent = ''
      return
    }
    errorBox.hidden = false
    errorBox.textContent = message
  }

  function permLabel(perm: 'create' | 'read' | 'update' | 'delete'): string {
    switch (perm) {
      case 'create': return t('ai.permCreate')
      case 'read': return t('ai.permRead')
      case 'update': return t('ai.permUpdate')
      case 'delete': return t('ai.permDelete')
    }
  }

  function workOptionLabel(book: Book): string {
    const libText = book.library === 'original' ? t('libraries.original') : t('libraries.reference')
    const archivedText = book.archivedAt ? ` · ${t('ai.archivedTag')}` : ''
    return `[${libText}${archivedText}] ${book.title}`
  }

  function renderTokenBanner() {
    if (!revealedToken) {
      tokenBanner.hidden = true
      return
    }
    tokenBanner.hidden = false
    tokenTitle.textContent = t('ai.tokenRevealTitle', [revealedToken.clientName])
    tokenCode.textContent = revealedToken.token
  }

  function renderClients() {
    clientList.replaceChildren()
    const clients = currentState?.clients ?? []
    if (!clients.length) {
      clientList.append(element('p', 'dialog-help', t('ai.noClients')))
      return
    }

    for (const client of clients) {
      clientList.append(buildClientCard(client))
    }
  }

  function buildClientCard(client: AiClientSummary): HTMLElement {
    const card = element('article', 'ai-client-card')
    card.dataset.clientId = client.id

    const head = element('div', 'ai-client-head')
    const titleGroup = element('div', 'ai-client-title-group')
    const nameEl = element('strong', 'ai-client-name', client.name)
    const statusPill = element(
      'span',
      client.enabled ? 'ai-badge ai-badge-active' : 'ai-badge',
      `${client.tokenPrefix}… · ${client.enabled ? t('ai.clientStatusEnabled') : t('ai.clientStatusDisabled')}`,
    )
    titleGroup.append(nameEl, statusPill)

    const headActions = element('div', 'ai-client-actions')
    const rotateBtn = button(t('ai.rotateToken'), 'button button-quiet button-small')
    rotateBtn.addEventListener('click', () => {
      void runMutation(async () => {
        const res = await desktop!.rotateAiToken!(client.id)
        currentState = res.state
        revealedToken = { clientId: res.client.id, clientName: res.client.name, token: res.token }
      })
    })
    const removeBtn = button(t('ai.deleteClient'), 'button button-quiet button-small ai-danger-text')
    removeBtn.addEventListener('click', () => {
      void runMutation(async () => {
        currentState = await desktop!.deleteAiClient!(client.id)
        if (revealedToken?.clientId === client.id) revealedToken = null
      })
    })
    headActions.append(rotateBtn, removeBtn)
    head.append(titleGroup, headActions)

    const toggleLabel = element('label', 'ai-check-row')
    const toggleInput = document.createElement('input')
    toggleInput.type = 'checkbox'
    toggleInput.checked = client.enabled
    toggleInput.disabled = busy
    toggleInput.addEventListener('change', () => {
      const nextEnabled = toggleInput.checked
      void runMutation(async () => {
        const res = await desktopApi.updateAiClient!(client.id, { enabled: nextEnabled })
        currentState = res.state
      })
    })
    toggleLabel.append(toggleInput, element('span', undefined, t('ai.clientEnabled')))

    // CRUD permissions
    const permGroup = document.createElement('fieldset')
    permGroup.className = 'ai-fieldset'
    permGroup.disabled = busy
    permGroup.append(element('legend', 'ai-legend', t('ai.permissionsLegend')))
    const permGrid = element('div', 'ai-perm-grid')
    for (const key of ALL_PERMS) {
      const lbl = element('label', 'ai-check-row')
      const chk = document.createElement('input')
      chk.type = 'checkbox'
      chk.checked = client.permissions[key]
      chk.dataset.aiPerm = key
      chk.addEventListener('change', () => {
        const nextChecked = chk.checked
        void runMutation(async () => {
          const res = await desktopApi.updateAiClient!(client.id, {
            permissions: { ...client.permissions, [key]: nextChecked },
          })
          currentState = res.state
        })
      })
      lbl.append(chk, element('span', undefined, permLabel(key)))
      permGrid.append(lbl)
    }
    permGroup.append(permGrid)

    // Scope selector
    const scopeGroup = document.createElement('fieldset')
    scopeGroup.className = 'ai-fieldset'
    scopeGroup.disabled = busy
    scopeGroup.append(element('legend', 'ai-legend', t('ai.scopeLegend')))
    const scopeRadios = element('div', 'settings-options')
    scopeRadios.setAttribute('role', 'radiogroup')
    scopeRadios.setAttribute('aria-label', `${client.name} ${t('ai.scopeLegend')}`)
    const modes: { value: AiScopeMode; label: string }[] = [
      { value: 'none', label: t('ai.scopeNone') },
      { value: 'selected', label: t('ai.scopeSelected') },
      { value: 'all', label: t('ai.scopeAll') },
    ]
    for (const mode of modes) {
      const lbl = element('label', 'settings-option')
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = `ai-scope-${client.id}`
      radio.value = mode.value
      radio.checked = client.scope.mode === mode.value
      radio.addEventListener('change', () => {
        if (!radio.checked) return
        void runMutation(async () => {
          const res = await desktop!.updateAiClient!(client.id, {
            scope: {
              mode: mode.value,
              workIds: mode.value === 'selected' ? client.scope.workIds : [],
            },
          })
          currentState = res.state
        })
      })
      lbl.append(radio, element('span', undefined, mode.label))
      scopeRadios.append(lbl)
    }
    scopeGroup.append(scopeRadios)

    if (client.scope.mode === 'selected') {
      const picker = element('div', 'ai-work-picker')
      if (!libraryWorks.length) {
        picker.append(element('p', 'dialog-help', t('ai.noWorksAvailable')))
      } else {
        const selectedKey = client.scope.workIds.length === 1 ? 'ai.selectedCountOne' : 'ai.selectedCount'
        picker.append(element('p', 'dialog-help ai-selected-count', t(selectedKey, [client.scope.workIds.length])))
        const list = element('div', 'ai-work-list')
        const selectedSet = new Set(client.scope.workIds)
        for (const work of libraryWorks) {
          const lbl = element('label', 'ai-check-row')
          const chk = document.createElement('input')
          chk.type = 'checkbox'
          chk.value = work.id
          chk.checked = selectedSet.has(work.id)
          chk.addEventListener('change', () => {
            const nextIds = new Set(client.scope.workIds)
            if (chk.checked) nextIds.add(work.id)
            else nextIds.delete(work.id)
            void runMutation(async () => {
              const res = await desktop!.updateAiClient!(client.id, {
                scope: { mode: 'selected', workIds: Array.from(nextIds) },
              })
              currentState = res.state
            })
          })
          lbl.append(chk, element('span', undefined, workOptionLabel(work)))
          list.append(lbl)
        }
        picker.append(list)
      }
      scopeGroup.append(picker)
    }

    card.append(head, toggleLabel, permGroup, scopeGroup)
    return card
  }

  function renderAudit() {
    auditList.replaceChildren()
    if (!auditEntries.length) {
      auditList.append(element('li', 'dialog-help', t('ai.auditEmpty')))
      return
    }
    for (const entry of auditEntries.slice(0, 40)) {
      const time = new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })
      const who = entry.clientName || t('ai.auditUnknownClient')
      const summary = entry.targetSummary ? ` · ${entry.targetSummary}` : ''
      const reason = entry.reason ? ` (${entry.reason})` : ''
      const li = element('li', 'ai-audit-row', `${time} · ${who} · ${entry.action} [${entry.outcome}]${summary}${reason}`)
      auditList.append(li)
    }
  }

  function paint() {
    if (!currentState) return
    const { enabled, bridge } = currentState
    enableCheckbox.checked = enabled
    enableCheckbox.disabled = busy
    if (document.activeElement !== portInput) {
      portInput.value = String(currentState.port)
    }
    portInput.disabled = busy
    savePortBtn.disabled = busy
    createBtn.disabled = busy

    if (bridge.error) {
      badge.textContent = t('ai.statusError', [bridge.error])
      badge.className = 'ai-badge ai-badge-error'
    } else if (bridge.running) {
      badge.textContent = t('ai.statusRunning', [bridge.port])
      badge.className = 'ai-badge ai-badge-active'
    } else {
      badge.textContent = t('ai.statusDisabled')
      badge.className = 'ai-badge'
    }

    endpointLine.textContent = t('ai.endpointHelp', [`http://127.0.0.1:${bridge.port}/v1`])
    renderTokenBanner()
    renderClients()
    renderAudit()
  }

  function setBusyControls(disabled: boolean) {
    enableCheckbox.disabled = disabled
    portInput.disabled = disabled
    savePortBtn.disabled = disabled
    createBtn.disabled = disabled
    for (const el of root.querySelectorAll('fieldset, .ai-client-actions button')) {
      if (el instanceof HTMLFieldSetElement || el instanceof HTMLButtonElement) el.disabled = disabled
    }
  }

  async function runMutation(action: () => Promise<void>) {
    if (busy) return
    busy = true
    showError(null)
    // Disable controls in-place without rebuilding or reverting the clicked control before IPC finishes.
    setBusyControls(true)
    try {
      await action()
      await refresh()
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err))
    } finally {
      busy = false
      paint()
    }
  }

  async function refresh() {
    const seq = ++refreshSeq
    try {
      const [aiState, origBooks, refBooks, audit] = await Promise.all([
        desktopApi.getAiState!(),
        listBooks('original'),
        listBooks('reference'),
        desktopApi.listAiAudit ? desktopApi.listAiAudit(50) : Promise.resolve([]),
      ])
      if (seq !== refreshSeq) return
      currentState = aiState
      libraryWorks = [...origBooks, ...refBooks].filter((b) => !b.workId)
      auditEntries = audit
      paint()
    } catch (err) {
      if (seq !== refreshSeq) return
      showError(err instanceof Error ? err.message : String(err))
    }
  }

  enableCheckbox.addEventListener('change', () => {
    const nextEnabled = enableCheckbox.checked
    void runMutation(async () => {
      currentState = await desktopApi.setAiEnabled!(nextEnabled)
    })
  })

  savePortBtn.addEventListener('click', () => {
    const parsed = Number.parseInt(portInput.value, 10)
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      showError(t('ai.invalidPort'))
      return
    }
    void runMutation(async () => {
      currentState = await desktop!.setAiPort!(parsed)
    })
  })

  createForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const trimmed = nameInput.value.trim()
    if (!trimmed) {
      showError(t('ai.clientNameRequired'))
      nameInput.focus()
      return
    }
    void runMutation(async () => {
      const created = await desktop!.createAiClient!({
        name: trimmed,
        enabled: true,
        permissions: { create: false, read: false, update: false, delete: false },
        scope: { mode: 'none', workIds: [] },
      })
      nameInput.value = ''
      currentState = created.state
      revealedToken = { clientId: created.client.id, clientName: created.client.name, token: created.token }
    })
  })

  copyTokenBtn.addEventListener('click', () => {
    if (!revealedToken) return
    void navigator.clipboard?.writeText(revealedToken.token).catch(() => {})
  })

  hideTokenBtn.addEventListener('click', () => {
    revealedToken = null
    renderTokenBanner()
  })

  auditRefreshBtn.addEventListener('click', () => {
    void refresh()
  })

  auditClearBtn.addEventListener('click', () => {
    void runMutation(async () => {
      auditEntries = await (desktopApi.clearAiAudit ? desktopApi.clearAiAudit() : Promise.resolve([]))
    })
  })

  return refresh
}
