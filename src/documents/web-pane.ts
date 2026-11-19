import { t } from '../i18n'
import { button, element, icon } from '../ui'
import type { IconName } from '../ui'
import { dismissNotice, showNotice } from '../undo'
import { addressFor } from '../web-search'
import type { ShellMenuItem } from '../shell/popover'
import type { ChapterInfo, Edition } from './model'
import type { PaneSource, ReferenceSource } from './compare'
import './web-pane.css'

// A web pane: a private web page beside the text (desktop only). The page itself is a native view
// the main process places over this pane's stage; this element only draws the thin tool row, a
// still picture of the page while something of the app covers it, and the error pages.

const desktop = () => window.newWorldDesktop
export const canBrowse = () => Boolean(desktop()?.web)

/**
 * What may draw over a web page. A native view always paints on top, so these swap it for a picture.
 * Notices are not among them: they move out of the page's way instead, so the page stays usable.
 */
const overlaySelector = [
  '.shell-layer', '.popup-menu', 'dialog[open]', '.selection-toolbar:not([hidden])',
  '.workbench-panel[data-mode="overlay"][data-state="open"]', '.workbench-scrim[data-state="open"]',
  '.compare-scrim[data-state="open"]', '.compare-drawer[data-state="open"]',
].join(',')

interface WebPaneOptions {
  id: string
  url?: string
  signal: AbortSignal
  menu: () => ShellMenuItem[]
  onClose: () => void
  onChange: () => void
  /** The page took the keyboard focus (a click inside it). */
  onFocus: () => void
  /** Selected text to keep as an idea or a task, with the page's title and address. */
  onKeep: (kind: 'idea' | 'task', entry: { text: string; title: string; url: string }) => void
}

type Mode = 'hidden' | 'live' | 'snapshot'

const panes = new Map<string, ReturnType<typeof webPane>>()
let listening = false

function listen() {
  if (listening) return
  listening = true
  desktop()?.onWebState?.((state) => panes.get(state.id)?.update(state))
  desktop()?.onWebKeep?.((entry) => panes.get(entry.id)?.keepFromMenu(entry))
}

let frame = 0
function loop() {
  frame = 0
  if (!panes.size) return
  const dragging = document.documentElement.hasAttribute('data-open-dragging')
  const overlays = [...document.querySelectorAll<HTMLElement>(overlaySelector)].filter((node) => node.isConnected && !node.hidden)
  for (const pane of panes.values()) pane.sync(dragging, overlays)
  frame = requestAnimationFrame(loop)
}
const run = () => { if (!frame) frame = requestAnimationFrame(loop) }

const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** The part of the stage really on screen: inside the window and every clipping box around it. */
function visibleRect(node: HTMLElement) {
  let rect = node.getBoundingClientRect()
  let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom
  for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (style.display === 'none' || style.visibility === 'hidden') return { rect, area: 0, whole: false }
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    const box = parent.getBoundingClientRect()
    left = Math.max(left, box.left); top = Math.max(top, box.top); right = Math.min(right, box.right); bottom = Math.min(bottom, box.bottom)
  }
  left = Math.max(left, 0); top = Math.max(top, 0); right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight)
  const area = Math.max(0, right - left) * Math.max(0, bottom - top)
  rect = node.getBoundingClientRect()
  return { rect, area, whole: area >= rect.width * rect.height - 2 }
}

