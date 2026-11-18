import { enqueueProject, mountProjectImports } from './projects/view'
import { mountTaskReminders } from './tasks/reminders'
import { t } from './i18n'
import { renderContinuation } from './continuation-view'
import { renderReader } from './reader-view'
import { renderHome, renderShelf } from './shelf-view'
import { hasTrashSince } from './trash'
import { renderTrash } from './trash-view'
import { renderArchive } from './archive-view'
import { backUpToFolder, restoredNotice, startAutomaticBackups } from './backup-view'
import { renderIdeas } from './ideas-view'
import { openCaptureDialog } from './idea-capture'
import { addIdea, lastWork, recentWorks, rememberWork } from './ideas'
import { showNotice } from './undo'
import { mountSettingsView, parseSettingsCategory } from './settings-view'
import { mountAiDesktopHost } from './ai/desktop-host'
import { changeView } from './motion'
import { libraries, notice } from './ui'
import { mountWindowControls } from './window-controls'
import { libraryChanges, listBooks, storageError } from './library'
import type { LibraryId } from './library'
import { renderTasks } from './tasks/view'
import { mountWebVersionCheck } from './web-version'
import { mountWebStorage } from './web-storage'
import { mountFolderSync } from './web-folder'

for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = t(node.dataset.i18n!)
for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-label]')) node.setAttribute('aria-label', t(node.dataset.i18nLabel!))
document.querySelector('meta[name="description"]')?.setAttribute('content', t('app.description'))

const main = document.querySelector<HTMLElement>('#main')!
const page = document.querySelector<HTMLElement>('#page')!
const settingsEntry = document.querySelector<HTMLAnchorElement>('#settings')!
const trashLink = document.querySelector<HTMLAnchorElement>('#trash-link')!
const trashDot = document.querySelector<HTMLElement>('#trash-unread')!
const trashRoute = /^#\/trash\/?$/
const trashViewedKey = 'new-world:trash-last-viewed'
// The desktop window has no system title bar. The app header takes its place and the page scrolls below it.
if (window.newWorldDesktop) {
  document.documentElement.classList.add('desktop')
  if (window.newWorldDesktop.platform === 'darwin') document.documentElement.classList.add('macos')
}
mountWindowControls()
let view: AbortController | undefined
let leaveGuard: (() => Promise<boolean>) | undefined
let activeHash = location.hash
let navigation = 0
let trashViewedAt = 0
let trashRequest = 0

function lastTrashView() {
  try {
    const saved = Number(localStorage.getItem(trashViewedKey))
    if (Number.isFinite(saved)) return Math.max(trashViewedAt, saved)
  } catch { /* Fall back to the timestamp for this session. */ }
  return trashViewedAt
}

function markTrashViewed(time: number) {
  trashViewedAt = Math.max(time, lastTrashView())
  try { localStorage.setItem(trashViewedKey, String(trashViewedAt)) } catch { /* The view is remembered for this session. */ }
}

function showTrashDot(unread: boolean) {
  trashDot.hidden = !unread
  if (unread) trashLink.setAttribute('aria-describedby', trashDot.id)
  else trashLink.removeAttribute('aria-describedby')
}

async function refreshTrashIndicator() {
  const request = ++trashRequest
  if (trashRoute.test(activeHash)) { showTrashDot(false); return }
  const unread = await hasTrashSince(lastTrashView()).catch(() => false)
  if (request === trashRequest) showTrashDot(unread)
}

const saveBeforeLeaving = async () => !leaveGuard || await leaveGuard()
if (window.newWorldDesktop) {
  window.newWorldDesktop.onCloseRequested(saveBeforeLeaving)
}
const settings = mountSettingsView(saveBeforeLeaving, (hash) => {
  if (location.hash !== hash) location.hash = hash
})

mountProjectImports(async () => !settings.isLocked() && await saveBeforeLeaving())

settingsEntry.addEventListener('click', (event) => {
  if (settings.isLocked()) { event.preventDefault(); return }
  const currentCategory = parseSettingsCategory(activeHash)
  if (currentCategory && currentCategory !== 'general') return
  if (currentCategory) event.preventDefault()
})

