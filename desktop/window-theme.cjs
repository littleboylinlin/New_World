'use strict'

// The main process opens the window before the page can apply its theme. It keeps a copy of
// the chosen theme so the window starts with the matching background instead of flashing.

const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const configName = 'NewWorld-appearance.json'
const themes = ['system', 'white', 'dark', 'beige']
// Page backgrounds, matching --paper in src/appearance.css.
const backgrounds = { white: '#f4eee2', dark: '#131210', beige: '#ebdfc5' }

function configFile(appData) {
  return join(appData, configName)
}

function isTheme(value) {
  return themes.includes(value)
}

function readTheme(appData) {
  try {
    const parsed = JSON.parse(readFileSync(configFile(appData), 'utf8'))
    return isTheme(parsed.theme) ? parsed.theme : 'system'
  } catch {
    return 'system'
  }
}

function writeTheme(appData, theme) {
  if (!isTheme(theme)) throw new Error('Invalid theme')
  mkdirSync(appData, { recursive: true })
  writeFileSync(configFile(appData), `${JSON.stringify({ theme })}\n`, 'utf8')
}

/** The value for Electron's nativeTheme.themeSource. */
function themeSource(theme) {
  if (theme === 'dark') return 'dark'
  return theme === 'system' ? 'system' : 'light'
}

function backgroundColor(theme, systemDark) {
  if (theme === 'system') return systemDark ? backgrounds.dark : backgrounds.white
  return backgrounds[theme] ?? backgrounds.white
}

module.exports = { configFile, themes, isTheme, readTheme, writeTheme, themeSource, backgroundColor }
