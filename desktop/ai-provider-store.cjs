const { randomUUID } = require('node:crypto')
const { readFile, rename, unlink, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { credentialInfo, emptyState } = require('../shared/ai-provider/service.mjs')
const { ProviderFailure } = require('../shared/ai-provider/errors.mjs')

function createLocalState(file, initial) {
  let pending = Promise.resolve()

  async function read() {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return initial()
      throw error
    }
  }

  function update(operation) {
    const task = pending.then(async () => {
      const state = await read()
      const result = operation(state)
      const temp = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
        await rename(temp, file)
      } finally {
        await unlink(temp).catch(() => {})
      }
      return result
    })
    pending = task.catch(() => {})
    return task
  }

  return { read: (operation) => pending.then(read).then(operation), update }
}

function systemVault(safeStorage) {
  function protectedOperation(operation) {
    try {
      const protectedBackend = process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
      if (protectedBackend && safeStorage.isEncryptionAvailable()) return operation()
    } catch { /* Keychain failures have a typed result and never fall back to cleartext. */ }
    throw new ProviderFailure('keychain_unavailable')
  }
  return {
    read(profile) {
      if (!profile.credentialEntry) return {}
      return protectedOperation(() => JSON.parse(safeStorage.decryptString(Buffer.from(profile.credentialEntry.encrypted, 'base64'))))
    },
    info(profile) {
      const { hasApiKey = false, savedSecretRefs = [] } = profile.credentialEntry ?? {}
      return { hasApiKey, savedSecretRefs }
    },
    write(profile, credentials) {
      if (!Object.keys(credentials).length) return
      profile.credentialEntry = {
        ...credentialInfo(credentials),
        encrypted: protectedOperation(() => safeStorage.encryptString(JSON.stringify(credentials)).toString('base64')),
      }
    },
    remove(profile) {
      delete profile.credentialEntry
    },
  }
}

function createDesktopProviderStore(profileDir, safeStorage) {
  const state = createLocalState(join(profileDir, 'NewWorld-ai-providers.json'), emptyState)
  const vault = systemVault(safeStorage)
  return {
    kind: 'system',
    read: (operation) => state.read((data) => operation(data, vault)),
    update: (operation) => state.update((data) => operation(data, vault)),
  }
}

module.exports = { createDesktopProviderStore, createLocalState }
