const { createHash } = require('node:crypto')
const { createReadStream, createWriteStream } = require('node:fs')
const { mkdir, mkdtemp, rename, stat } = require('node:fs/promises')
const { join } = require('node:path')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { cleanDownloads, cleanLegacyMacDownloads, remove } = require('./cleanup.cjs')

class MacUpdateError extends Error {}

async function verify(installer) {
  if ((await stat(installer.path)).size !== installer.size) throw new MacUpdateError('windowsUpdate.theInstallerSizeOrSha256ChecksumDoes')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(installer.path)) hash.update(chunk)
  if (hash.digest('hex') !== installer.sha256) throw new MacUpdateError('windowsUpdate.theInstallerSizeOrSha256ChecksumDoes')
}

async function createMacUpdater({ network, version, arch, cache, legacyDownloads, installer }) {
  const { isNewerTag, readMacInstaller, releaseEndpoint, isInstallerUrl } = await import('./release.mjs')
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
      const metadata = await request(releaseEndpoint + '/tags/' + tag, {
        headers: { Accept: 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(8000),
      })
      const release = metadata.ok && await metadata.json()
      const installer = release?.tag_name === tag && release.draft === false && release.prerelease === false
        && readMacInstaller(tag, release.assets, arch)
      if (!installer) throw new MacUpdateError('macUpdate.unavailable')
      await mkdir(cache, { recursive: true, mode: 0o700 })
      directory = await mkdtemp(join(cache, 'download-'))
      const destination = join(directory, installer.name)
      const temporary = destination + '.download'
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 45_000)
      let received = 0
      let reportedAt = 0
      const hash = createHash('sha256')
      try {
        const response = await request(installer.url, { redirect: 'follow', signal: controller.signal })
        if (!response.ok || !response.body) throw new MacUpdateError('windowsUpdate.theInstallerCouldNotBeDownloadedCheckYour')
        timer.refresh()
        progress(0, installer.size)
        const count = new Transform({ transform(chunk, _encoding, done) {
          timer.refresh()
          received += chunk.length
          if (received > installer.size) return done(new MacUpdateError('windowsUpdate.theInstallerSizeOrSha256ChecksumDoes'))
          hash.update(chunk)
          if (received === installer.size || Date.now() - reportedAt >= 150) {
            reportedAt = Date.now()
            progress(received, installer.size)
          }
          done(null, chunk)
        } })
        await pipeline(Readable.fromWeb(response.body), count, createWriteStream(temporary, { flags: 'wx' }), { signal: controller.signal })
        if (received !== installer.size || hash.digest('hex') !== installer.sha256) throw new MacUpdateError('windowsUpdate.theInstallerSizeOrSha256ChecksumDoes')
        await rename(temporary, destination)
        ready = { ...installer, path: destination, directory }
        directory = undefined
      } finally { clearTimeout(timer) }
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
      throw error instanceof MacUpdateError ? error : new MacUpdateError('macUpdate.openFailed')
    } finally { busy = false }
  }

  return { download, install }
}

module.exports = { createMacUpdater, MacUpdateError }
