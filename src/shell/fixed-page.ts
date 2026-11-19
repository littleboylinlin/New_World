import './shell.css'

/**
 * Pins the app to the visible screen while a page is shown: the window itself never scrolls, and
 * only the page's own panes do. The page fills what is actually visible, so a phone's on-screen
 * keyboard or Safari's toolbars never cover its top bar.
 */
export function fixedPage(main: HTMLElement, signal: AbortSignal) {
  const root = document.documentElement
  root.classList.add('fixed-page')
  main.classList.add('fixed-main')
  const view = window.visualViewport
  let frame = 0

  function measure() {
    frame = 0
    // Pinch zoom also shrinks the visual viewport; only follow it at normal scale.
    if (!view || Math.abs(view.scale - 1) > .01) {
      root.style.removeProperty('--viewport-height')
      root.style.removeProperty('--viewport-top')
      return
    }
    root.style.setProperty('--viewport-height', `${Math.round(view.height)}px`)
    root.style.setProperty('--viewport-top', `${Math.max(0, Math.round(view.offsetTop))}px`)
    // iOS may scroll the window to show the caret even when nothing can scroll; undo it.
    if (window.scrollY && !view.offsetTop) window.scrollTo(0, 0)
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
  measure()
  view?.addEventListener('resize', schedule, { signal })
  view?.addEventListener('scroll', schedule, { signal })
  window.addEventListener('resize', schedule, { signal })
  signal.addEventListener('abort', () => {
    cancelAnimationFrame(frame)
    root.classList.remove('fixed-page')
    main.classList.remove('fixed-main')
    root.style.removeProperty('--viewport-height')
    root.style.removeProperty('--viewport-top')
  }, { once: true })
}
