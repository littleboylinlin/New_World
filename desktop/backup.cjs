'use strict'

// Where and how often the desktop app writes library backups. The backups themselves are built
// in the page, which owns the library; this module keeps the settings and writes the files.

const { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { basename, join } = require('node:path')

const configName = 'NewWorld-backup.json'
const frequencies = ['off', 'daily', 'weekly']
const intervals = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 }
/** Automatic backups kept in the folder; older ones are deleted. Backups made by hand are never deleted. */
const keepAutomatic = 10
const automaticName = /^New-World-auto-backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/
const backupName = /^New-World-(auto-backup|backup|before-restore)-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/

const defaults = { frequency: 'daily', folder: null, encrypt: false, password: null, lastAutomatic: null }

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
    }
  } catch {
    return { ...defaults }
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

/** Writes a backup file the page built. Returns its path. */
function saveBackup(folder, name, bytes) {
  if (!backupName.test(name) || basename(name) !== name) throw new Error('Invalid backup name')
  mkdirSync(folder, { recursive: true })
  const path = join(folder, name)
  writeFileSync(`${path}.partial`, bytes)
  renameSync(`${path}.partial`, path)
  return path
}

/** Deletes automatic backups beyond the newest ones. Returns the names deleted. */
function pruneAutomatic(folder, keep = keepAutomatic) {
  let names = []
  try { names = readdirSync(folder) } catch { return [] }
  const old = names.filter((name) => automaticName.test(name)).sort().reverse().slice(keep)
  for (const name of old) rmSync(join(folder, name), { force: true })
  return old
}

module.exports = {
  configFile, frequencies, keepAutomatic, readConfig, writeConfig, defaultFolder, folderOf, due, saveBackup, pruneAutomatic,
}
