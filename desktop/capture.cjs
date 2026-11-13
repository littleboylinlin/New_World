'use strict'

// The quick note shortcut, the tray menu and the right-click menu of the desktop app.

const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const configName = 'NewWorld-capture.json'
/** Shortcuts offered in the settings. Control + Alt + N is ⌃⌥N on a Mac. */
const shortcuts = ['Control+Alt+N', 'Control+Shift+Space', 'Alt+Shift+N', 'off']
const defaultShortcut = shortcuts[0]

function configFile(appData) {
  return join(appData, configName)
}

function readShortcut(appData) {
  try {
    const stored = JSON.parse(readFileSync(configFile(appData), 'utf8')).shortcut
    return shortcuts.includes(stored) ? stored : defaultShortcut
  } catch {
    return defaultShortcut
  }
}

function writeShortcut(appData, shortcut) {
  if (!shortcuts.includes(shortcut)) throw new Error('Invalid shortcut')
  mkdirSync(appData, { recursive: true })
  const path = configFile(appData)
  writeFileSync(`${path}.partial`, `${JSON.stringify({ shortcut })}\n`)
  renameSync(`${path}.partial`, path)
  return shortcut
}

/** How a shortcut is written on this platform, such as Ctrl + Alt + N or ⌃⌥N. */
function shortcutLabel(shortcut, platform = process.platform) {
  if (shortcut === 'off') return ''
  const mac = platform === 'darwin'
  const names = mac
    ? { Control: '⌃', Alt: '⌥', Shift: '⇧', Space: 'Space' }
    : { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Space: 'Space' }
  const parts = shortcut.split('+').map((part) => names[part] ?? part)
  return mac ? parts.join('') : parts.join(' + ')
}

const workHash = /^#\/(original|reference)\/[0-9a-f-]{36}$/

/** The recent works the page reports for the tray menu, checked and trimmed. */
function recentWorks(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item?.title === 'string' && item.title && typeof item.hash === 'string' && workHash.test(item.hash))
    .slice(0, 5).map((item) => ({ title: item.title.slice(0, 80), hash: item.hash }))
}

/** The tray menu. Actions come in as functions so this stays free of Electron. */
function trayTemplate({ t, shortcut, recent, capture, command, showFolder, settings, show, quit }) {
  const label = shortcutLabel(shortcut)
  return [
    { label: label ? `${t('ideas.capture')}\t${label}` : t('ideas.capture'), click: capture },
    { label: t('shelf.newNovel'), click: () => command({ type: 'new-novel' }) },
    { label: t('tray.recent'), submenu: recent.length
      ? recent.map((work) => ({ label: work.title, click: () => command({ type: 'open', hash: work.hash }) }))
      : [{ label: t('tray.noRecent'), enabled: false }] },
    { label: t('ideas.title'), click: () => command({ type: 'ideas' }) },
    { type: 'separator' },
    { label: t('backup.now'), click: () => command({ type: 'backup' }, false) },
    { label: t('backup.showFolder'), click: showFolder },
    { type: 'separator' },
    { label: `${t('settings.title')}…`, click: settings },
    { label: t('main.showNewWorld'), click: show },
    { label: t('settings.quit'), click: quit },
  ]
}

/**
 * The right-click menu for text: spelling suggestions, then cut, copy and paste, then keeping the
 * selected text as an idea. Returns null where there is nothing to offer.
 */
function contextTemplate(params, { t, replace, learn, saveIdea }) {
  const items = []
  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, 6).map((word) => ({ label: word, click: () => replace(word) }))
    items.push(...(suggestions.length ? suggestions : [{ label: t('spelling.noSuggestions'), enabled: false }]))
    items.push({ label: t('spelling.addToDictionary'), click: () => learn(params.misspelledWord) }, { type: 'separator' })
  }
  const selected = typeof params.selectionText === 'string' ? params.selectionText.trim() : ''
  if (params.isEditable) {
    items.push(
      { role: 'cut', label: t('main.cut'), enabled: params.editFlags.canCut },
      { role: 'copy', label: t('main.copy'), enabled: params.editFlags.canCopy },
      { role: 'paste', label: t('main.paste'), enabled: params.editFlags.canPaste },
      { role: 'selectAll', label: t('common.selectAll') },
    )
  } else if (selected) {
    items.push({ role: 'copy', label: t('main.copy') })
  }
  if (selected && saveIdea) items.push({ type: 'separator' }, { label: t('ideas.saveSelection'), click: () => saveIdea(selected) })
  return items.length ? items : null
}

module.exports = { configFile, shortcuts, defaultShortcut, readShortcut, writeShortcut, shortcutLabel, recentWorks, trayTemplate, contextTemplate }
