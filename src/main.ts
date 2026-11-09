import './styles.css'
import { renderReader } from './reader-view'
import { renderHome, renderShelf } from './shelf-view'
import { libraries } from './ui'
import type { LibraryId } from './library'

const main = document.querySelector<HTMLElement>('#main')!
let view: AbortController | undefined

function render(moveFocus = false) {
  view?.abort()
  view = new AbortController()
  main.replaceChildren()
  const match = location.hash.match(/^#\/(original|reference)(?:\/([0-9a-f-]{36}))?\/?$/)
  if (match) {
    const library = match[1] as LibraryId
    document.title = `${libraries[library].name} · New World`
    if (match[2]) void renderReader(main, library, match[2], view.signal)
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
window.addEventListener('hashchange', () => render(true))
render()
