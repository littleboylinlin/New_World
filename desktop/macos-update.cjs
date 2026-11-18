const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { mkdir, mkdtemp, stat } = require('node:fs/promises')
const { join } = require('node:path')
const { cleanDownloads, cleanLegacyMacDownloads, remove } = require('./cleanup.cjs')
const { downloadVerified } = require('./update-download.cjs')

class MacUpdateError extends Error {}

async function verify(installer) {
  if ((await stat(installer.path)).size !== installer.size) throw new MacUpdateError('windowsUpdate.theInstallerSizeOrSha256ChecksumDoes')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(installer.path)) hash.update(chunk)
  if (hash.digest('hex') !== installer.sha256) throw new MacUpdateError('windowsUpdate.theInstallerSizeOrSha256ChecksumDoes')
}

async function createMacUpdater({ network, version, arch, cache, legacyDownloads, installer }) {
  const { isNewerTag, findInstaller, isInstallerUrl } = await import('./release.mjs')
  let ready
  let busy = false
  const cleanup = Promise.all([cleanDownloads(cache), legacyDownloads && cleanLegacyMacDownloads(legacyDownloads)])
  network.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, done) => {
    done({ cancel: request.method !== 'GET' || !isInstallerUrl(request.url, 'darwin', arch) })
  })
  const request = (url, options) => network.fetch(url, { credentials: 'omit', cache: 'no-store', ...options })

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
      await mkdir(cache, { recursive: true, mode: 0o700 })
      directory = await mkdtemp(join(cache, 'download-'))
      const destination = join(directory, installer.name)
      try {
        await downloadVerified({ request, sources: [installer.url, installer.mirror], size: installer.size, sha256: installer.sha256, path: destination, progress })
      } catch (error) {
        throw new MacUpdateError(error?.kind === 'invalid' ? 'windowsUpdate.theInstallerSizeOrSha256ChecksumDoes' : 'windowsUpdate.theInstallerCouldNotBeDownloadedCheckYour')
      }
      ready = { ...installer, path: destination, directory }
      directory = undefined
    } catch (error) {
      if (directory) await remove(directory)
      throw error instanceof MacUpdateError ? error : new MacUpdateError('windowsUpdate.theInstallerCouldNotBeDownloadedCheckYour')
    } finally {
      busy = false
    }
  }

  async function install(tag) {
    if (busy || !ready || ready.tag !== tag) throw new MacUpdateError('windowsUpdate.downloadAndVerifyThisVersionSInstallerFirst')
    busy = true
    try {
      await verify(ready)
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
