const { readdir, rm, rmdir, stat } = require('node:fs/promises')
const { join } = require('node:path')

const started = Date.now()
const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const pendingPack = new RegExp(`^(?:(?:en|zh-CN)\\.json\\.${uuid}|download-[0-9a-f]{32})\\.tmp$`, 'i')
const pendingPreference = new RegExp(`^(?:language\\.json\\.${uuid}|language-[0-9a-f]{32})\\.tmp$`, 'i')
const legacyMacDownload = new RegExp(`^New-World-(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)-macos-(?:arm64|x64)\\.dmg\\.${uuid}\\.download$`, 'i')

const entries = (directory) => readdir(directory, { withFileTypes: true }).catch(() => [])

async function remove(path) {
  try {
    await rm(path, { force: true, recursive: true, maxRetries: 8, retryDelay: 500 })
    return true
  } catch (error) {
    console.warn('New World cleanup will retry on the next start:', path, error.code)
    return false
  }
}

async function cleanDownloads(cache) {
  for (const entry of await entries(cache)) {
    if (entry.isDirectory() && /^download-[0-9A-Za-z]{6}$/.test(entry.name)) await remove(join(cache, entry.name))
  }
}

async function cleanOldFiles(directory, matches) {
  for (const entry of await entries(directory)) {
    if (!entry.isFile() || !matches(entry.name)) continue
    const path = join(directory, entry.name)
    const info = await stat(path).catch(() => undefined)
    if (info && info.mtimeMs < started) {
      await rm(path, { force: true }).catch((error) => console.warn('New World temporary file cleanup:', error.code))
    }
  }
}

async function cleanLanguageCache(root, version) {
  const { isNewerTag } = await import('./release.mjs')
  const packs = join(root, 'packs')
  for (const entry of await entries(packs)) {
    if (!entry.isDirectory()) continue
    const directory = join(packs, entry.name)
    const obsolete = isNewerTag('v' + version, entry.name)
    if (entry.name !== version && !obsolete) continue
    for (const file of await entries(directory)) {
      if (obsolete && file.isFile() && /^(en|zh-CN)\.json$/.test(file.name)) {
        await rm(join(directory, file.name), { force: true }).catch((error) => console.warn('New World language cache cleanup:', error.code))
      }
    }
    await cleanOldFiles(directory, (name) => pendingPack.test(name))
    if (obsolete) await rmdir(directory).catch(() => {})
  }
  await cleanOldFiles(root, (name) => pendingPreference.test(name))
}

async function cleanLegacyMacDownloads(directory) {
  await cleanOldFiles(directory, (name) => legacyMacDownload.test(name))
}

module.exports = { cleanDownloads, cleanLanguageCache, cleanLegacyMacDownloads, remove }
