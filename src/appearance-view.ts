import { t } from './i18n'
import {
  appearance, cjkFonts, latinFontNames, latinFonts, lineHeights, maxSize, minSize, onAppearanceChange, openAppearanceSettings,
  paragraphSpacings, shownSize, stepSize, textWidths, themes, updateAppearance,
} from './appearance'
import type { Appearance, CjkFont, LatinFont, LineHeight, ParagraphSpacing, TextWidth, Theme } from './appearance'
import { button, element } from './ui'
import { createPopover } from './shell/popover'

let groups = 0

const themeLabel = (theme: Theme) => ({
  system: t('appearance.themeSystem'), white: t('appearance.themeWhite'),
  dark: t('appearance.themeDark'), beige: t('appearance.themeBeige'),
})[theme]

const latinLabel = (font: LatinFont) => font === 'system' ? t('appearance.systemSans') : latinFontNames[font]

const cjkLabel = (font: CjkFont) => ({
  auto: t('appearance.cjkAuto'), song: t('appearance.cjkSong'), hei: t('appearance.cjkHei'), kai: t('appearance.cjkKai'),
})[font]

const lineHeightLabel = (value: LineHeight) => ({
  compact: t('appearance.lineCompact'), standard: t('appearance.standard'), relaxed: t('appearance.lineRelaxed'),
})[value]

const paragraphLabel = (value: ParagraphSpacing) => ({
  none: t('appearance.paragraphNone'), standard: t('appearance.standard'), wide: t('appearance.paragraphWide'),
})[value]

const widthLabel = (value: TextWidth) => ({
  narrow: t('appearance.widthNarrow'), standard: t('appearance.standard'), wide: t('appearance.widthWide'),
})[value]

const switches = ['off', 'on'] as const

/** Keeps a control in step with changes made elsewhere until the control leaves the page (unless persistent). */
type Lifetime = boolean | (() => boolean)

function follow(node: HTMLElement, paint: (value: Appearance) => void, persistent: Lifetime = false) {
  paint(appearance())
  const stop = onAppearanceChange((value) => {
    if (typeof persistent === 'function' ? !persistent() : !persistent && !node.isConnected) { stop(); return }
    paint(value)
  })
}

function radioGroup<T extends string>(
  label: string, className: string, values: readonly T[], content: (value: T) => Node[], select: (value: T) => void,
  current: (value: Appearance) => T, persistent: Lifetime = false,
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
  follow(group, (value) => { for (const input of inputs) input.checked = input.value === current(value) }, persistent)
  return group
}

function swatch(theme: Theme) {
  return element('span', `theme-swatch theme-swatch-${theme}`)
}

function sizeControls(withReset: boolean, persistent: Lifetime = false) {
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
  }, persistent)
  return row
}

function heading(text: string) {
  return element('h4', 'appearance-heading', text)
}

function readingLayoutControls(persistent = false) {
  return [
    heading(t('appearance.textSize')), sizeControls(true, persistent),
    heading(t('appearance.lineHeight')),
    radioGroup(t('appearance.lineHeight'), 'settings-options choice-options', lineHeights,
      (value) => [element('span', '', lineHeightLabel(value))], (value) => updateAppearance({ lineHeight: value }), (value) => value.lineHeight, persistent),
    heading(t('appearance.paragraphSpacing')),
    radioGroup(t('appearance.paragraphSpacing'), 'settings-options choice-options', paragraphSpacings,
      (value) => [element('span', '', paragraphLabel(value))], (value) => updateAppearance({ paragraph: value }), (value) => value.paragraph, persistent),
    heading(t('appearance.indent')),
    radioGroup(t('appearance.indent'), 'settings-options', switches,
      (value) => [element('span', '', value === 'on' ? t('appearance.indentOn') : t('appearance.indentOff'))],
      (value) => updateAppearance({ indent: value === 'on' }), (value) => value.indent ? 'on' : 'off', persistent),
    heading(t('appearance.textWidth')),
    radioGroup(t('appearance.textWidth'), 'settings-options choice-options', textWidths,
      (value) => [element('span', '', widthLabel(value))], (value) => updateAppearance({ width: value }), (value) => value.width, persistent),
  ]
}

