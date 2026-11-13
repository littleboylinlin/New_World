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

interface SpellingState {
  /** False on macOS, which uses the system spell checker. */
  supported: boolean
  bundled: string[]
  added: string[]
}

type SpellingError = 'name' | 'bundled' | 'size' | 'format' | 'link' | 'download' | 'busy'

interface SpellingResult {
  state: SpellingState
  added: string[]
  error?: SpellingError
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
    getSpellingDictionaries?: () => Promise<SpellingState>
    importSpellingDictionaries?: () => Promise<SpellingResult>
    downloadSpellingDictionary?: (link: string) => Promise<SpellingResult>
    removeSpellingDictionary?: (language: string) => Promise<SpellingState>
  }
}