export function webPane(options: WebPaneOptions) {
  const { id } = options
  const call = (action: WebPaneAction, ...args: unknown[]) => desktop()!.web!(action, id, ...args)
  const lifetime = new AbortController()
  const { signal } = lifetime
  options.signal.addEventListener('abort', () => lifetime.abort(), { once: true, signal })

  const root = element('section', 'reference-pane web-pane')
  root.setAttribute('aria-roledescription', t('web.pane'))
  const bar = element('div', 'web-bar')
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', t('web.tools'))
  const tool = (label: string, name: IconName, run: () => void, className = '') => {
    const node = button('', `web-tool ${className}`.trim(), name)
    node.setAttribute('aria-label', label)
    node.title = label
    node.addEventListener('click', run)
    return node
  }
  const back = tool(t('web.back'), 'back', () => { void call('back') })
  const forward = tool(t('web.forward'), 'arrow', () => { void call('forward') })
  const reload = tool(t('web.reload'), 'reload', () => { void call(state.loading ? 'stop' : 'reload') }, 'web-reload')
  const form = element('form', 'web-address')
  form.setAttribute('role', 'search')
  const address = element('input', 'web-address-input')
  address.type = 'text'
  address.name = 'address'
  address.autocomplete = 'off'
  address.spellcheck = false
  address.setAttribute('autocapitalize', 'off')
  address.setAttribute('aria-label', t('web.address'))
  address.placeholder = t('web.addressHint')
  form.append(address)
  const keepIdea = tool(t('web.toIdea'), 'idea', () => { void keep('idea') }, 'web-keep')
  const keepTask = tool(t('web.toTask'), 'check', () => { void keep('task') }, 'web-keep')
  keepIdea.append(element('span', 'web-tool-label', t('web.toIdea')))
  keepTask.append(element('span', 'web-tool-label', t('web.toTask')))
  keepIdea.hidden = keepTask.hidden = true
  const outside = tool(t('web.openOutside'), 'window', () => { void call('openOutside') })
  const close = tool(t('web.close'), 'close', () => options.onClose(), 'web-close')
  bar.append(back, forward, reload, form, keepIdea, keepTask, outside, close)

  const stage = element('div', 'web-stage')
  stage.tabIndex = -1
  const snapshot = element('img', 'web-snapshot')
  snapshot.alt = ''
  snapshot.hidden = true
  const message = element('div', 'web-message')
  const start = element('div', 'web-start')
  start.append(icon('compare'), element('p', '', t('web.start')), element('p', 'dialog-help', t('web.private')))
  stage.append(start, snapshot, message)
  message.hidden = true
  root.append(bar, stage)

  let created: Promise<unknown> | undefined
  let state: WebPaneState = { id }
  let mode: Mode = 'hidden'
  let placed = ''
  let turn = 0
  let selected = ''
  let polling = 0
  let focused = false

  function ensure() {
    created ??= call('create')
    return created
  }

  async function go(input: string) {
    const target = addressFor(input)
    if (!target) return
    if ('blocked' in target) { showNotice(t('web.blocked')); address.value = state.url ?? ''; return }
    await ensure()
    start.hidden = true
    address.value = target.url
    await call('navigate', target.url)
  }
  form.addEventListener('submit', (event) => { event.preventDefault(); void go(address.value); address.blur() })
  address.addEventListener('focus', () => address.select())
  address.addEventListener('keydown', (event) => { if (event.key === 'Escape') { address.value = state.url ?? ''; address.blur() } })

  function paint() {
    back.disabled = !state.canGoBack
    forward.disabled = !state.canGoForward
    const loading = Boolean(state.loading)
    reload.disabled = !state.url
    reload.replaceChildren(icon(loading ? 'close' : 'reload'))
    reload.setAttribute('aria-label', loading ? t('web.stop') : t('web.reload'))
    reload.title = reload.getAttribute('aria-label')!
    outside.disabled = !state.url
    if (document.activeElement !== address) address.value = state.url ?? ''
    root.setAttribute('aria-label', t('web.paneLabel', [state.title || state.url || t('web.newPage')]))
    message.replaceChildren()
    message.hidden = !state.error
    if (state.error) {
      const certificate = state.error.kind === 'certificate'
      message.append(
        element('h3', '', certificate ? t('web.certificateTitle') : t('web.failedTitle')),
        element('p', '', certificate ? t('web.certificateText') : t('web.failedText', [state.error.description])),
        element('p', 'web-message-url', state.error.url),
      )
      const actions = element('div', 'web-message-actions')
      if (state.canGoBack) actions.append(button(t('web.back'), 'button button-quiet button-small web-message-back'))
      if (!certificate) actions.append(button(t('web.reload'), 'button button-quiet button-small web-message-retry'))
      actions.querySelector('.web-message-back')?.addEventListener('click', () => { void call('back') })
      actions.querySelector('.web-message-retry')?.addEventListener('click', () => { void call('reload') })
      message.append(actions)
    }
    options.onChange()
  }

  // ——— Keeping selected text ———
  async function readSelection() {
    if (!created) return ''
    try { return String(await call('selection') ?? '') } catch { return '' }
  }
  async function keep(kind: 'idea' | 'task') {
    const text = await readSelection()
    if (!text) { showNotice(t('web.selectFirst')); return }
    options.onKeep(kind, { text, title: state.title ?? '', url: state.url ?? '' })
  }
  // The tool row offers keeping only while the page has a selection; it is read on demand, a
  // one-off expression each time, only while this page has the keyboard.
  function poll() {
    window.clearTimeout(polling)
    if (!focused || signal.aborted) return
    polling = window.setTimeout(async () => {
      const text = await readSelection()
      if (signal.aborted) return
      if (Boolean(text) !== Boolean(selected)) { keepIdea.hidden = keepTask.hidden = !text; options.onChange() }
      selected = text
      poll()
    }, 400)
  }
  function setFocused(on: boolean) {
    focused = on
    if (on) poll()
    else window.clearTimeout(polling)
  }

  // ——— Keeping the native page over the stage ———
  async function toSnapshot() {
    const ticket = ++turn
    mode = 'snapshot'
    let picture = ''
    try { picture = String(await call('capture') ?? '') } catch { /* Shown blank instead. */ }
    if (ticket !== turn || signal.aborted) return
    snapshot.src = picture
    snapshot.hidden = !picture
    await call('place', placedRect(), false).catch(() => {})
    placed = ''
  }
  function placedRect() {
    const rect = stage.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }

  function sync(dragging: boolean, overlays: HTMLElement[]) {
    if (!created || signal.aborted) return
    const { rect, area, whole } = visibleRect(stage)
    const showing = area > 0 && Boolean(state.url) && !state.error && rect.width >= 1 && rect.height >= 1
    const insideDrawer = Boolean(stage.closest('.compare-drawer'))
    const covered = dragging || overlays.some((node) => {
      if (node.contains(stage)) return false
      if (insideDrawer && node.matches('.compare-scrim, .compare-drawer')) return false
      if (node.matches('dialog[open]')) return true
      return overlap(node.getBoundingClientRect(), rect)
    })
    const next: Mode = !showing ? 'hidden' : covered || !whole ? 'snapshot' : 'live'
    if (next === 'snapshot') {
      if (mode === 'live') void toSnapshot()
      else if (mode === 'hidden') { mode = 'snapshot'; snapshot.hidden = !snapshot.src }
      return
    }
    if (next === 'hidden') {
      if (mode !== 'hidden') { ++turn; mode = 'hidden'; snapshot.hidden = true; placed = ''; void call('place', placedRect(), false).catch(() => {}) }
      return
    }
    const bounds = placedRect()
    const key = `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)},${devicePixelRatio}`
    if (mode !== 'live' || key !== placed) {
      const wasSnapshot = mode === 'snapshot'
      ++turn
      mode = 'live'
      placed = key
      void call('place', bounds, true).then(() => {
        if (wasSnapshot && mode === 'live') requestAnimationFrame(() => { if (mode === 'live') snapshot.hidden = true })
      }, () => {})
    }
  }

  function update(next: WebPaneState) {
    if (next.closed) return
    // A click inside the page never reaches this document, so it takes a plain notice away here.
    if (next.focused) { setFocused(true); dismissNotice(); options.onFocus() }
    if (next.blocked) showNotice(t('web.blocked'))
    state = { ...state, ...next, focused: undefined, blocked: undefined }
    if (state.url) start.hidden = true
    paint()
    run()
  }

  // The page loses the keyboard as soon as anything of the app takes it.
  document.addEventListener('focusin', () => setFocused(false), { signal })
  window.addEventListener('resize', () => { placed = ''; run() }, { signal })

  const pane = {
    kind: 'web' as const,
    element: root,
    scroller: stage,
    ready: Promise.resolve(),
    source: (): PaneSource => ({ kind: 'web' }),
    editor: () => undefined,
    edition: (): Edition | undefined => undefined,
    book: () => undefined,
    textRoot: (): HTMLElement | undefined => undefined,
    title: () => state.title || t('web.newPage'),
    part: () => { try { return state.url ? new URL(state.url).host : t('web.newPage') } catch { return t('web.newPage') } },
    problem: () => '',
    loadedSections: () => 0,
    chapters: (): ChapterInfo[] => [],
    show: async (_next: ReferenceSource) => false,
    switchChapter: async (_id: string, _wanted?: () => boolean) => false,
    capture: () => {},
    restore: () => { placed = ''; run() },
    release: () => {},
    menu: options.menu,
    url: () => state.url ?? '',
    /** Puts the caret in the address bar, as for a new page. */
    focusAddress: () => address.focus(),
    navigate: (url: string) => go(url),
    update,
    sync,
    keepFromMenu(entry: WebKeepEntry) { options.onKeep(entry.kind, { text: entry.text, title: entry.title, url: entry.url }) },
    destroy() {
      lifetime.abort()
      window.clearTimeout(polling)
      panes.delete(id)
      root.remove()
      if (created) void created.then(() => call('close'), () => {})
    },
  }
  panes.set(id, pane)
  listen()
  run()
  if (options.url) void go(options.url)
  signal.addEventListener('abort', () => { panes.delete(id); if (created) void created.then(() => call('close'), () => {}) }, { once: true })
  return pane
}

export type WebPane = ReturnType<typeof webPane>
