import { t } from './i18n'
import {
  appearance, cjkFonts, latinFontNames, latinFonts, maxSize, minSize, onAppearanceChange, openAppearanceSettings,
  shownSize, stepSize, themes, updateAppearance,
} from './appearance'
import type { Appearance, CjkFont, LatinFont, Theme } from './appearance'
import { button, element } from './ui'

let groups = 0

const themeLabel = (theme: Theme) => ({
  system: t('appearance.themeSystem'), white: t('appearance.themeWhite'),
  dark: t('appearance.themeDark'), beige: t('appearance.themeBeige'),
})[theme]

const latinLabel = (font: LatinFont) => font === 'system' ? t('appearance.systemSans') : latinFontNames[font]

const cjkLabel = (font: CjkFont) => ({
  auto: t('appearance.cjkAuto'), song: t('appearance.cjkSong'), hei: t('appearance.cjkHei'), kai: t('appearance.cjkKai'),
})[font]

/** Keeps a control in step with changes made elsewhere until the control leaves the page. */
function follow(node: HTMLElement, paint: (value: Appearance) => void) {
  paint(appearance())
  const stop = onAppearanceChange((value) => {
    if (!node.isConnected) { stop(); return }
    paint(value)
  })
}

function radioGroup<T extends string>(
  label: string, className: string, values: readonly T[], content: (value: T) => Node[], select: (value: T) => void,
  current: (value: Appearance) => T,
) {
  const group = element('div', className)
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', label)
  const name = `appearance-${++groups}`
  const inputs = values.map((value) => {
    const item = element('label', 'settings-option')
    const input = element('input')
    input.type = 'radio'
    input.name = name
    input.value = value
    input.addEventListener('change', () => { if (input.checked) select(value) })
    item.append(input, ...content(value))
    group.append(item)
    return input
  })
  follow(group, (value) => { for (const input of inputs) input.checked = input.value === current(value) })
  return group
}

function swatch(theme: Theme) {
  return element('span', `theme-swatch theme-swatch-${theme}`)
}

function sizeControls(withReset: boolean) {
  const row = element('div', 'size-controls')
  const smaller = button('', 'button button-quiet button-small size-step')
  smaller.append(element('span', 'size-glyph size-glyph-small', 'Aa'), element('span', 'size-sign', '−'))
  smaller.setAttribute('aria-label', t('appearance.smaller'))
  smaller.title = t('appearance.smaller')
  const larger = button('', 'button button-quiet button-small size-step')
  larger.append(element('span', 'size-glyph', 'Aa'), element('span', 'size-sign', '+'))
  larger.setAttribute('aria-label', t('appearance.larger'))
  larger.title = t('appearance.larger')
  const value = element('output', 'size-value')
  value.setAttribute('aria-live', 'polite')
  value.setAttribute('aria-label', t('appearance.textSize'))
  row.append(smaller, value, larger)
  smaller.addEventListener('click', () => stepSize(-1))
  larger.addEventListener('click', () => stepSize(1))
  let reset: HTMLButtonElement | undefined
  if (withReset) {
    reset = button(t('appearance.resetSize'), 'button button-quiet button-small')
    reset.addEventListener('click', () => updateAppearance({ size: null }))
    row.append(reset)
  }
  follow(row, (current) => {
    const size = shownSize(current)
    value.textContent = t('appearance.sizeValue', [size])
    smaller.disabled = size <= minSize
    larger.disabled = size >= maxSize
    if (reset) reset.disabled = current.size === null
  })
  return row
}

function heading(text: string) {
  return element('h4', 'appearance-heading', text)
}

/** The appearance section of the settings dialog. */
export function mountAppearanceSettings(section: HTMLElement) {
  const theme = radioGroup(t('appearance.theme'), 'settings-options theme-options', themes,
    (value) => [swatch(value), element('span', '', themeLabel(value))], (value) => updateAppearance({ theme: value }), (value) => value.theme)
  const latin = radioGroup(t('appearance.latinFont'), 'settings-options font-options', latinFonts,
    (value) => [element('span', `font-name font-${value}`, latinLabel(value)), element('span', `font-sample font-${value}`, t('appearance.latinSample'))],
    (value) => updateAppearance({ latin: value }), (value) => value.latin)
  const cjk = radioGroup(t('appearance.cjkFont'), 'settings-options font-options', cjkFonts,
    (value) => [
      element('span', `font-name font-${value}`, cjkLabel(value)),
      element('span', `font-sample font-${value}`, value === 'auto' ? t('appearance.cjkAutoHint') : t('appearance.cjkSample')),
    ],
    (value) => updateAppearance({ cjk: value }), (value) => value.cjk)
  section.append(
    heading(t('appearance.theme')), theme,
    heading(t('appearance.latinFont')), latin,
    heading(t('appearance.cjkFont')), cjk,
    heading(t('appearance.textSize')), sizeControls(true),
    element('p', 'dialog-help', t('appearance.hint')),
  )
}

/** The "Aa" button in the reading and writing toolbars, with a small appearance panel. */
export function appearanceMenu() {
  const menu = element('div', 'appearance-menu')
  const toggle = button('', 'format-button appearance-toggle')
  toggle.append(element('span', 'format-glyph', 'Aa'))
  toggle.setAttribute('aria-label', t('appearance.title'))
  toggle.title = t('appearance.title')
  toggle.setAttribute('aria-expanded', 'false')
  const panel = element('div', 'appearance-panel')
  panel.id = `appearance-panel-${++groups}`
  panel.setAttribute('role', 'group')
  panel.setAttribute('aria-label', t('appearance.title'))
  panel.hidden = true
  toggle.setAttribute('aria-controls', panel.id)

  const themeRow = radioGroup(t('appearance.theme'), 'theme-swatches', themes,
    (value) => [swatch(value), element('span', 'visually-hidden', themeLabel(value))], (value) => updateAppearance({ theme: value }), (value) => value.theme)
  for (const [index, item] of [...themeRow.children].entries()) (item as HTMLElement).title = themeLabel(themes[index]!)

  const fontLabel = element('label', 'field-label appearance-font')
  fontLabel.append(element('span', '', t('appearance.latinFont')))
  const font = element('select', 'editor-select')
  for (const value of latinFonts) {
    const option = element('option', `font-${value}`, latinLabel(value))
    option.value = value
    font.append(option)
  }
  font.addEventListener('change', () => updateAppearance({ latin: font.value as LatinFont }))
  follow(font, (value) => { font.value = value.latin })
  fontLabel.append(font)

  const more = button(t('appearance.more'), 'appearance-more')
  panel.append(themeRow, sizeControls(false), fontLabel, more)
  menu.append(toggle, panel)

  function setOpen(open: boolean, returnFocus = false) {
    panel.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    if (open) document.addEventListener('pointerdown', outside, true)
    else document.removeEventListener('pointerdown', outside, true)
    if (!open && returnFocus) toggle.focus()
  }
  function outside(event: Event) {
    if (!menu.isConnected || !menu.contains(event.target as Node)) setOpen(false)
  }
  toggle.addEventListener('mousedown', (event) => event.preventDefault())
  toggle.addEventListener('click', () => setOpen(Boolean(panel.hidden)))
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false, true)
    }
  })
  more.addEventListener('click', () => {
    setOpen(false)
    openAppearanceSettings()
  })
  return menu
}
