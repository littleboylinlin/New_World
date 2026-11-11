import './styles.css'
import { renderContinuation } from './continuation-view'
import { renderReader } from './reader-view'
import { renderHome, renderShelf } from './shelf-view'
import { mountStorageView } from './storage-view'
import { mountUpdateView } from './update-view'
import { libraries } from './ui'
import type { LibraryId } from './library'

const main = document.querySelector<HTMLElement>('#main')!
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
  const match = activeHash.match(/^#\/(original|reference)(?:\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}|original))?)?\/?$/)
  if (match) {
    const library = match[1] as LibraryId
    document.title = `${libraries[library].name} · New World`
    if (library === 'reference' && match[2] && !match[3]) renderContinuation(main, match[2], scope.signal)
    else if (match[2]) void renderReader(main, library, match[2], match[3] === 'original' ? undefined : match[3], scope.signal, (guard) => {
      if (view === scope) leaveGuard = guard
    })
    else renderShelf(main, library, view.signal)
  } else {
    document.title = 'New World · 小说管理器'
    renderHome(main, view.signal)
  }
  if (moveFocus) {
    window.scrollTo(0, 0)
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
  activeHash = target
  render(true)
})
render()
const saveBeforeLeaving = async () => !leaveGuard || await leaveGuard()
if (window.newWorldDesktop) {
  window.newWorldDesktop.onCloseRequested(saveBeforeLeaving)
}
mountStorageView(saveBeforeLeaving)
mountUpdateView(saveBeforeLeaving)
