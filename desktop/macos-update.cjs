const { rmdir } = require('node:fs/promises')
const { join } = require('node:path')
const { cleanDownloads, downloadDirectory, cleanLegacyMacDownloads, remove } = require('./cleanup.cjs')
const { downloadVerified, installerRequest, matchesInstaller } = require('./update-download.cjs')

class MacUpdateError extends Error {}

async function createMacUpdater({ network, connection, version, arch, cache, legacyDownloads, installer }) {
  const { isNewerTag, findInstaller, isInstallerUrl } = await import('./release.mjs')
  let ready
  let busy = false
  const cleanup = Promise.all([cleanDownloads(cache, version), legacyDownloads && cleanLegacyMacDownloads(legacyDownloads)])
  const request = installerRequest(network, (url) => isInstallerUrl(url, 'darwin', arch), connection)

  async function download(tag, progress) {
    if (!isNewerTag(tag, version)) throw new MacUpdateError('windowsUpdate.thisVersionCannotBeUsedForAnUpdate')
    if (busy) throw new MacUpdateError('windowsUpdate.anotherUpdateIsInProgressPleaseWait')
    if (ready?.tag === tag) return
    busy = true
    let directory
    try {
      await cleanup
      if (ready) { await remove(ready.directory); ready = undefined }
      const installer = await findInstaller(request, tag, 'darwin', arch)
      if (!installer) throw new MacUpdateError('macUpdate.unavailable')
      directory = await downloadDirectory(cache, tag)
      const destination = join(directory, installer.name)
      await downloadVerified({ request, sources: [installer.mirror, installer.url], size: installer.size, sha256: installer.sha256, path: destination, progress })
      ready = { ...installer, path: destination, directory }
    } catch (error) {
      if (directory) await rmdir(directory).catch(() => {})
      throw error instanceof MacUpdateError ? error : new MacUpdateError(error?.kind === 'invalid'
        ? 'windowsUpdate.theInstallerSizeOrSha256ChecksumDoes' : 'windowsUpdate.theInstallerCouldNotBeDownloadedCheckYour')
    } finally {
      busy = false
    }
  }

  async function install(tag) {
    if (busy || !ready || ready.tag !== tag) throw new MacUpdateError('windowsUpdate.downloadAndVerifyThisVersionSInstallerFirst')
    busy = true
    try {
      if (!await matchesInstaller(ready.path, ready.size, ready.sha256)) throw new MacUpdateError('windowsUpdate.theInstallerSizeOrSha256ChecksumDoes')
      const plan = await installer.prepare(ready.path, tag)
      await installer.install(plan)
      await remove(ready.directory)
      ready = undefined
    } catch (error) {
      if (ready) await remove(ready.directory)
      ready = undefined
      if (!(error instanceof MacUpdateError)) console.warn('New World Mac update failed:', error.message)
      throw error instanceof MacUpdateError ? error : new MacUpdateError('macUpdate.openFailed')
    } finally { busy = false }
  }

  return { download, install }
}

module.exports = { createMacUpdater, MacUpdateError }
