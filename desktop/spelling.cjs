'use strict'

// English spell checking for the chapter text. Windows uses Chromium's Hunspell dictionaries,
// which normally download on first use; the app ships them instead so nothing is downloaded.
// macOS uses the system spell checker and needs no files.

const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const languages = ['en-US', 'en-GB']
const bundled = join(__dirname, 'dictionaries')

/** Copies the bundled dictionaries into the profile's Dictionaries folder. Returns the names copied. */
function installDictionaries(profile, source = bundled) {
  const target = join(profile, 'Dictionaries')
  mkdirSync(target, { recursive: true })
  const copied = []
  for (const name of readdirSync(source)) {
    if (!name.endsWith('.bdic') || existsSync(join(target, name))) continue
    const partial = join(target, `${name}.partial`)
    writeFileSync(partial, readFileSync(join(source, name)))
    renameSync(partial, join(target, name))
    copied.push(name)
  }
  return copied
}

/** Menu items for a right click on a misspelt word, or null for any other right click. */
function menuTemplate(params, { replace, learn, t }) {
  if (!params.misspelledWord) return null
  const suggestions = params.dictionarySuggestions.slice(0, 6).map((word) => ({ label: word, click: () => replace(word) }))
  return [
    ...(suggestions.length ? suggestions : [{ label: t('spelling.noSuggestions'), enabled: false }]),
    { type: 'separator' },
    { label: t('spelling.addToDictionary'), click: () => learn(params.misspelledWord) },
  ]
}

module.exports = { languages, installDictionaries, menuTemplate }
