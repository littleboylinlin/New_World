// Theme, fonts and reading size. Saved per device in localStorage, which the desktop app keeps
// in its profile folder and copies together with the library when the storage location moves.

export const themes = ['system', 'white', 'dark', 'beige'] as const
export const latinFonts = ['times', 'georgia', 'lora', 'inter', 'system'] as const
export const cjkFonts = ['auto', 'song', 'hei', 'kai'] as const
export const lineHeights = ['compact', 'standard', 'relaxed'] as const
export const paragraphSpacings = ['none', 'standard', 'wide'] as const
export const textWidths = ['narrow', 'standard', 'wide'] as const
export type Theme = typeof themes[number]
export type LatinFont = typeof latinFonts[number]
export type CjkFont = typeof cjkFonts[number]
export type LineHeight = typeof lineHeights[number]
export type ParagraphSpacing = typeof paragraphSpacings[number]
export type TextWidth = typeof textWidths[number]

export interface Appearance {
  theme: Theme
  latin: LatinFont
  cjk: CjkFont
  /** Text size in pixels for reading and writing, or null for the built-in size. */
  size: number | null
  lineHeight: LineHeight
  paragraph: ParagraphSpacing
  /** Indent the first line of each paragraph by two characters. */
  indent: boolean
  width: TextWidth
  /** Underline misspelt English words while writing. */
  spellcheck: boolean
}

export const minSize = 14
export const maxSize = 28
export const defaultSize = 18
const key = 'new-world:appearance'
const changed = 'new-world:appearance-change'
export const defaults: Appearance = {
  theme: 'system', latin: 'times', cjk: 'auto', size: null,
  lineHeight: 'standard', paragraph: 'standard', indent: false, width: 'standard', spellcheck: false,
}

/** English names are the fonts' own names and are not translated. */
export const latinFontNames: Record<LatinFont, string> = {
  times: 'Times New Roman', georgia: 'Georgia', lora: 'Lora', inter: 'Inter', system: 'System Sans',
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback
}

function normalize(value: unknown): Appearance {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const size = typeof record.size === 'number' && Number.isFinite(record.size)
    ? Math.min(maxSize, Math.max(minSize, Math.round(record.size))) : null
  return {
    theme: pick(record.theme, themes, defaults.theme),
    latin: pick(record.latin, latinFonts, defaults.latin),
    cjk: pick(record.cjk, cjkFonts, defaults.cjk),
    size,
    lineHeight: pick(record.lineHeight, lineHeights, defaults.lineHeight),
    paragraph: pick(record.paragraph, paragraphSpacings, defaults.paragraph),
    indent: record.indent === true,
    width: pick(record.width, textWidths, defaults.width),
    spellcheck: record.spellcheck === true,
  }
}

function read(): Appearance {
  try { return normalize(JSON.parse(localStorage.getItem(key) ?? '{}')) } catch { return { ...defaults } }
}

let current = read()

function apply(value: Appearance) {
  const root = document.documentElement
  root.dataset.theme = value.theme
  root.dataset.latinFont = value.latin
  root.dataset.cjkFont = value.cjk
  root.dataset.lineHeight = value.lineHeight
  root.dataset.paragraph = value.paragraph
  root.dataset.indent = value.indent ? 'on' : 'off'
  root.dataset.width = value.width
  // Only the chapter text is spell-checked, and only when asked for; titles and forms never are.
  root.spellcheck = false
  if (value.size === null) root.style.removeProperty('--reading-size')
  else root.style.setProperty('--reading-size', `${value.size}px`)
  // The desktop app opens its next window with this theme's background.
  window.newWorldDesktop?.setWindowTheme?.(value.theme).catch(() => {})
}

export function appearance(): Appearance {
  return { ...current }
}

/** The size shown to people: the saved size, or the default when none is saved. */
export function shownSize(value = current) {
  return value.size ?? defaultSize
}

export function updateAppearance(change: Partial<Appearance>) {
  current = normalize({ ...current, ...change })
  apply(current)
  try { localStorage.setItem(key, JSON.stringify(current)) } catch { /* The choice still applies until the app is closed. */ }
  window.dispatchEvent(new CustomEvent(changed))
}

export function stepSize(direction: 1 | -1) {
  updateAppearance({ size: shownSize() + direction })
}

/** Calls the listener after every change. Returns a function that stops listening. */
export function onAppearanceChange(listener: (value: Appearance) => void) {
  const handle = () => listener(appearance())
  window.addEventListener(changed, handle)
  return () => window.removeEventListener(changed, handle)
}

/** Asks the settings dialog to open at its appearance section. */
export function openAppearanceSettings() {
  window.dispatchEvent(new CustomEvent('new-world:open-appearance-settings'))
}

apply(current)
// Browser tabs of the web version follow a change made in another tab.
window.addEventListener('storage', (event) => {
  if (event.key !== key) return
  current = read()
  apply(current)
  window.dispatchEvent(new CustomEvent(changed))
})
