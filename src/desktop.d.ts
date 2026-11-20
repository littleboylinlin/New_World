interface StorageState {
  path: string
  defaultPath: string
  custom: boolean
}

interface StorageResult {
  path: string
  custom: boolean
  restart: boolean
}

type LoginItemState = 'off' | 'on' | 'approval'

type CloseBehavior = 'quit' | 'background'

type BackupFrequency = 'off' | 'daily' | 'weekly'

type DesktopCommand = { type: 'project'; token: string } | { type: 'open'; hash: string } | { type: 'ideas' } | { type: 'new-novel' } | { type: 'backup' } | { type: 'idea'; text: string }

interface CaptureState {
  shortcut: string
  defaultShortcut: string
  label: string
  registered: boolean
}

type CaptureShortcutResult = { ok: true; state: CaptureState } | { ok: false; error: 'invalid' | 'taken' }

interface BackupState {
  frequency: BackupFrequency
  folder: string
  defaultFolder: string
  custom: boolean
  encrypt: boolean
  lastAutomatic: number | null
  due: boolean
  /** False when the system keychain cannot protect a saved password. */
  canEncrypt: boolean
}

interface SpellingState {
  /** False on macOS, which uses the system spell checker. */
  supported: boolean
  bundled: string[]
  added: string[]
}

type SpellingError = 'name' | 'bundled' | 'size' | 'format' | 'link' | 'download' | 'busy' | 'locked'

interface SpellingResult {
  state: SpellingState
  added: string[]
  error?: SpellingError
  /** The download was redirected to plain http on the way. */
  insecure?: boolean
}

type DesktopUpdateResult = { ok: true; canceled?: boolean } | { ok: false; message: string }

interface DesktopUpdateProgress {
  tag: string
  received: number
  total: number
  bytesPerSecond: number
}

interface Window {
  newWorldDesktop?: {
    platform: string
    arch: string
    reportReady: () => void
    onSettingsRequested: (listener: () => void) => void
    getLanguage: () => Promise<import('../shared/language-packs.mjs').LanguagePack>
    setLanguage: (locale: import('../shared/language-packs.mjs').Locale) => Promise<import('../shared/language-packs.mjs').LanguagePack>
    reloadForLanguage: () => Promise<void>
    downloadUpdate: (tag: string) => Promise<DesktopUpdateResult>
    installUpdate: (tag: string) => Promise<DesktopUpdateResult>
    onUpdateProgress: (listener: (progress: DesktopUpdateProgress) => void) => void
    openProject?: () => Promise<{ name: string; bytes: Uint8Array } | null>
    readProject?: (token: string) => Promise<{ name: string; bytes: Uint8Array }>
    saveProject?: (name: string, bytes: Uint8Array) => Promise<boolean>
    savePdf: (name: string) => Promise<void>
    onCloseRequested: (save: () => Promise<boolean>) => void
    getStorageLocation: () => Promise<StorageState>
    setStorageLocation: () => Promise<StorageResult | null>
    resetStorageLocation: () => Promise<StorageResult | null>
    getLoginItem?: () => Promise<LoginItemState>
    setLoginItem?: (enabled: boolean) => Promise<LoginItemState>
    getCloseBehavior: () => Promise<CloseBehavior>
    setCloseBehavior: (mode: CloseBehavior) => Promise<CloseBehavior>
    setWindowTheme?: (theme: import('./appearance').Theme) => Promise<void>
    minimizeWindow: () => void
    toggleMaximizeWindow: () => void
    closeWindow: () => void
    isMaximized: () => Promise<boolean>
    onMaximizeChange: (listener: (maximized: boolean) => void) => void
    /** Leaves full screen; the header shows this button in place of minimise and maximise. */
    exitFullScreen?: () => void
    isFullScreen?: () => Promise<boolean>
    onFullScreenChange?: (listener: (fullScreen: boolean) => void) => void
    getCaptureState?: () => Promise<CaptureState>
    setCaptureShortcut?: (shortcut: string) => Promise<CaptureShortcutResult>
    hideCapture?: () => Promise<void>
    onCaptureShown?: (listener: () => void) => void
    setRecentWorks?: (works: { title: string; hash: string }[]) => Promise<void>
    /** Opens a separate window that shows one reading route (#/compare/…) and nothing else. */
    openReadingWindow?: (hash: string) => Promise<void>
    /** Private web panes (main window only); see desktop/web-pane.cjs. */
    web?: (action: WebPaneAction, id: string, ...args: unknown[]) => Promise<any>
    onWebState?: (listener: (state: WebPaneState) => void) => void
    onWebKeep?: (listener: (entry: WebKeepEntry) => void) => void
    onCommand?: (listener: (command: DesktopCommand) => void) => void
    getBackupState?: () => Promise<BackupState>
    setBackupFrequency?: (frequency: BackupFrequency) => Promise<BackupState>
    chooseBackupFolder?: () => Promise<BackupState | null>
    resetBackupFolder?: () => Promise<BackupState>
    setBackupPassword?: (password: string | null) => Promise<BackupState>
    getBackupPassword?: () => Promise<string | null>
    saveBackup?: (name: string, bytes: Uint8Array, automatic: boolean) => Promise<{ path: string; state: BackupState }>
    openBackup?: () => Promise<{ name: string; bytes: Uint8Array } | null>
    showBackupFolder?: () => Promise<void>
    getSpellingDictionaries?: () => Promise<SpellingState>
    importSpellingDictionaries?: () => Promise<SpellingResult>
    downloadSpellingDictionary?: (link: string) => Promise<SpellingResult>
    removeSpellingDictionary?: (language: string) => Promise<SpellingState>
    aiProvider: import('../shared/ai-provider/types.mjs').AiProviderDesktopBridge
    getAiState?: () => Promise<AiSettingsState>
    setAiEnabled?: (enabled: boolean) => Promise<AiSettingsState>
    setAiPort?: (port: number) => Promise<AiSettingsState>
    createAiClient?: (input: Partial<Pick<AiClientSummary, 'name' | 'enabled' | 'permissions' | 'scope'>>) => Promise<AiClientCreateResult>
    updateAiClient?: (id: string, patch: Partial<Pick<AiClientSummary, 'name' | 'enabled' | 'permissions' | 'scope'>>) => Promise<{ state: AiSettingsState; client: AiClientSummary }>
    rotateAiToken?: (id: string) => Promise<AiClientCreateResult>
    deleteAiClient?: (id: string) => Promise<AiSettingsState>
    listAiAudit?: (limit?: number) => Promise<AiAuditEntry[]>
    clearAiAudit?: () => Promise<AiAuditEntry[]>
    onAiDispatch?: (handler: (packet: AiDispatchPacket) => void) => () => void
    sendAiDispatchResult?: (callId: string, result: unknown) => void
    onAiConfirmOpen?: (handler: (request: AiConfirmRequest) => void) => () => void
    onAiConfirmClose?: (handler: (detail: { confirmationId: string; reason: string }) => void) => () => void
    sendAiConfirmDecision?: (confirmationId: string, approved: boolean) => Promise<{ ok: boolean; status: string }>
  }
}