const spellingErrors: Record<SpellingError, string> = {
  name: 'spelling.errorName', bundled: 'spelling.errorBundled', size: 'spelling.errorSize', format: 'spelling.errorFormat',
  link: 'spelling.errorLink', download: 'spelling.errorDownload', busy: 'spelling.errorBusy', locked: 'spelling.errorLocked',
}

function languageName(language: string) {
  try {
    const name = new Intl.DisplayNames([document.documentElement.lang || 'zh-CN'], { type: 'language' }).of(language)
    return name && name !== language ? `${name} (${language})` : language
  } catch {
    return language
  }
}

/** Desktop only: the dictionaries in use, and ways to add one from a file or a link. */
function dictionaryControls(): HTMLElement[] {
  const desktop = window.newWorldDesktop
  if (!desktop?.getSpellingDictionaries) return []
  const box = element('div', 'dictionary-box')
  box.hidden = true
  const title = element('h5', 'dictionary-title', t('spelling.dictionaries'))
  const list = element('ul', 'dictionary-list')
  list.setAttribute('aria-label', t('spelling.dictionaries'))
  const importButton = button(t('spelling.import'), 'button button-quiet button-small')
  const linkLabel = element('label', 'field-label dictionary-link')
  const link = element('input', 'title-input')
  link.type = 'url'
  link.inputMode = 'url'
  link.placeholder = 'https://…/fr-FR-3-0.bdic'
  link.spellcheck = false
  linkLabel.append(element('span', '', t('spelling.link')), link)
  const download = button(t('spelling.download'), 'button button-quiet button-small')
  const linkRow = element('div', 'dictionary-row')
  linkRow.append(linkLabel, download)
  const status = element('p', 'settings-state')
  status.setAttribute('aria-live', 'polite')
  box.append(title, list, importButton, linkRow, status, element('p', 'dialog-help', t('spelling.dictionaryHint')))

  function render(state: SpellingState) {
    box.hidden = !state.supported
    list.replaceChildren()
    for (const language of state.bundled) {
      const item = element('li', 'dictionary-item')
      item.append(element('span', '', languageName(language)), element('span', 'settings-badge', t('spelling.builtIn')))
      list.append(item)
    }
    for (const language of state.added) {
      const item = element('li', 'dictionary-item')
      const remove = button(t('spelling.remove'), 'button button-quiet button-small remove-button')
      remove.setAttribute('aria-label', t('spelling.removeNamed', [languageName(language)]))
      remove.addEventListener('click', () => void run(async () => {
        render(await desktop!.removeSpellingDictionary!(language))
        status.textContent = t('spelling.removed', [languageName(language)])
      }))
      item.append(element('span', '', languageName(language)), remove)
      list.append(item)
    }
  }

  async function run(task: () => Promise<void>) {
    const controls = box.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')
    for (const control of controls) control.disabled = true
    status.classList.remove('field-error')
    try {
      await task()
    } catch {
      status.textContent = t('spelling.errorDownload')
      status.classList.add('field-error')
    } finally {
      for (const control of box.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) control.disabled = false
    }
  }

  function show(result: SpellingResult) {
    render(result.state)
    if (result.error) {
      status.textContent = t(spellingErrors[result.error] ?? 'spelling.errorDownload')
      status.classList.add('field-error')
    } else if (result.added.length) {
      status.textContent = t('spelling.added', [result.added.map(languageName).join('、')])
        + (result.insecure ? ` ${t('spelling.insecure')}` : '')
    } else {
      status.textContent = ''
    }
  }

  importButton.addEventListener('click', () => void run(async () => show(await desktop.importSpellingDictionaries!())))
  const startDownload = () => void run(async () => {
    if (!link.value.trim()) { link.focus(); return }
    status.textContent = t('spelling.downloading')
    const result = await desktop.downloadSpellingDictionary!(link.value)
    show(result)
    if (!result.error) link.value = ''
  })
  download.addEventListener('click', startDownload)
  link.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); startDownload() }
  })
  void desktop.getSpellingDictionaries().then(render, () => { box.hidden = true })
  return [box]
}

