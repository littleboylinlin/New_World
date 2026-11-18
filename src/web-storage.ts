import { t } from './i18n'
import { cornerTip } from './corner-tips'
import { downloadFile } from './ui'
import { listBooks } from './library'
import type { Book } from './library'
import { exportProject } from './projects/store'

const lastExportKey = 'new-world:last-export'
const reminderKey = 'new-world:backup-reminder'
const noticeKey = 'new-world:web-notice-seen'
export const backupReminderDays = 7
const dayMs = 24 * 60 * 60 * 1000
export const desktopDownloadUrl = 'https://writenewworld.com/'

function read(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}
function write(key: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } catch { /* Kept for this visit only. */ }
}

/** Asks the browser not to evict the library under storage pressure. Null where the API is missing. */
export async function requestPersistence(): Promise<boolean | null> {
  if (window.newWorldDesktop || !navigator.storage?.persist) return null
  try {
    return await navigator.storage.persisted() || await navigator.storage.persist()
  } catch {
    return false
  }
}

export async function persistenceState(): Promise<boolean | null> {
  if (window.newWorldDesktop || !navigator.storage?.persisted) return null
  try { return await navigator.storage.persisted() } catch { return false }
}

/** Any copy that leaves the browser counts: a project export, a full backup or a folder write. */
export function recordExport(time = Date.now()) {
  write(lastExportKey, String(time))
}

export function backupReminderEnabled() {
  return read(reminderKey) !== 'off'
}

export const reminderChanges = new EventTarget()

export function setBackupReminder(enabled: boolean) {
  write(reminderKey, enabled ? null : 'off')
  reminderChanges.dispatchEvent(new Event('change'))
}

function filename(book: Book) {
  return `${book.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'New World'}.newworld`
}

async function works() {
  return [...await listBooks('original'), ...await listBooks('reference')].filter((book) => !book.workId)
}

/** Downloads every work as its own .newworld file. */
export async function downloadAllWorks() {
  const roots = await works()
  for (const book of roots) downloadFile(await exportProject({ library: book.library, id: book.id }), filename(book))
  recordExport()
  return roots.length
}

let reminding = false
async function checkReminder() {
  if (reminding || document.hidden || !backupReminderEnabled()) return
  const now = Date.now()
  const last = Number(read(lastExportKey))
  if (!last) {
    // The clock starts with the first visit, not at the epoch.
    if ((await works()).length) recordExport(now)
    return
  }
  const snoozed = Number(read(`${reminderKey}:dismissed`))
  if (now - last < backupReminderDays * dayMs || (snoozed && now - snoozed < backupReminderDays * dayMs)) return
  if (!(await works()).length) return
  reminding = true
  const tip = cornerTip('backup', t('webBackup.reminder', [Math.floor((now - last) / dayMs)]), [
    {
      label: t('webBackup.export'), primary: true,
      run: async () => {
        await downloadAllWorks()
        tip.remove()
        reminding = false
      },
    },
    {
      label: t('webBackup.never'),
      run: () => { setBackupReminder(false); tip.remove(); reminding = false },
    },
  ], () => { write(`${reminderKey}:dismissed`, String(Date.now())); reminding = false })
}

function showFirstVisitNotice() {
  if (read(noticeKey)) return
  const tip = cornerTip('web-notice', t('webStorage.notice'), [
    { label: t('webStorage.getDesktop'), run: () => { window.open(desktopDownloadUrl, '_blank', 'noopener') } },
    { label: t('webStorage.understood'), primary: true, run: () => { write(noticeKey, '1'); tip.remove() } },
  ], () => write(noticeKey, '1'))
}

export function mountWebStorage() {
  if (window.newWorldDesktop) return
  void requestPersistence()
  showFirstVisitNotice()
  void checkReminder().catch(() => {})
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkReminder().catch(() => {}) })
}
