import { locale, t } from './i18n'
import { formDialog } from './dialogs'
import { BackupError, backupName, createBackup, isEncrypted, readBackup, restoreBackup } from './backup'
import type { BackupContents } from './backup'
import { storageError } from './library'
import { button, element } from './ui'

const frequencies: BackupFrequency[] = ['off', 'daily', 'weekly']
const webEncryptKey = 'new-world:backup-encrypt'
let automaticFailure = ''
let running: Promise<unknown> | undefined

function when(time: number) {
  return new Date(time).toLocaleString(locale, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function passwordField(label: string, name: string) {
  const field = element('label', 'field-label', label)
  const input = element('input', 'title-input')
  input.type = 'password'
  input.name = name
  input.required = true
  input.maxLength = 256
  input.autocomplete = 'new-password'
  input.spellcheck = false
  field.append(input)
  return field
}

/** Asks for a new password twice. Resolves with it, or null when cancelled. */
function choosePassword(title: string) {
  return new Promise<string | null>((resolve) => {
    let chosen: string | null = null
    formDialog(document.body, {
      title, action: t('backup.setPassword'), description: t('backup.passwordHint'),
      fields: [passwordField(t('backup.password'), 'password'), passwordField(t('backup.confirmPassword'), 'confirm')],
    }, async (data) => {
      const password = String(data.get('password'))
      if (password !== String(data.get('confirm'))) throw new Error(t('backup.passwordsDiffer'))
      chosen = password
    })
    const dialog = document.body.lastElementChild as HTMLDialogElement
    dialog.addEventListener('close', () => resolve(chosen), { once: true })
  })
}

/** Builds a backup with the current encryption setting. */
async function build(password: string | null) {
  return createBackup(password ?? undefined)
}

async function desktopPassword(state: BackupState) {
  if (!state.encrypt) return null
  const password = await window.newWorldDesktop!.getBackupPassword!()
  if (!password) throw new Error(t('backup.passwordMissing'))
  return password
}

/** Writes an automatic backup on the desktop when one is due. Runs at start and every few minutes. */
export function startAutomaticBackups() {
  const desktop = window.newWorldDesktop
  if (!desktop?.getBackupState) return
  const check = async () => {
    if (running) return
    try {
      const state = await desktop.getBackupState!()
      if (!state.due) return
      running = (async () => {
        const { blob } = await build(await desktopPassword(state))
        await desktop.saveBackup!(backupName(new Date(), 'auto-backup'), new Uint8Array(await blob.arrayBuffer()), true)
        automaticFailure = ''
        window.dispatchEvent(new CustomEvent('new-world:backup-change'))
      })()
      await running
    } catch (error) {
      automaticFailure = storageError(error)
      window.dispatchEvent(new CustomEvent('new-world:backup-change'))
    } finally {
      running = undefined
    }
  }
  window.setTimeout(() => void check(), 20_000)
  window.setInterval(() => void check(), 10 * 60 * 1000)
}

export function mountBackupView(section: HTMLElement, saveBeforeLeaving: () => Promise<boolean>, setBusy: (busy: boolean) => void) {
  const desktop = window.newWorldDesktop?.getBackupState ? window.newWorldDesktop : undefined
  let state: BackupState | undefined

  const heading = (text: string) => element('h4', 'appearance-heading', text)
  const radios = <T extends string>(label: string, name: string, values: readonly T[], text: (value: T) => string) => {
    const group = element('div', 'settings-options choice-options')
    group.setAttribute('role', 'radiogroup')
    group.setAttribute('aria-label', label)
    const inputs = values.map((value) => {
      const item = element('label', 'settings-option')
      const input = element('input')
      input.type = 'radio'
      input.name = name
      input.value = value
      item.append(input, element('span', '', text(value)))
      group.append(item)
      return input
    })
    return { group, inputs }
  }

  const frequencyText = (value: BackupFrequency) => ({ off: t('backup.off'), daily: t('backup.daily'), weekly: t('backup.weekly') })[value]
  const frequency = radios(t('backup.automatic'), 'backup-frequency', frequencies, frequencyText)

  const location = element('div', 'storage-location-box backup-location')
  const locationBadge = element('span', 'storage-badge')
  const locationPath = element('code', 'storage-path')
  location.append(locationBadge, locationPath)
  const chooseFolder = button(t('backup.chooseFolder'), 'button button-quiet button-small')
  const resetFolder = button(t('backup.defaultFolder'), 'button button-quiet button-small')
  const showFolder = button(t('backup.showFolder'), 'button button-quiet button-small')
  const folderActions = element('div', 'settings-actions')
  folderActions.append(chooseFolder, resetFolder, showFolder)

  const encryption = radios(t('backup.encryption'), 'backup-encryption', ['plain', 'encrypted'] as const,
    (value) => value === 'plain' ? t('backup.plain') : t('backup.encrypted'))
  encryption.group.classList.remove('choice-options')
  const changePassword = button(t('backup.changePassword'), 'button button-quiet button-small')

  const last = element('p', 'dialog-help backup-last')
  const backupNow = button(t('backup.now'), 'button button-primary', 'backup')
  const restore = button(t('backup.restore'), 'button button-quiet', 'undo')
  const actions = element('div', 'settings-actions')
  actions.append(backupNow, restore)
  const status = element('p', 'settings-state backup-state')
  status.setAttribute('role', 'status')
  const error = element('p', 'field-error')
  error.setAttribute('role', 'alert')
  error.hidden = true

  if (desktop) {
    section.append(heading(t('backup.automatic')), frequency.group, heading(t('backup.location')), location, folderActions)
  }
  section.append(heading(t('backup.encryption')), encryption.group, changePassword, last, actions, status, error,
    element('p', 'dialog-help', desktop ? t('backup.desktopHint', [10]) : t('backup.webHint')))

  function fail(cause: unknown) {
    status.textContent = ''
    error.textContent = cause instanceof BackupError ? cause.message : storageError(cause)
    error.hidden = false
  }

  function paint() {
    const webEncrypted = (() => { try { return localStorage.getItem(webEncryptKey) === '1' } catch { return false } })()
    const encrypted = desktop ? Boolean(state?.encrypt) : webEncrypted
    for (const input of encryption.inputs) input.checked = input.value === (encrypted ? 'encrypted' : 'plain')
    changePassword.hidden = !desktop || !encrypted
    if (!desktop) {
      last.hidden = true
      return
    }
    for (const input of frequency.inputs) {
      input.checked = input.value === state?.frequency
      input.disabled = !state
    }
    for (const input of encryption.inputs) input.disabled = !state || (input.value === 'encrypted' && !state.canEncrypt && !state.encrypt)
    locationBadge.textContent = state?.custom ? t('backup.customBadge') : t('backup.defaultBadge')
    locationPath.textContent = state?.folder ?? ''
    resetFolder.disabled = !state?.custom
    last.hidden = false
    last.textContent = automaticFailure
      ? t('backup.automaticFailed', [automaticFailure])
      : state?.lastAutomatic ? t('backup.lastAutomatic', [when(state.lastAutomatic)]) : t('backup.noAutomaticYet')
    last.classList.toggle('field-error', Boolean(automaticFailure))
  }

  async function refresh() {
    if (desktop) {
      try { state = await desktop.getBackupState!() } catch (cause) { fail(cause) }
    }
    paint()
  }

  async function task(work: () => Promise<void>) {
    setBusy(true)
    error.hidden = true
    try {
      await work()
    } catch (cause) {
      fail(cause)
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  for (const input of frequency.inputs) {
    input.addEventListener('change', () => void task(async () => {
      state = await desktop!.setBackupFrequency!(input.value as BackupFrequency)
      status.textContent = t('editor.saved')
    }))
  }
  chooseFolder.addEventListener('click', () => void task(async () => {
    const next = await desktop!.chooseBackupFolder!()
    if (next) { state = next; status.textContent = t('backup.folderChanged') }
  }))
  resetFolder.addEventListener('click', () => void task(async () => {
    state = await desktop!.resetBackupFolder!()
    status.textContent = t('backup.folderChanged')
  }))
  showFolder.addEventListener('click', () => void task(async () => { await desktop!.showBackupFolder!() }))

  async function enableEncryption() {
    const password = await choosePassword(t('backup.setPasswordTitle'))
    if (password === null) return paint()
    await task(async () => {
      state = await desktop!.setBackupPassword!(password)
      status.textContent = t('backup.encryptionOn')
    })
  }
  for (const input of encryption.inputs) {
    input.addEventListener('change', () => {
      const encrypt = input.value === 'encrypted'
      if (!desktop) {
        try { localStorage.setItem(webEncryptKey, encrypt ? '1' : '0') } catch { /* Asked again next time. */ }
        status.textContent = encrypt ? t('backup.encryptionOnWeb') : t('backup.encryptionOff')
        return paint()
      }
      if (encrypt) return void enableEncryption()
      void task(async () => {
        state = await desktop.setBackupPassword!(null)
        status.textContent = t('backup.encryptionOff')
      })
    })
  }
  changePassword.addEventListener('click', () => void enableEncryption())

  backupNow.addEventListener('click', () => void (async () => {
    let password: string | null = null
    if (!desktop && encryption.inputs[1]!.checked) {
      password = await choosePassword(t('backup.passwordForBackup'))
      if (password === null) return
    }
    await task(async () => {
      status.textContent = t('backup.working')
      if (!await saveBeforeLeaving()) throw new Error(t('settings.languageSaveRequired'))
      const name = backupName(new Date())
      if (desktop) {
        const { blob, summary } = await build(await desktopPassword(state ?? await desktop.getBackupState!()))
        const saved = await desktop.saveBackup!(name, new Uint8Array(await blob.arrayBuffer()), false)
        state = saved.state
        status.textContent = t('backup.saved', [summary.works, saved.path])
      } else {
        const { blob, summary } = await build(password)
        const url = URL.createObjectURL(blob)
        const anchor = element('a')
        anchor.href = url
        anchor.download = name
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
        status.textContent = t('backup.downloaded', [summary.works, name])
      }
    })
  })())

  function confirmRestore(contents: BackupContents) {
    const { summary } = contents
    formDialog(document.body, {
      title: t('backup.restoreTitle'), action: t('backup.restoreConfirm'), danger: true,
      description: t('backup.restoreDescription', [when(summary.createdAt), summary.works, summary.chapters])
        + (desktop ? ` ${t('backup.restoreSafety')}` : ` ${t('backup.restoreWebWarning')}`),
    }, async () => {
      setBusy(true)
      try {
        if (!await saveBeforeLeaving()) throw new Error(t('settings.languageSaveRequired'))
        if (desktop) {
          const current = state ?? await desktop.getBackupState!()
          const { blob } = await build(await desktopPassword(current))
          await desktop.saveBackup!(backupName(new Date(), 'before-restore'), new Uint8Array(await blob.arrayBuffer()), false)
        }
        await restoreBackup(contents)
        try { sessionStorage.setItem('new-world:restored', String(summary.works)) } catch { /* Only the notice is lost. */ }
        // Start again from the home page without leaving through the current view, which no longer exists.
        history.replaceState(null, '', '#/')
        if (desktop?.reloadForLanguage) await desktop.reloadForLanguage()
        else window.location.reload()
      } finally {
        setBusy(false)
      }
    })
  }

  async function open(file: Blob) {
    error.hidden = true
    if (await isEncrypted(file)) {
      formDialog(document.body, {
        title: t('backup.enterPasswordTitle'), action: t('backup.open'), description: t('backup.enterPasswordHint'),
        fields: [passwordField(t('backup.password'), 'password')],
      }, async (data) => {
        const contents = await readBackup(file, String(data.get('password')))
        window.setTimeout(() => confirmRestore(contents))
      })
      return
    }
    confirmRestore(await readBackup(file))
  }

  // The web version picks the file with a file input that exists only while the picker is open.
  function pickFile() {
    const input = element('input')
    input.type = 'file'
    input.accept = '.zip,application/zip'
    input.hidden = true
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      input.remove()
      if (file) void task(() => open(file))
    })
    input.addEventListener('cancel', () => input.remove())
    section.append(input)
    input.click()
  }

  restore.addEventListener('click', () => {
    if (!desktop) return pickFile()
    void task(async () => {
      const picked = await desktop.openBackup!()
      if (picked) await open(new Blob([picked.bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }))
    })
  })

  window.addEventListener('new-world:backup-change', () => void refresh())
  void refresh()
  return refresh
}

/** After a restore the page reloads; this tells the reader it worked. */
export function restoredNotice() {
  try {
    const works = sessionStorage.getItem('new-world:restored')
    if (works === null) return null
    sessionStorage.removeItem('new-world:restored')
    return t('backup.restored', [works])
  } catch {
    return null
  }
}