interface AiPermissions {
  create: boolean
  read: boolean
  update: boolean
  delete: boolean
}

type AiScopeMode = 'none' | 'selected' | 'all'

interface AiScope {
  mode: AiScopeMode
  workIds: string[]
}

interface AiClientSummary {
  id: string
  name: string
  enabled: boolean
  tokenPrefix: string
  permissions: AiPermissions
  scope: AiScope
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

interface AiBridgeStatus {
  running: boolean
  enabled: boolean
  host: string
  configuredPort: number
  port: number
  error: string | null
  pendingConfirmations: number
}

interface AiSettingsState {
  version: number
  enabled: boolean
  port: number
  clients: AiClientSummary[]
  bridge: AiBridgeStatus
}

interface AiClientCreateResult {
  state: AiSettingsState
  client: AiClientSummary
  token: string
}

interface AiAuditEntry {
  id: string
  timestamp: number
  clientId: string | null
  clientName: string | null
  method: string
  path: string
  action: string
  outcome: string
  statusCode: number
  targetSummary: string
  confirmId: string | null
  reason: string
}

interface AiConfirmImpact {
  kind: 'work' | 'edition' | 'chapter' | 'source' | 'idea' | 'destructive_update'
  library?: 'original' | 'reference'
  bookId?: string
  bookTitle?: string
  editionId?: string
  editionTitle?: string
  chapterId?: string
  chapterTitle?: string
  sourceId?: string
  sourceName?: string
  ideaId?: string
  ideaPreview?: string
  affectedChapters?: number
  affectedWords?: number
  beforeWords?: number
  afterWords?: number
  lostWords?: number
  summary: string
}

interface AiConfirmRequest {
  confirmationId: string
  clientId: string
  clientName: string
  action: string
  impact: AiConfirmImpact
  expiresAt: number
}

interface AiDispatchPacket {
  callId: string
  payload: Record<string, unknown>
}

type WebPaneAction = 'create' | 'navigate' | 'back' | 'forward' | 'reload' | 'stop' | 'place' | 'capture' | 'selection' | 'pageText' | 'keep' | 'focus' | 'openOutside' | 'state' | 'close'

interface WebPaneState {
  id: string
  closed?: boolean
  url?: string
  title?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  focused?: boolean
  blocked?: string
  error?: { kind: 'certificate' | 'failed'; code: number; description: string; url: string }
}

interface WebKeepEntry {
  type: 'web-keep'
  kind: 'idea' | 'task'
  id: string
  text: string
  title: string
  url: string
}
