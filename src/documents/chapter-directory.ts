import { t } from '../i18n'
import { motionMs } from '../motion'
import { menuButton } from '../shell/popover'
import type { ShellMenuItem } from '../shell/popover'
import { button, element } from '../ui'

interface DirectoryOptions {
  list: HTMLOListElement
  /** Polite announcements for keyboard moves. */
  live: HTMLElement
  chapters: () => { id: string; title: string }[]
  current: () => string
  canEdit: () => boolean
  open: (id: string) => void
  reorder: (order: string[]) => Promise<void>
  rename: (id: string) => void
  remove: (id: string) => void
  signal: AbortSignal
}

const dragThreshold = 5
const pressDelay = 380

/**
 * The chapter list beside the text. Chapters change order by dragging (with a placeholder and the
 * other chapters sliding aside) or with Alt + Up/Down from the keyboard. Rename and delete live in
 * the right-click menu and the "⋯" button that shows on hover.
 */
export function chapterDirectory(options: DirectoryOptions) {
  const { list, live, signal } = options
  const words = new Map<string, HTMLElement>()
  let dragging: {
    id: string; item: HTMLElement; ghost: HTMLElement; from: number; to: number
    items: HTMLElement[]; mids: number[]; step: number; pointerId: number; offset: number; listTop: number
  } | undefined
  let press: { id: string; item: HTMLElement; x: number; y: number; pointerId: number; type: string; timer: number } | undefined
  let autoScroll = 0
  let lastY = 0

  function actions(id: string): ShellMenuItem[] {
    return [
      { label: t('editor.renameChapter'), icon: 'edit', hint: 'F2', action: () => options.rename(id) },
      { label: t('editor.deleteChapter'), icon: 'trash', danger: true, action: () => options.remove(id) },
    ]
  }

  function render() {
    // Keep keyboard focus on the same chapter when the list is rebuilt under it.
    const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLElement>('.chapter-jump')?.dataset.id : undefined
    words.clear()
    const editing = options.canEdit()
    const current = options.current()
    const chapters = options.chapters()
    list.replaceChildren(...chapters.map(({ id, title }, index) => {
      const item = element('li', 'chapter-item')
      item.dataset.id = id
      const jump = button('', 'chapter-jump')
      jump.append(element('span', 'chapter-title', title))
      jump.dataset.id = id
      if (id === current) jump.setAttribute('aria-current', 'true')
      if (editing) jump.setAttribute('aria-describedby', 'chapter-reorder-hint')
      jump.addEventListener('click', () => { if (!dragging) options.open(id) })
      const label = element('span', 'chapter-words')
      label.title = t('editor.chapterCharacterCount')
      words.set(id, label)
      item.append(jump, label)
      if (editing) {
        const more = button('', 'chapter-more', 'more')
        // The name leaves out the title, so a search for a chapter by name finds only the chapter.
        more.setAttribute('aria-label', t('editor.chapterActions'))
        more.title = t('editor.chapterActions')
        // A pointer shortcut only: keyboards reach the same menu with the context-menu key,
        // Shift + F10 or F2, so the button stays out of the tab order and the accessibility tree.
        more.tabIndex = -1
        more.setAttribute('aria-hidden', 'true')
        menuButton(more, title, () => actions(id))
        item.append(more)
      }
      item.style.setProperty('--order', String(index))
      return item
    }))
    const hint = element('span', 'visually-hidden', t('editor.reorderHint'))
    hint.id = 'chapter-reorder-hint'
    list.append(hint)
    if (focused) list.querySelector<HTMLElement>(`.chapter-jump[data-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
    return words
  }

  /** Slides the chapters from where they were to where the new order puts them. */
  function flip(change: () => void) {
    const before = new Map([...list.querySelectorAll<HTMLElement>('.chapter-item')].map((item) => [item.dataset.id!, item.getBoundingClientRect().top]))
    change()
    if (!motionMs('base')) return
    for (const item of list.querySelectorAll<HTMLElement>('.chapter-item')) {
      const was = before.get(item.dataset.id!)
      if (was === undefined) continue
      const delta = was - item.getBoundingClientRect().top
      if (!delta) continue
      item.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], {
        duration: motionMs('base'), easing: 'cubic-bezier(.2, .75, .25, 1)',
      })
    }
  }

  // Saves run one after another, so quick repeated moves never race each other.
  let saving: Promise<void> = Promise.resolve()
  const save = (order: string[]) => (saving = saving.catch(() => {}).then(() => options.reorder(order)))
  const shownOrder = () => [...list.querySelectorAll<HTMLElement>('.chapter-item')].map((item) => item.dataset.id!)

  async function move(id: string, offset: number) {
    // Moves follow the order on screen, which may be ahead of the one still being saved.
    const order = shownOrder()
    const index = order.indexOf(id)
    const target = index + offset
    if (index < 0 || target < 0 || target >= order.length) return
    order.splice(index, 1)
    order.splice(target, 0, id)
    await commit(order, id, true)
  }

  async function commit(order: string[], id: string, keyboard: boolean) {
    const title = options.chapters().find((entry) => entry.id === id)?.title ?? ''
    // Show the new order at once; the saved order follows and a failure puts the list back.
    flip(() => {
      const items = new Map([...list.querySelectorAll<HTMLElement>('.chapter-item')].map((item) => [item.dataset.id!, item]))
      const hint = list.querySelector('#chapter-reorder-hint')
      list.replaceChildren(...order.map((key) => items.get(key)!).filter(Boolean))
      if (hint) list.append(hint)
    })
    if (keyboard) list.querySelector<HTMLElement>(`.chapter-jump[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: false })
    try {
      await save(order)
      live.textContent = t('editor.chapterMoved', [title, order.indexOf(id) + 1])
    } catch {
      flip(() => render())
    }
  }

  function itemAt(target: EventTarget | null) {
    return target instanceof Element ? target.closest<HTMLElement>('.chapter-item') : null
  }

  function startDrag(event: PointerEvent, item: HTMLElement, id: string) {
    const items = [...list.querySelectorAll<HTMLElement>('.chapter-item')]
    const from = items.indexOf(item)
    const rects = items.map((node) => node.getBoundingClientRect())
    const box = rects[from]
    const gap = rects.length > 1 ? Math.max(0, (rects[1].top - rects[0].bottom)) : 4
    const ghost = item.cloneNode(true) as HTMLElement
    ghost.classList.add('chapter-ghost')
    ghost.removeAttribute('data-id')
    ghost.setAttribute('aria-hidden', 'true')
    ghost.style.width = `${box.width}px`
    ghost.style.left = `${box.left}px`
    ghost.style.top = `${box.top}px`
    document.body.append(ghost)
    item.classList.add('chapter-placeholder')
    list.classList.add('chapter-list-dragging')
    try { list.setPointerCapture(event.pointerId) } catch { /* Some browsers refuse capture after a long press. */ }
    dragging = {
      id, item, ghost, from, to: from, items, pointerId: event.pointerId,
      mids: rects.map((rect) => rect.top + rect.height / 2 + list.scrollTop),
      step: box.height + gap, offset: event.clientY - box.top, listTop: list.scrollTop,
    }
    lastY = event.clientY
    navigator.vibrate?.(8)
    drag(event.clientY)
  }

  function drag(y: number) {
    if (!dragging) return
    lastY = y
    const state = dragging
    state.ghost.style.top = `${y - state.offset}px`
    const center = y - state.offset + state.step / 2 + list.scrollTop
    let to = state.from
    for (let index = 0; index < state.mids.length; index++) {
      if (index < state.from && center < state.mids[index]) { to = index; break }
    }
    for (let index = state.mids.length - 1; index > state.from; index--) {
      if (center > state.mids[index]) { to = index; break }
    }
    state.to = to
    state.items.forEach((node, index) => {
      let shift = 0
      if (index === state.from) shift = (to - state.from) * state.step
      else if (state.from < to && index > state.from && index <= to) shift = -state.step
      else if (to < state.from && index >= to && index < state.from) shift = state.step
      node.style.transform = shift ? `translateY(${shift}px)` : ''
    })
    // Near the list's edges the list scrolls under the pointer.
    const view = list.getBoundingClientRect()
    const speed = y < view.top + 36 ? -Math.ceil((view.top + 36 - y) / 4) : y > view.bottom - 36 ? Math.ceil((y - view.bottom + 36) / 4) : 0
    cancelAnimationFrame(autoScroll)
    if (speed) {
      const tick = () => {
        if (!dragging) return
        list.scrollTop += speed
        drag(lastY)
      }
      autoScroll = requestAnimationFrame(tick)
    }
  }

  function endDrag(cancel: boolean) {
    const state = dragging
    if (!state) return
    cancelAnimationFrame(autoScroll)
    try { list.releasePointerCapture(state.pointerId) } catch { /* Already released. */ }
    const order = state.items.map((node) => node.dataset.id!)
    const changed = !cancel && state.to !== state.from
    if (changed) { order.splice(state.from, 1); order.splice(state.to, 0, state.id) }
    // Let the ghost settle into the slot before the list takes its new order.
    const slot = state.item.getBoundingClientRect()
    const finish = () => {
      state.ghost.remove()
      for (const node of state.items) { node.style.transition = 'none'; node.style.transform = '' }
      state.item.classList.remove('chapter-placeholder')
      list.classList.remove('chapter-list-dragging')
      if (changed) {
        const items = new Map(state.items.map((node) => [node.dataset.id!, node]))
        const hint = list.querySelector('#chapter-reorder-hint')
        list.replaceChildren(...order.map((key) => items.get(key)!))
        if (hint) list.append(hint)
      }
      void list.offsetWidth
      for (const node of state.items) node.style.removeProperty('transition')
      // A click follows the pointer release; it must not open the dragged chapter.
      window.setTimeout(() => { dragging = undefined }, 0)
      if (changed) {
        const title = options.chapters().find((entry) => entry.id === state.id)?.title ?? ''
        void save(order).then(() => {
          live.textContent = t('editor.chapterMoved', [title, order.indexOf(state.id) + 1])
        }, () => render())
      }
    }
    const duration = motionMs('fast')
    if (!duration) { finish(); return }
    state.ghost.classList.add('chapter-ghost-drop')
    state.ghost.style.top = `${slot.top}px`
    window.setTimeout(finish, duration)
  }

  function cancelPress() {
    if (!press) return
    window.clearTimeout(press.timer)
    press.item.classList.remove('chapter-pressing')
    press = undefined
  }

  list.addEventListener('pointerdown', (event) => {
    if (!options.canEdit() || dragging || event.button !== 0) return
    const item = itemAt(event.target)
    if (!item || (event.target as Element).closest('.chapter-more')) return
    const id = item.dataset.id!
    press = { id, item, x: event.clientX, y: event.clientY, pointerId: event.pointerId, type: event.pointerType, timer: 0 }
    if (event.pointerType !== 'mouse') {
      // Touch drags start with a long press, so a quick swipe still scrolls the list.
      item.classList.add('chapter-pressing')
      press.timer = window.setTimeout(() => {
        if (!press) return
        const { item: target, id: key } = press
        cancelPress()
        startDrag(event, target, key)
      }, pressDelay)
    }
  }, { signal })
  list.addEventListener('pointermove', (event) => {
    if (dragging) { if (event.pointerId === dragging.pointerId) { event.preventDefault(); drag(event.clientY) } return }
    if (!press || event.pointerId !== press.pointerId) return
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y)
    if (press.type !== 'mouse') { if (moved > 8) cancelPress(); return }
    if (moved > dragThreshold) {
      const { item, id } = press
      cancelPress()
      startDrag(event, item, id)
    }
  }, { signal })
  list.addEventListener('pointerup', () => { cancelPress(); endDrag(false) }, { signal })
  list.addEventListener('pointercancel', () => { cancelPress(); endDrag(true) }, { signal })
  // While a touch drag runs, the page must not scroll under the finger.
  list.addEventListener('touchmove', (event) => { if (dragging || press) { if (dragging) event.preventDefault() } }, { passive: false, signal })
  list.addEventListener('contextmenu', (event) => {
    if (press?.type !== 'mouse' && (press || dragging)) { event.preventDefault(); return }
    const item = itemAt(event.target)
    if (!item || !options.canEdit()) return
    event.preventDefault()
    item.querySelector<HTMLButtonElement>('.chapter-more')?.click()
  }, { signal })
  list.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dragging) { event.preventDefault(); endDrag(true); return }
    const jump = (event.target as Element).closest<HTMLElement>('.chapter-jump')
    if (!jump || !options.canEdit()) return
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      void move(jump.dataset.id!, event.key === 'ArrowUp' ? -1 : 1)
    } else if (!event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const jumps = [...list.querySelectorAll<HTMLElement>('.chapter-jump')]
      const index = jumps.indexOf(jump)
      const next = jumps[index + (event.key === 'ArrowUp' ? -1 : 1)]
      if (next) { event.preventDefault(); next.focus() }
    } else if (event.key === 'F2') {
      event.preventDefault()
      options.rename(jump.dataset.id!)
    }
  }, { signal })
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && dragging) endDrag(true) }, { signal })
  signal.addEventListener('abort', () => { cancelPress(); dragging?.ghost.remove(); cancelAnimationFrame(autoScroll) }, { once: true })

  return { render, isDragging: () => Boolean(dragging) }
}
