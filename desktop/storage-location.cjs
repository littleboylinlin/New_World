'use strict'

const { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { isAbsolute, join, relative, resolve } = require('node:path')

const configName = 'NewWorld-location.json'
const dataDirs = ['IndexedDB', 'Local Storage', 'Session Storage']

function configFile(appData) {
  return join(appData, configName)
}

function defaultLocation(appData) {
  return join(appData, 'NewWorld')
}

function describe(current, appData, extra = {}) {
  return { current, custom: current !== defaultLocation(appData), ...extra }
}

function readLocation(appData) {
  try {
    const parsed = JSON.parse(readFileSync(configFile(appData), 'utf8'))
    const current = typeof parsed.current === 'string' && isAbsolute(parsed.current)
      ? parsed.current : defaultLocation(appData)
    const raw = parsed.pending
    const pending = raw && typeof raw.from === 'string' && typeof raw.to === 'string'
      && isAbsolute(raw.from) && isAbsolute(raw.to) ? { from: raw.from, to: raw.to } : null
    return { current, custom: current !== defaultLocation(appData), pending }
  } catch {
    return { current: defaultLocation(appData), custom: false, pending: null }
  }
}

function writeLocation(appData, value) {
  mkdirSync(appData, { recursive: true })
  writeFileSync(configFile(appData), `${JSON.stringify(value)}\n`, 'utf8')
}

function isWithin(child, parent) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function validateTarget(target, { current, appData, programDir }) {
  if (typeof target !== 'string' || !target.trim() || !isAbsolute(target) || target.length > 240) {
    return "storageLocation.chooseAValidFolder"
  }
  const to = resolve(target)
  if (to === resolve(current)) return "storageLocation.theLibraryIsAlreadyStoredHere"
  if (isWithin(to, current) || isWithin(current, to)) return "storageLocation.theNewLocationCannotBeInsideTheCurrent"
  if (to === resolve(appData)) return "storageLocation.chooseASeparateFolderNotTheRootUser"
  if (programDir && isWithin(to, programDir)) return "storageLocation.theLibraryCannotBeStoredInTheNew"
  if (existsSync(to)) {
    if (!statSync(to).isDirectory()) return "storageLocation.thisLocationIsNotAFolder"
    const entries = readdirSync(to)
    if (entries.length && !entries.includes('IndexedDB')) return "storageLocation.chooseAnEmptyFolderOrAPreviouslyUsed"
  }
  return null
}

function copyLibrary(from, to) {
  mkdirSync(to, { recursive: true })
  for (const name of dataDirs) {
    const source = join(from, name)
    if (!existsSync(source)) continue
    const destination = join(to, name)
    rmSync(destination, { recursive: true, force: true })
    cpSync(source, destination, { recursive: true })
  }
}

function applyPending(appData, { programDir } = {}) {
  const { current, pending } = readLocation(appData)
  if (!pending) return describe(current, appData, { moved: false, error: null })
  const problem = pending.to === pending.from
    ? "storageLocation.theLocationHasNotChanged" : validateTarget(pending.to, { current: pending.from, appData, programDir })
  if (problem) {
    writeLocation(appData, { current: pending.from, pending: null })
    return describe(pending.from, appData, { moved: false, error: problem })
  }
  try {
    copyLibrary(pending.from, pending.to)
    writeLocation(appData, { current: pending.to, pending: null })
    return describe(pending.to, appData, { moved: true, error: null })
  } catch {
    writeLocation(appData, { current: pending.from, pending: null })
    return describe(pending.from, appData, { moved: false, error: "storageLocation.theLibraryCouldNotBeMovedItsOriginal" })
  }
}

function setLocation(appData, target, { programDir } = {}) {
  const { current } = readLocation(appData)
  const problem = validateTarget(target, { current, appData, programDir })
  if (problem) return { error: problem }
  const to = resolve(target)
  writeLocation(appData, { current, pending: { from: current, to } })
  return { error: null, from: current, to }
}

function resetLocation(appData) {
  const { current } = readLocation(appData)
  const to = defaultLocation(appData)
  if (current === to) return { error: null, unchanged: true, to }
  writeLocation(appData, { current, pending: { from: current, to } })
  return { error: null, unchanged: false, from: current, to }
}

module.exports = {
  configFile, defaultLocation, readLocation, writeLocation,
  validateTarget, copyLibrary, applyPending, setLocation, resetLocation,
}