function render(moveFocus = false) {
  view?.abort()
  const scope = new AbortController()
  view = scope
  leaveGuard = undefined
  main.replaceChildren()
  main.classList.remove('mode-original', 'mode-reference', 'settings-main', 'home-main')
  const settingsCategory = parseSettingsCategory(activeHash)
  document.documentElement.classList.toggle('settings-open', Boolean(settingsCategory))
  if (settingsCategory) settingsEntry.setAttribute('aria-current', 'page')
  else settingsEntry.removeAttribute('aria-current')

  const match = activeHash.match(/^#\/(original|reference)(?:\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}|original))?)?\/?$/)
  let handledFocus = false
  if (settingsCategory) {
    const canonical = `#/settings/${settingsCategory}`
    if (activeHash !== canonical) {
      activeHash = canonical
      history.replaceState(null, '', canonical)
    }
    main.classList.add('settings-main')
    main.append(settings.element)
    handledFocus = settings.showCategory(settingsCategory, false)
  } else if (match) {
    const library = match[1] as LibraryId
    main.classList.add(`mode-${library}`)
    document.title = `${libraries[library].name} · New World`
    if (match[2]) {
      rememberWork({ library, bookId: match[2] })
      void reportRecentWorks()
    }
    if (library === 'reference' && match[2] && !match[3]) renderContinuation(main, match[2], scope.signal)
    else if (match[2]) void renderReader(main, library, match[2], match[3] === 'original' ? undefined : match[3], scope.signal, (guard) => {
      if (view === scope) leaveGuard = guard
    })
    else renderShelf(main, library, view.signal)
  } else if (/^#\/tasks(?:\/.*)?$/.test(activeHash)) {
    document.title = t('tasks.workspace') + ' · New World'
    renderTasks(main, view.signal)
  } else if (/^#\/ideas\/?$/.test(activeHash)) {
    document.title = t('ideas.pageTitle')
    renderIdeas(main, view.signal)
  } else if (/^#\/archive\/?$/.test(activeHash)) {
    document.title = t('archive.pageTitle')
    renderArchive(main, view.signal)
  } else if (trashRoute.test(activeHash)) {
    document.title = t('main.trashNewWorld')
    renderTrash(main, view.signal, markTrashViewed)
  } else {
    main.classList.add('home-main')
    document.title = t('main.newWorldNovelLibrary')
    renderHome(main, view.signal)
  }
  if (moveFocus) {
    window.scrollTo(0, 0)
    page.scrollTo(0, 0)
    if (!handledFocus) main.focus({ preventScroll: true })
  }
  void refreshTrashIndicator()
}

document.querySelector('.skip-link')?.addEventListener('click', (event) => {
  event.preventDefault()
  main.focus()
})
window.addEventListener('hashchange', async () => {
  const target = location.hash
  const request = ++navigation
  if (target === activeHash) return
  const fromSettings = parseSettingsCategory(activeHash)
  const toSettings = parseSettingsCategory(target)
  if (fromSettings && settings.isLocked()) {
    history.replaceState(null, '', activeHash || '#/')
    return
  }
  if (fromSettings && toSettings) {
    const canonical = `#/settings/${toSettings}`
    if (target !== canonical) history.replaceState(null, '', canonical)
    activeHash = canonical
    settings.showCategory(toSettings, true)
    page.scrollTo(0, 0)
    return
  }
  const allowed = !leaveGuard || await leaveGuard()
  if (request !== navigation || location.hash !== target) return
  if (!allowed) {
    history.replaceState(null, '', activeHash || '#/')
    return
  }
  const previous = activeHash
  if (!fromSettings && toSettings) settings.recordOrigin(previous)
  activeHash = target
  changeView(main, previous, target, () => render(true))
})
render()
const restored = restoredNotice()
if (restored && !parseSettingsCategory(activeHash)) main.prepend(notice(restored))
libraryChanges.addEventListener('update', () => { void refreshTrashIndicator() })
window.addEventListener('focus', () => { void refreshTrashIndicator() })
window.addEventListener('storage', (event) => { if (event.key === trashViewedKey) void refreshTrashIndicator() })
mountAiDesktopHost()
mountTaskReminders()
mountWebVersionCheck(saveBeforeLeaving)
mountWebStorage()
void mountFolderSync()
window.newWorldDesktop?.reportReady?.()
startAutomaticBackups()

// The tray menu lists the works opened last.
async function reportRecentWorks() {
  const desktop = window.newWorldDesktop
  if (!desktop?.setRecentWorks) return
  try {
    const books = [...await listBooks('original'), ...await listBooks('reference')]
    const recent = recentWorks().flatMap((work) => {
      const book = books.find((item) => item.library === work.library && item.id === work.bookId && !item.workId)
      return book ? [{ title: book.title, hash: `#/${book.library}/${book.id}` }] : []
    })
    await desktop.setRecentWorks(recent)
  } catch { /* The tray keeps its previous list. */ }
}
libraryChanges.addEventListener('update', () => { void reportRecentWorks() })
void reportRecentWorks()

// Commands from the tray and the desktop right-click menu.
window.newWorldDesktop?.onCommand?.((command) => {
  if (command.type === 'project') {
    void enqueueProject(async () => {
      const file = await window.newWorldDesktop!.readProject!(command.token)
      return new Blob([Uint8Array.from(file.bytes)])
    })
  } else if (command.type === 'open') location.hash = command.hash
  else if (command.type === 'ideas') location.hash = '#/ideas'
  else if (command.type === 'new-novel') {
    try { sessionStorage.setItem('new-world:new-novel', '1') } catch { /* The library still opens. */ }
    if (location.hash === '#/original') render()
    else location.hash = '#/original'
  } else if (command.type === 'backup') {
    void backUpToFolder().then((text) => showNotice(text), (error) => showNotice(storageError(error)))
  } else if (command.type === 'idea') {
    void addIdea(command.text, lastWork()).then(() => showNotice(t('ideas.savedSelection')), (error) => showNotice(storageError(error)))
  }
})

// The web version has no global shortcut, so the same keys work while the page has focus.
if (!window.newWorldDesktop) {
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey && event.code === 'KeyN' && !document.querySelector('dialog[open]')) {
      event.preventDefault()
      openCaptureDialog()
    }
  })
}
