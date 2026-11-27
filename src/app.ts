import { introReady } from './intro'
import { writingFilter } from './navigation-preferences'
import { enqueueProject, mountProjectImports } from './projects/view'
import { mountTaskReminders } from './tasks/reminders'
import { t } from './i18n'
import { renderContinuation } from './continuation-view'
import { renderReader } from './reader-view'
import { renderHome, renderShelf } from './shelf-view'
import { renderTrash } from './trash-view'
import { renderArchive } from './archive-view'
import { backUpToFolder, restoredNotice, startAutomaticBackups } from './backup-view'
import { mountNotes, notesPath } from './notes-view'
import { mountSidebar } from './sidebar'
import { openCaptureDialog } from './idea-capture'
import { addIdea, lastWork, recentWorks } from './ideas'
import { showNotice } from './undo'
import { mountSettingsView, parseSettingsCategory } from './settings-view'
import { mountAiDesktopHost } from './ai/desktop-host'
import { changeView } from './motion'
import { libraries, notice } from './ui'
import { mountWindowControls } from './window-controls'
import { libraryChanges, listBooks, storageError } from './library'
import type { LibraryId } from './library'
import { mountWebVersionCheck } from './web-version'
import { mountWebStorage } from './web-storage'
import { mountFolderSync } from './web-folder'
import { takeStoryJump } from './ai/story-jump'
import { handleStoryWebRequests } from './ai/story-web-provider'
import { parseForeshadowingPath } from './foreshadowing/route'
import { renderForeshadowing } from './foreshadowing/view'

handleStoryWebRequests()

for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = t(node.dataset.i18n!)
for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-label]')) node.setAttribute('aria-label', t(node.dataset.i18nLabel!))
document.querySelector('meta[name="description"]')?.setAttribute('content', t('app.description'))

const main = document.querySelector<HTMLElement>('#main')!
const page = document.querySelector<HTMLElement>('#page')!
const sidebar = mountSidebar()
const { settingsEntry } = sidebar
let showNotes: ReturnType<typeof mountNotes> | undefined
const trashRoute = /^#\/trash\/?$/
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
  const { hash: readingHash, jump: storyJump } = takeStoryJump(activeHash)
  if (readingHash !== activeHash) {
    activeHash = readingHash
    history.replaceState(null, '', readingHash)
  }
  view?.abort()
  showNotes = undefined
  const scope = new AbortController()
  view = scope
  leaveGuard = undefined
  main.replaceChildren()
  main.classList.remove('mode-original', 'mode-reference', 'settings-main', 'home-main')
  const settingsCategory = parseSettingsCategory(activeHash)
  document.documentElement.classList.toggle('settings-open', Boolean(settingsCategory))
  const oldShelf = activeHash.match(/^#\/(original|reference)\/?$/)
  if (oldShelf) {
    writingFilter.set(oldShelf[1] as LibraryId)
    activeHash = '#/writing'
    history.replaceState(null, '', activeHash)
  }
  const match = activeHash.match(/^#\/(original|reference)(?:\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}|original)(?:\/chapter\/([0-9a-f-]{36}))?)?)?\/?$/)
  const chapterId = match?.[3] !== 'original' ? match?.[4] : undefined
  if (chapterId) {
    activeHash = activeHash.slice(0, activeHash.lastIndexOf('/chapter/'))
    history.replaceState(null, '', activeHash)
  }
  const foreshadowing = parseForeshadowingPath(activeHash)
  const notes = notesPath(activeHash)
  if (notes && notes !== activeHash) {
    activeHash = notes
    history.replaceState(null, '', notes)
  }
  let handledFocus = false
  if (settingsCategory) {
    sidebar.active('settings')
    const canonical = `#/settings/${settingsCategory}`
    if (activeHash !== canonical) {
      activeHash = canonical
      history.replaceState(null, '', canonical)
    }
    main.classList.add('settings-main')
    main.append(settings.element)
    handledFocus = settings.showCategory(settingsCategory, false)
  } else if (foreshadowing) {
    sidebar.active('writing', true)
    main.classList.add(`mode-${foreshadowing.work.library}`)
    renderForeshadowing(main, foreshadowing.work, foreshadowing.target, scope.signal, (guard) => {
      if (view === scope) leaveGuard = guard
    })
  } else if (match) {
    sidebar.active('writing', true)
    const library = match[1] as LibraryId
    main.classList.add(`mode-${library}`)
    document.title = `${libraries[library].name} · New World`
    if (library === 'reference' && match[2] && !match[3]) renderContinuation(main, match[2], scope.signal)
    else if (match[2]) void renderReader(main, library, match[2], match[3] === 'original' ? undefined : match[3], scope.signal, (guard) => {
      if (view === scope) leaveGuard = guard
    }, storyJump, chapterId)
  } else if (/^#\/writing\/?$/.test(activeHash)) {
    sidebar.active('writing')
    document.title = t('navigation.writing') + ' · New World'
    renderShelf(main, scope.signal)
  } else if (notes) {
    sidebar.active('notes')
    document.title = t('navigation.notes') + ' · New World'
    showNotes = mountNotes(main, scope.signal)
    showNotes(notes)
  } else if (/^#\/archive\/?$/.test(activeHash)) {
    sidebar.active('archive')
    document.title = t('archive.pageTitle')
    renderArchive(main, view.signal)
  } else if (trashRoute.test(activeHash)) {
    sidebar.active('trash')
    document.title = t('main.trashNewWorld')
    renderTrash(main, view.signal)
  } else {
    sidebar.active('home')
    main.classList.add('home-main')
    document.title = t('main.newWorldNovelLibrary')
    renderHome(main, view.signal)
  }
  if (moveFocus) {
    window.scrollTo(0, 0)
    page.scrollTo(0, 0)
    if (!handledFocus) main.focus({ preventScroll: true })
  }
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
  const notes = notesPath(target)
  if (showNotes && notes) {
    activeHash = notes
    if (target !== notes) history.replaceState(null, '', notes)
    showNotes(notes)
    page.scrollTo(0, 0)
    window.scrollTo(0, 0)
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
mountAiDesktopHost()
mountTaskReminders()
mountWebVersionCheck(saveBeforeLeaving)
mountWebStorage()
void mountFolderSync()
window.newWorldDesktop?.reportReady?.()
introReady()
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
window.addEventListener('new-world:work-opened', reportRecentWorks)
void reportRecentWorks()

// Commands from the tray and the desktop right-click menu.
window.newWorldDesktop?.onCommand?.((command) => {
  if (command.type === 'project') {
    void enqueueProject(async () => {
      const file = await window.newWorldDesktop!.readProject!(command.token)
      return new Blob([Uint8Array.from(file.bytes)])
    })
  } else if (command.type === 'open') location.hash = command.hash
  else if (command.type === 'ideas') location.hash = '#/notes/ideas'
  else if (command.type === 'new-novel') {
    try { sessionStorage.setItem('new-world:new-novel', '1') } catch { /* The library still opens. */ }
    if (location.hash === '#/writing') render()
    else location.hash = '#/writing'
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
