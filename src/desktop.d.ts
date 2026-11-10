interface Window {
  newWorldDesktop?: {
    openInstaller: (tag: string) => Promise<void>
    savePdf: (name: string) => Promise<void>
    onCloseRequested: (save: () => Promise<boolean>) => void
  }
}
