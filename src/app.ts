import { t } from './i18n'
import { renderContinuation } from './continuation-view'
import { renderReader } from './reader-view'
import { renderHome, renderShelf } from './shelf-view'
import { clearExpiredTrash, countTrash } from './trash'
import { renderTrash } from './trash-view'
import { renderArchive } from './archive-view'
import { restoredNotice, startAutomaticBackups } from './backup-view'
import { mountSettingsView } from './settings-view'
import { changeView, pop } from './motion'
import { libraries, notice } from './ui'
import { libraryChanges } from './library'
import type { LibraryId } from './library'

for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = t(node.dataset.i18n!)
for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-label]')) node.setAttribute('aria-label', t(node.dataset.i18nLabel!))
document.querySelector('meta[name="description"]')?.setAttribute('content', t('app.description'))

const main = document.querySelector<HTMLElement>('#main')!
const page = document.querySelector<HTMLElement>('#page')!
// The desktop window has no system title bar. The app header takes its place and the page scrolls below it.
if (window.newWorldDesktop) {
  document.documentElement.classList.add('desktop')
  if (window.newWorldDesktop.platform === 'darwin') document.documentElement.classList.add('macos')
}
let view: AbortController | undefined
let leaveGuard: (() => Promise<boolean>) | undefined
let activeHash = location.hash
let navigation = 0

function render(moveFocus = false) {
  view?.abort()
  const scope = new AbortController()
  view = scope
  leaveGuard = undefined
  main.replaceChildren()
  main.classList.remove('mode-original', 'mode-reference')
  const match = activeHash.match(/^#\/(original|reference)(?:\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}|original))?)?\/?$/)
  if (match) {
    const library = match[1] as LibraryId
    main.classList.add(`mode-${library}`)
    document.title = `${libraries[library].name} · New World`
    if (library === 'reference' && match[2] && !match[3]) renderContinuation(main, match[2], scope.signal)
    else if (match[2]) void renderReader(main, library, match[2], match[3] === 'original' ? undefined : match[3], scope.signal, (guard) => {
      if (view === scope) leaveGuard = guard
    })
    else renderShelf(main, library, view.signal)
  } else if (/^#\/archive\/?$/.test(activeHash)) {
    document.title = t('archive.pageTitle')
    renderArchive(main, view.signal)
  } else if (/^#\/trash\/?$/.test(activeHash)) {
    document.title = t('main.trashNewWorld')
    renderTrash(main, view.signal)
  } else {
    document.title = t('main.newWorldNovelLibrary')
    renderHome(main, view.signal)
  }
  if (moveFocus) {
    window.scrollTo(0, 0)
    page.scrollTo(0, 0)
    main.focus({ preventScroll: true })
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
  const allowed = !leaveGuard || await leaveGuard()
  if (request !== navigation || location.hash !== target) return
  if (!allowed) {
    history.replaceState(null, '', activeHash || '#/')
    return
  }
  const previous = activeHash
  activeHash = target
  changeView(main, previous, target, () => render(true))
})
render()
const restored = restoredNotice()
if (restored) main.prepend(notice(restored))
const trashCount = document.querySelector<HTMLElement>('#trash-count')!
async function refreshTrashCount() {
  try {
    const count = await countTrash()
    const label = count ? String(count) : ''
    if (label && label !== trashCount.textContent) pop(trashCount)
    trashCount.textContent = label
  } catch {
    trashCount.textContent = ''
  }
}
libraryChanges.addEventListener('update', () => { void refreshTrashCount() })
void clearExpiredTrash().catch(() => {}).then(refreshTrashCount)
const saveBeforeLeaving = async () => !leaveGuard || await leaveGuard()
if (window.newWorldDesktop) {
  window.newWorldDesktop.onCloseRequested(saveBeforeLeaving)
}
mountSettingsView(saveBeforeLeaving)
window.newWorldDesktop?.reportReady?.()
startAutomaticBackups()