/** The appearance section of the settings page, organized into clean subsections. */
export function mountAppearanceSettings(section: HTMLElement) {
  const theme = radioGroup(t('appearance.theme'), 'settings-options theme-options', themes,
    (value) => [swatch(value), element('span', '', themeLabel(value))], (value) => updateAppearance({ theme: value }), (value) => value.theme, true)
  const latin = radioGroup(t('appearance.latinFont'), 'settings-options font-options', latinFonts,
    (value) => [element('span', `font-name font-${value}`, latinLabel(value)), element('span', `font-sample font-${value}`, t('appearance.latinSample'))],
    (value) => updateAppearance({ latin: value }), (value) => value.latin, true)
  const cjk = radioGroup(t('appearance.cjkFont'), 'settings-options font-options', cjkFonts,
    (value) => [
      element('span', `font-name font-${value}`, cjkLabel(value)),
      element('span', `font-sample font-${value}`, value === 'auto' ? t('appearance.cjkAutoHint') : t('appearance.cjkSample')),
    ],
    (value) => updateAppearance({ cjk: value }), (value) => value.cjk, true)

  const themeGroup = element('div', 'settings-subgroup')
  themeGroup.append(
    element('h3', 'settings-group-title', t('settings.appearanceGroupTheme')),
    heading(t('appearance.theme')), theme,
    heading(t('appearance.latinFont')), latin,
    heading(t('appearance.cjkFont')), cjk,
  )

  const typographyGroup = element('div', 'settings-subgroup')
  typographyGroup.append(
    element('h3', 'settings-group-title', t('settings.appearanceGroupTypography')),
    ...readingLayoutControls(true),
  )

  const spellingGroup = element('div', 'settings-subgroup')
  spellingGroup.append(
    element('h3', 'settings-group-title', t('settings.appearanceGroupSpelling')),
    heading(t('appearance.spellcheck')),
    radioGroup(t('appearance.spellcheck'), 'settings-options', switches,
      (value) => [element('span', '', value === 'on' ? t('appearance.on') : t('appearance.off'))],
      (value) => updateAppearance({ spellcheck: value === 'on' }), (value) => value.spellcheck ? 'on' : 'off', true),
    element('p', 'dialog-help', t('appearance.spellcheckHint')),
    ...dictionaryControls(),
  )

  const writingGroup = element('div', 'settings-subgroup')
  const typewriter = element('label', 'appearance-check')
  const typewriterBox = element('input')
  typewriterBox.type = 'checkbox'
  typewriterBox.addEventListener('change', () => updateAppearance({ typewriter: typewriterBox.checked }))
  follow(typewriterBox, (value) => { typewriterBox.checked = value.typewriter }, true)
  typewriter.append(typewriterBox, element('span', '', t('appearance.typewriter')))
  writingGroup.append(
    element('h3', 'settings-group-title', t('appearance.writing')),
    typewriter, element('p', 'dialog-help', t('appearance.typewriterHint')),
  )
  // Only the desktop app plays an opening animation, on a cold start.
  const startupGroup = element('div', 'settings-subgroup')
  if (window.newWorldDesktop) {
    const intro = element('label', 'appearance-check')
    const introBox = element('input')
    introBox.type = 'checkbox'
    introBox.addEventListener('change', () => updateAppearance({ intro: introBox.checked }))
    follow(introBox, (value) => { introBox.checked = value.intro }, true)
    intro.append(introBox, element('span', '', t('appearance.intro')))
    startupGroup.append(
      element('h3', 'settings-group-title', t('appearance.startup')),
      intro, element('p', 'dialog-help', t('appearance.introHint')),
    )
  }
  section.append(typographyGroup, themeGroup, writingGroup, ...(window.newWorldDesktop ? [startupGroup] : []), spellingGroup, element('p', 'dialog-help', t('appearance.hint')))
}

