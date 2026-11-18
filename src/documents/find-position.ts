import { reducedMotion } from '../motion'

const gap = 8

export function findPosition(
  panel: HTMLElement, writing: HTMLElement, toolbar: HTMLElement,
  activeRect: () => DOMRect | undefined, signal: AbortSignal,
) {
  let scroller = writing.parentElement
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
  const scrollRoot = scroller ?? document.scrollingElement as HTMLElement
  const header = document.querySelector<HTMLElement>('.site-header')
  const footer = document.querySelector<HTMLElement>('.site-footer')
  let frame = 0
  let reveal = false

  function viewport() {
    const view = window.visualViewport
    const screenTop = view?.offsetTop ?? 0
    const screenLeft = view?.offsetLeft ?? 0
    const clip = scroller?.getBoundingClientRect()
    const top = Math.max(screenTop, clip?.top ?? screenTop)
    const bottom = Math.min(screenTop + (view?.height ?? innerHeight), clip?.bottom ?? Infinity)
    const left = Math.max(screenLeft, clip?.left ?? screenLeft)
    const right = Math.min(screenLeft + (view?.width ?? innerWidth), clip?.right ?? Infinity)
    const titleBar = header?.offsetHeight ? header.getBoundingClientRect() : undefined
    const footerTop = footer?.offsetHeight ? footer.getBoundingClientRect().top : Infinity
    return {
      top: titleBar && titleBar.top <= top + 1 ? Math.max(top, titleBar.bottom) : top,
      bottom: footerTop > top ? Math.min(bottom, footerTop) : bottom,
      left, right,
    }
  }

  function place(avoid = true) {
    const view = viewport()
    const writingBox = writing.getBoundingClientRect()
    let left = Math.max(view.left, writingBox.left)
    let right = Math.min(view.right, writingBox.right)
    if (right - left < 200) { left = view.left; right = view.right }
    const width = Math.max(1, Math.min(464, Math.floor(right - left - 2 * gap)))
    panel.style.width = `${width}px`
    panel.style.left = `${Math.floor(right - gap - width)}px`

    const height = view.bottom - view.top
    let ceiling = Math.max(1, Math.min(height - 2 * gap, Math.max(58, height * .56)))
    const contentHeight = panel.scrollHeight + panel.offsetHeight - panel.clientHeight
    const anchor = Math.max(view.top, Math.min(toolbar.getBoundingClientRect().bottom, view.top + height * .2))
    let top = Math.min(anchor + gap, view.bottom - Math.min(contentHeight, ceiling) - gap)

    // At a scroll limit, make room for the match even when the document cannot move farther.
    if (avoid && (scrollRoot.scrollTop <= 1 || scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 1)) {
      const match = activeRect()
      if (match && match.right > right - gap - width && match.left < right - gap
        && match.bottom > top && match.top < top + Math.min(contentHeight, ceiling)) {
        const below = view.bottom - match.bottom - 2 * gap
        const above = match.top - view.top - 2 * gap
        if (below >= 44 && below >= above) { top = match.bottom + gap; ceiling = Math.min(ceiling, below) }
        else if (above >= 44) { ceiling = Math.min(ceiling, above); top = match.top - gap - Math.min(contentHeight, ceiling) }
      }
    }
    top = Math.max(view.top + gap, top)
    panel.style.top = `${Math.round(top)}px`
    panel.style.maxHeight = `${Math.floor(ceiling)}px`
    return { top, height: Math.min(contentHeight, ceiling), view }
  }

  function schedule() {
    if (panel.hidden || panel.inert || frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (panel.hidden || panel.inert) { reveal = false; return }
      const scroll = reveal
      reveal = false
      const layout = place(!scroll)
      if (!scroll) return
      const match = activeRect()
      if (!match) return
      const { view } = layout
      const uncovered = Math.min(view.bottom, layout.top + layout.height + gap)
      const center = uncovered < view.bottom - 20 ? (uncovered + view.bottom) / 2 : (view.top + view.bottom) / 2
      const target = Math.max(0, Math.min(scrollRoot.scrollHeight - scrollRoot.clientHeight,
        scrollRoot.scrollTop + (match.top + match.bottom) / 2 - center))
      if (Math.abs(target - scrollRoot.scrollTop) <= 1) place()
      else scrollRoot.scrollTo({ top: target, behavior: reducedMotion.matches ? 'instant' : 'smooth' })
    })
  }

  const observer = new ResizeObserver(schedule)
  for (const node of [writing, toolbar, panel]) observer.observe(node)
  document.addEventListener('scroll', schedule, { capture: true, passive: true, signal })
  document.addEventListener('animationend', schedule, { signal })
  window.addEventListener('resize', schedule, { signal })
  window.visualViewport?.addEventListener('resize', schedule, { signal })
  window.visualViewport?.addEventListener('scroll', schedule, { signal })
  signal.addEventListener('abort', () => {
    observer.disconnect()
    cancelAnimationFrame(frame)
  }, { once: true })

  return {
    place, schedule,
    reveal() { reveal = true; schedule() },
  }
}
