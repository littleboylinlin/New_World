'use strict'

// The quick note shortcut, the tray menu and the right-click menu of the desktop app.

const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const configName = 'NewWorld-capture.json'
const defaultShortcut = 'Control+Alt+N'
const modifiers = ['Control', 'Alt', 'Shift', 'Command', 'Super']
const functionKey = /^F(?:[1-9]|1\d|2[0-4])$/
const namedKeys = new Set([
  'Space', 'Tab', 'Return', 'Backspace', 'Escape', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'Left', 'Right', 'Up', 'Down', 'Plus', 'PrintScreen',
  'numadd', 'numsub', 'nummult', 'numdiv', 'numdec',
])

function normalizeShortcut(value) {
  if (value === 'off') return value
  if (typeof value !== 'string' || value.length > 48) return
  const keys = value.split('+')
  let key = keys.pop()
  if (!keys.length || new Set(keys).size !== keys.length || !keys.every((part) => modifiers.includes(part))) return
  if (keys.includes('Command') && keys.includes('Super')) return
  if (key.length === 1) key = key.toUpperCase()
  const isFunctionKey = functionKey.test(key)
  if (keys.length === 1 && keys[0] === 'Shift' && !isFunctionKey) return
  if (!isFunctionKey && !namedKeys.has(key) && !/^(?:[A-Z0-9`\-=\[\]\\;',./]|num[0-9])$/.test(key)) return
  return [...modifiers.filter((part) => keys.includes(part)), key].join('+')
}

function configFile(appData) {
  return join(appData, configName)
}

function readShortcut(appData) {
  try {
    const stored = JSON.parse(readFileSync(configFile(appData), 'utf8')).shortcut
    return normalizeShortcut(stored) ?? defaultShortcut
  } catch {
    return defaultShortcut
  }
}

function writeShortcut(appData, value) {
  const shortcut = normalizeShortcut(value)
  if (!shortcut) throw new Error('Invalid shortcut')
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
    ? { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘', Super: '⌘' }
    : { Control: 'Ctrl', Super: platform === 'win32' ? 'Win' : 'Super', Command: 'Cmd' }
  const parts = shortcut.split('+').map((part) => names[part] ?? part)
  return mac ? parts.join('') : parts.join(' + ')
}

function createShortcutRegistration(appData, globalShortcut, onCapture) {
  let shortcut = readShortcut(appData)
  let registered = false

  function register(value) {
    try {
      return !globalShortcut.isRegistered(value) && globalShortcut.register(value, onCapture)
    } catch {
      return false
    }
  }

  function state() {
    return { shortcut, defaultShortcut, label: shortcutLabel(shortcut), registered: shortcut === 'off' || registered }
  }

  function change(value) {
    const next = normalizeShortcut(value)
    if (!next) return { ok: false, error: 'invalid' }
    if (next === shortcut && (registered || next === 'off')) return { ok: true, state: state() }
    const enabled = next !== 'off'
    if (enabled && !register(next)) return { ok: false, error: 'taken' }
    // Keep the previous binding until the new one is registered and saved.
    try {
      writeShortcut(appData, next)
    } catch (error) {
      if (enabled) globalShortcut.unregister(next)
      throw error
    }
    if (registered) globalShortcut.unregister(shortcut)
    shortcut = next
    registered = enabled
    return { ok: true, state: state() }
  }

  return {
    start() { if (!registered && shortcut !== 'off') registered = register(shortcut) },
    change,
    state,
  }
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
    { label: label ? `${t('capture.title')}\t${label}` : t('capture.title'), click: capture },
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

module.exports = { configFile, readShortcut, writeShortcut, shortcutLabel, createShortcutRegistration, recentWorks, trayTemplate, contextTemplate }