/**
 * The "Aa" button of the reading and writing toolbars. Its panel holds every reading and writing
 * choice in one place; the settings page shows the same choices, and both stay in step.
 */
export function appearanceMenu() {
  const menu = element('div', 'appearance-menu')
  const toggle = button('', 'format-button appearance-toggle')
  toggle.append(element('span', 'format-glyph', 'Aa'))
  toggle.setAttribute('aria-label', t('appearance.title'))
  toggle.title = t('appearance.title')
  menu.append(toggle)
  const alive = () => toggle.isConnected
  const popover = createPopover({ anchor: toggle, label: t('appearance.title'), role: 'group', className: 'appearance-panel', sheetOnNarrow: true })
  const panel = popover.body
  panel.classList.add('appearance-panel-body')
  popover.layer.id = `appearance-panel-${++groups}`
  toggle.setAttribute('aria-controls', popover.layer.id)

  const themeRow = radioGroup(t('appearance.theme'), 'theme-swatches', themes,
    (value) => [swatch(value), element('span', 'visually-hidden', themeLabel(value))], (value) => updateAppearance({ theme: value }), (value) => value.theme, alive)
  for (const [index, item] of [...themeRow.children].entries()) (item as HTMLElement).title = themeLabel(themes[index]!)

  const font = element('select', 'editor-select')
  font.setAttribute('aria-label', t('appearance.latinFont'))
  for (const value of latinFonts) {
    const option = element('option', `font-${value}`, latinLabel(value))
    option.value = value
    font.append(option)
  }
  font.addEventListener('change', () => updateAppearance({ latin: font.value as LatinFont }))
  follow(font, (value) => { font.value = value.latin }, alive)

  const checkbox = (label: string, read: (value: Appearance) => boolean, write: (on: boolean) => void) => {
    const row = element('label', 'appearance-check')
    const box = element('input')
    box.type = 'checkbox'
    box.addEventListener('change', () => write(box.checked))
    follow(box, (value) => { box.checked = read(value) }, alive)
    row.append(element('span', '', label), box)
    return row
  }
  const segments = <T extends string>(label: string, values: readonly T[], name: (value: T) => string, select: (value: T) => void, current: (value: Appearance) => T) =>
    radioGroup(label, 'aa-segments', values, (value) => [element('span', '', name(value))], select, current, alive)
  const row = (label: string, control: HTMLElement) => {
    const line = element('div', 'aa-row')
    line.append(element('span', 'aa-label', label), control)
    return line
  }

  const more = button(t('appearance.more'), 'appearance-more')
  panel.append(
    themeRow,
    row(t('appearance.textSize'), sizeControls(false, alive)),
    row(t('appearance.latinFont'), font),
    row(t('appearance.lineHeight'), segments(t('appearance.lineHeight'), lineHeights, lineHeightLabel, (value) => updateAppearance({ lineHeight: value }), (value) => value.lineHeight)),
    row(t('appearance.paragraphSpacing'), segments(t('appearance.paragraphSpacing'), paragraphSpacings, paragraphLabel, (value) => updateAppearance({ paragraph: value }), (value) => value.paragraph)),
    row(t('appearance.textWidth'), segments(t('appearance.textWidth'), textWidths, widthLabel, (value) => updateAppearance({ width: value }), (value) => value.width)),
    checkbox(t('appearance.indentOn'), (value) => value.indent, (on) => updateAppearance({ indent: on })),
    checkbox(t('appearance.spellcheck'), (value) => value.spellcheck, (on) => updateAppearance({ spellcheck: on })),
    more,
  )
  toggle.addEventListener('mousedown', (event) => event.preventDefault())
  toggle.addEventListener('click', () => popover.toggle())
  more.addEventListener('click', () => {
    popover.close()
    openAppearanceSettings()
  })
  /** Opens the panel under another control, used when the toolbar has folded "Aa" into "⋯". */
  return Object.assign(menu, { openPanel: (from?: HTMLElement) => popover.open(true, from) })
}
