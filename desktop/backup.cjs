'use strict'

// Where and how often the desktop app writes library backups. The backups themselves are built
// in the page, which owns the library; this module keeps the settings and writes the files.

const { createHash } = require('node:crypto')
const { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } = require('node:fs')
const { basename, join } = require('node:path')

const configName = 'NewWorld-backup.json'
const frequencies = ['off', 'daily', 'weekly']
const intervals = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 }
const managedKinds = ['auto-backup', 'before-restore']
const retentionLimits = [5, 10, 20, null]
const defaultRetention = { 'auto-backup': 10, 'before-restore': 10 }
const backupName = /^New-World-(auto-backup|backup|before-restore)-\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])-(?:[01]\d|2[0-3])[0-5]\d[0-5]\d\.zip$/

const defaults = { frequency: 'daily', folder: null, encrypt: false, password: null, lastAutomatic: null, retention: defaultRetention }

const backupKind = (name) => backupName.exec(name)?.[1]
const validRetention = (kind, limit) => managedKinds.includes(kind) && retentionLimits.includes(limit)

function configFile(appData) {
  return join(appData, configName)
}

function readConfig(appData) {
  try {
    const stored = JSON.parse(readFileSync(configFile(appData), 'utf8'))
    return {
      frequency: frequencies.includes(stored.frequency) ? stored.frequency : defaults.frequency,
      folder: typeof stored.folder === 'string' && stored.folder ? stored.folder : null,
      encrypt: stored.encrypt === true && typeof stored.password === 'string',
      password: typeof stored.password === 'string' ? stored.password : null,
      lastAutomatic: Number.isFinite(stored.lastAutomatic) ? stored.lastAutomatic : null,
      retention: Object.fromEntries(managedKinds.map((kind) => [
        kind, validRetention(kind, stored.retention?.[kind]) ? stored.retention[kind] : defaultRetention[kind],
      ])),
    }
  } catch {
    return { ...defaults, retention: { ...defaultRetention } }
  }
}

function writeConfig(appData, config) {
  mkdirSync(appData, { recursive: true })
  const path = configFile(appData)
  writeFileSync(`${path}.partial`, `${JSON.stringify(config)}\n`, { mode: 0o600 })
  renameSync(`${path}.partial`, path)
  return config
}

function defaultFolder(documents) {
  return join(documents, 'New World Backups')
}

function folderOf(config, documents) {
  return config.folder ?? defaultFolder(documents)
}

/** Whether an automatic backup is due. */
function due(config, now = Date.now()) {
  if (config.frequency === 'off') return false
  return config.lastAutomatic === null || now - config.lastAutomatic >= intervals[config.frequency]
}

function filenames(folder, kind) {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && backupKind(entry.name) === kind)
      .map(({ name }) => name).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function excessBackups(folder, kind, limit) {
  if (!validRetention(kind, limit) || limit === null) return []
  const names = filenames(folder, kind)
  return names.slice(0, Math.max(0, names.length - limit))
}

function fileStamp(folder, name) {
  const entry = lstatSync(join(folder, name), { throwIfNoEntry: false })
  return entry?.isFile() ? [entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.ctimeMs] : undefined
}

/** The confirmation covers only these files in this folder, including their current identities. */
function retentionPlan(folder, kind, limit) {
  const files = excessBackups(folder, kind, limit)
  const entries = files.map((name) => [name, fileStamp(folder, name)])
  const token = createHash('sha256').update(JSON.stringify([folder, kind, limit, entries])).digest('hex')
  return { files, entries, token }
}

function pruneConfirmed(folder, kind, limit, token) {
  if (!validRetention(kind, limit)) return false
  const plan = retentionPlan(folder, kind, limit)
  if (token !== plan.token || plan.entries.some(([, stamp]) => !stamp)) return false
  for (const [name, stamp] of plan.entries) {
    if (JSON.stringify(fileStamp(folder, name)) !== JSON.stringify(stamp)) return false
    unlinkSync(join(folder, name))
  }
  return true
}

/** Preserve existing excess until it is reviewed in settings; trim only the excess a new save creates. */
function saveBackup(folder, name, bytes, retention = {}) {
  const kind = backupKind(name)
  if (!kind || basename(name) !== name) throw new Error('Invalid backup name')
  const limit = retention[kind]
  const trim = validRetention(kind, limit) && limit !== null && !excessBackups(folder, kind, limit).length
  mkdirSync(folder, { recursive: true })
  const path = join(folder, name)
  writeFileSync(`${path}.partial`, bytes)
  renameSync(`${path}.partial`, path)
  if (trim) {
    try {
      const plan = retentionPlan(folder, kind, limit)
      pruneConfirmed(folder, kind, limit, plan.token)
    } catch { /* A locked old file remains listed in Settings. The new backup has been saved. */ }
  }
  return path
}

module.exports = {
  configFile, frequencies, managedKinds, readConfig, writeConfig, defaultFolder, folderOf, due, saveBackup,
  backupKind, validRetention, excessBackups, retentionPlan, pruneConfirmed,
}
