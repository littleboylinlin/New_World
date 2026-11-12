const { createHash, randomUUID } = require('node:crypto')
const { createReadStream, createWriteStream } = require('node:fs')
const { rename, rm, stat } = require('node:fs/promises')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

class MacUpdateError extends Error {}

async function verify(installer) {
  if ((await stat(installer.path)).size !== installer.size) throw new MacUpdateError('windowsUpdate.theInstallerSizeOrSha256ChecksumDoes')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(installer.path)) hash.update(chunk)
  if (hash.digest('hex') !== installer.sha256) throw new MacUpdateError('windowsUpdate.theInstallerSizeOrSha256ChecksumDoes')
}

async function createMacUpdater({ network, version, arch, chooseDestination, openPackage }) {
  const { isNewerTag, readMacInstaller, releaseEndpoint, isInstallerUrl } = await import('./release.mjs')
  let ready
  let busy = false
  network.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, done) => {
    done({ cancel: request.method !== 'GET' || !isInstallerUrl(request.url, 'darwin', arch) })
  })
  const request = (url, options) => network.fetch(url, { credentials: 'omit', cache: 'no-store', ...options })

  async function download(tag, progress) {
    if (!isNewerTag(tag, version)) throw new MacUpdateError('windowsUpdate.thisVersionCannotBeUsedForAnUpdate')
    if (busy) throw new MacUpdateError('windowsUpdate.anotherUpdateIsInProgressPleaseWait')
    if (ready?.tag === tag) return
    busy = true
    let temporary
    try {
      const metadata = await request(releaseEndpoint + '/tags/' + tag, {
        headers: { Accept: 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(8000),
      })
      const release = metadata.ok && await metadata.json()
      const installer = release?.tag_name === tag && release.draft === false && release.prerelease === false
        && readMacInstaller(tag, release.assets, arch)
      if (!installer) throw new MacUpdateError('macUpdate.unavailable')
      const destination = await chooseDestination(installer.name)
      if (!destination) return false
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 45_000)
      let received = 0
      let reportedAt = 0
      const hash = createHash('sha256')
      temporary = destination + '.' + randomUUID() + '.download'
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
        temporary = undefined
        ready = { ...installer, path: destination }
      } finally { clearTimeout(timer) }
    } catch (error) {
      throw error instanceof MacUpdateError ? error : new MacUpdateError('windowsUpdate.theInstallerCouldNotBeDownloadedCheckYour')
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => {})
      busy = false
    }
  }

  async function install(tag) {
    if (busy || !ready || ready.tag !== tag) throw new MacUpdateError('windowsUpdate.downloadAndVerifyThisVersionSInstallerFirst')
    busy = true
    try {
      await verify(ready)
      const error = await openPackage(ready.path)
      if (error) throw new MacUpdateError('macUpdate.openFailed')
    } catch (error) {
      ready = undefined
      throw error instanceof MacUpdateError ? error : new MacUpdateError('macUpdate.openFailed')
    } finally { busy = false }
  }

  return { download, install }
}

module.exports = { createMacUpdater, MacUpdateError }
