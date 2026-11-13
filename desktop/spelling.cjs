'use strict'

// English spell checking for the chapter text. Windows uses Chromium's Hunspell dictionaries,
// which normally download on first use; the app ships US and UK English instead so nothing is
// downloaded. Writers can add other Chromium dictionaries from a file or a link of their choice.
// macOS uses the system spell checker and needs no files.

const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { basename, join } = require('node:path')

const languages = ['en-US', 'en-GB']
const bundled = join(__dirname, 'dictionaries')
/** Largest dictionary accepted; Chromium's own are under 10 MB. */
const maxBytes = 30 * 1024 * 1024
// Chromium only loads a dictionary saved under the exact name it expects for its version.
const catalog = JSON.parse(readFileSync(join(bundled, 'catalog.json'), 'utf8')).files

class DictionaryError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function folder(profile) {
  return join(profile, 'Dictionaries')
}

/**
 * The language a dictionary file is for and the exact name Chromium loads it under, or null when
 * Chromium would not load a file of that name. Chromium's download server uses lower case names.
 */
function dictionaryFile(fileName) {
  const wanted = fileName.toLowerCase()
  for (const [language, names] of Object.entries(catalog)) {
    const name = names.find((candidate) => candidate.toLowerCase() === wanted)
    if (name) return { language, name }
  }
  return null
}

function languageOf(fileName) {
  return dictionaryFile(fileName)?.language ?? null
}

function writeAtomically(path, bytes) {
  const partial = `${path}.partial`
  writeFileSync(partial, bytes)
  try {
    renameSync(partial, path)
  } catch (error) {
    rmSync(partial, { force: true })
    // Windows keeps a dictionary in use locked until the app restarts.
    if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw new DictionaryError('locked')
    throw error
  }
}

// Dictionaries removed while Chromium still had them open; deleted at the next start.
const removalList = '.removed.json'

function pendingRemovals(profile) {
  try {
    const list = JSON.parse(readFileSync(join(folder(profile), removalList), 'utf8'))
    return Array.isArray(list) ? list.filter((language) => typeof language === 'string' && catalog[language]) : []
  } catch {
    return []
  }
}

function savePendingRemovals(profile, list) {
  const path = join(folder(profile), removalList)
  if (list.length) writeFileSync(path, `${JSON.stringify([...new Set(list)])}\n`)
  else rmSync(path, { force: true })
}

/** Deletes a language's files; returns false when Windows still has one locked. */
function deleteFiles(profile, language) {
  let done = true
  for (const name of catalog[language]) {
    try { rmSync(join(folder(profile), name), { force: true }) } catch { done = false }
  }
  return done
}

/** Copies the bundled dictionaries into the profile's Dictionaries folder. Returns the names copied. */
function installDictionaries(profile, source = bundled) {
  const target = folder(profile)
  mkdirSync(target, { recursive: true })
  deletePendingRemovals(profile)
  const copied = []
  for (const name of readdirSync(source)) {
    if (!name.endsWith('.bdic') || existsSync(join(target, name))) continue
    writeAtomically(join(target, name), readFileSync(join(source, name)))
    copied.push(name)
  }
  return copied
}

/** Checks a dictionary before it is saved and returns its language. */
function checkDictionary(fileName, bytes) {
  const file = dictionaryFile(basename(fileName))
  if (!file) throw new DictionaryError('name')
  const { language, name } = file
  if (languages.includes(language)) throw new DictionaryError('bundled')
  if (bytes.length > maxBytes) throw new DictionaryError('size')
  if (bytes.length < 16 || Buffer.from(bytes.subarray(0, 4)).toString('latin1') !== 'BDic') throw new DictionaryError('format')
  return { name, language }
}

/** Saves a dictionary the writer added. Returns its language. */
function addDictionary(profile, fileName, bytes) {
  const { name, language } = checkDictionary(fileName, bytes)
  mkdirSync(folder(profile), { recursive: true })
  // Only one file per language, so a newer one replaces the older.
  for (const old of catalog[language]) {
    if (old === name) continue
    try { rmSync(join(folder(profile), old), { force: true }) } catch { throw new DictionaryError('locked') }
  }
  writeAtomically(join(folder(profile), name), bytes)
  savePendingRemovals(profile, pendingRemovals(profile).filter((pending) => pending !== language))
  return language
}

/** Languages of the dictionaries the writer added, in alphabetical order. */
function addedLanguages(profile) {
  let names = []
  try { names = readdirSync(folder(profile)) } catch { return [] }
  const removed = pendingRemovals(profile)
  const found = new Set(names.filter((name) => catalog[languageOf(name)]?.includes(name)).map(languageOf)
    .filter((language) => !languages.includes(language) && !removed.includes(language)))
  return [...found].sort()
}

/** Stops using a dictionary the writer added. Its files are deleted by deletePendingRemovals. */
function removeDictionary(profile, language) {
  if (languages.includes(language) || !catalog[language]) throw new DictionaryError('bundled')
  mkdirSync(folder(profile), { recursive: true })
  savePendingRemovals(profile, [...pendingRemovals(profile), language])
}

/** Deletes the files of removed dictionaries; returns the languages Windows still has locked. */
function deletePendingRemovals(profile) {
  const left = pendingRemovals(profile).filter((language) => !deleteFiles(profile, language))
  savePendingRemovals(profile, left)
  return left
}

/** Chromium's code for a dictionary language: af-ZA is loaded as "af", fr-FR as "fr-FR". */
function chromiumLanguage(language, available) {
  if (available.includes(language)) return language
  const base = language.split('-')[0]
  return available.includes(base) ? base : null
}

/** The languages to check: the bundled ones, then the added ones Chromium knows about. */
function activeLanguages(profile, available) {
  const codes = [...languages, ...addedLanguages(profile)].map((language) => chromiumLanguage(language, available))
  return [...new Set(codes.filter(Boolean))]
}

/** A link to download a dictionary from: https only, without credentials, ending in a dictionary name. */
function downloadName(link) {
  let url
  try { url = new URL(link) } catch { throw new DictionaryError('link') }
  if (url.protocol !== 'https:' || url.username || url.password) throw new DictionaryError('link')
  let name = ''
  try { name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '') } catch { throw new DictionaryError('link') }
  if (!dictionaryFile(name)) throw new DictionaryError('name')
  return { url: url.href, name }
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

module.exports = {
  languages, maxBytes, DictionaryError, languageOf, chromiumLanguage, installDictionaries, checkDictionary, addDictionary,
  addedLanguages, removeDictionary, deletePendingRemovals, activeLanguages, downloadName, menuTemplate,
}
