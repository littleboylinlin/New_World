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

type DesktopUpdateResult = { ok: true } | { ok: false; message: string }

interface DesktopUpdateProgress {
  tag: string
  received: number
  total: number
}

interface Window {
  newWorldDesktop?: {
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
  }
}
