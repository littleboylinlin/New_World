declare const __BUILD_ID__: string

type FolderPermission = 'granted' | 'denied' | 'prompt'

interface FileSystemHandle {
  queryPermission?(options: { mode: 'read' | 'readwrite' }): Promise<FolderPermission>
  requestPermission?(options: { mode: 'read' | 'readwrite' }): Promise<FolderPermission>
}

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>
}

interface Window {
  showDirectoryPicker?(options?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }): Promise<FileSystemDirectoryHandle>
}
