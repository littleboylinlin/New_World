// Give the platform its caret before the long-press magnifier or selection handles appear.
export function touchSelection(surface: HTMLElement, changed: (active: boolean) => void, hasSelection: () => boolean, signal: AbortSignal) {
  let contact: Touch | undefined
  let timer = 0
  let active = false
  function startNative() {
    if (!contact || active) return
    active = true
    changed(true)
  }
  function finish() {
    clearTimeout(timer)
    contact = undefined
    if (!active) return
    active = false
    changed(false)
  }
  const options = { capture: true, passive: true, signal }
  surface.addEventListener('touchstart', (event) => {
    finish()
    if (event.touches.length !== 1) return
    contact = event.changedTouches[0]
    if (hasSelection()) startNative()
    else timer = window.setTimeout(startNative, 350)
  }, options)
  const root = surface.ownerDocument
  root.addEventListener('touchmove', (event) => {
    if (!contact || active) return
    const touch = Array.from(event.changedTouches).find(({ identifier }) => identifier === contact?.identifier)
    if (touch && Math.hypot(touch.clientX - contact.clientX, touch.clientY - contact.clientY) > 8) clearTimeout(timer)
  }, options)
  root.addEventListener('selectionchange', () => { if (hasSelection()) startNative() }, { signal })
  root.addEventListener('touchend', finish, options)
  root.addEventListener('touchcancel', finish, options)
  surface.addEventListener('contextmenu', startNative, options)
  signal.addEventListener('abort', finish, { once: true })
  return () => active
}
