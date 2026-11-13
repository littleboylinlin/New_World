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

type CloseBehavior = 'quit' | 'background'

type BackupFrequency = 'off' | 'daily' | 'weekly'

type DesktopCommand = { type: 'open'; hash: string } | { type: 'ideas' } | { type: 'new-novel' } | { type: 'backup' } | { type: 'idea'; text: string }

interface CaptureState {
  shortcut: string
  options: string[]
  /** How each shortcut is written on this platform. */
  labels: Record<string, string>
  /** False when another app already holds the shortcut. */
  registered: boolean
}

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
    savePdf: (name: string) => Promise<void>
    onCloseRequested: (save: () => Promise<boolean>) => void
    getStorageLocation: () => Promise<StorageState>
    setStorageLocation: () => Promise<StorageResult | null>
    resetStorageLocation: () => Promise<StorageResult | null>
    getCloseBehavior: () => Promise<CloseBehavior>
    setCloseBehavior: (mode: CloseBehavior) => Promise<CloseBehavior>
    setWindowTheme?: (theme: import('./appearance').Theme) => Promise<void>
    minimizeWindow: () => void
    toggleMaximizeWindow: () => void
    closeWindow: () => void
    isMaximized: () => Promise<boolean>
    onMaximizeChange: (listener: (maximized: boolean) => void) => void
    getCaptureState?: () => Promise<CaptureState>
    setCaptureShortcut?: (shortcut: string) => Promise<CaptureState>
    hideCapture?: () => Promise<void>
    onCaptureShown?: (listener: () => void) => void
    setRecentWorks?: (works: { title: string; hash: string }[]) => Promise<void>
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
  }
}
