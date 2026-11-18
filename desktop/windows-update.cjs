const { spawn } = require('node:child_process')
const { rmdir, stat } = require('node:fs/promises')
const { join } = require('node:path')
const { findInstaller, isNewerWindowsTag, isUpdateUrl } = require('./windows-release.mjs')
const { downloadVerified, installerRequest, matchesInstaller } = require('./update-download.cjs')
const { cleanDownloads, downloadDirectory, remove: removeDownload } = require('./cleanup.cjs')

class UpdateError extends Error {}

const invalidPackage = "windowsUpdate.theInstallerSizeOrSha256ChecksumDoes"
const downloadFailed = "windowsUpdate.theInstallerCouldNotBeDownloadedCheckYour"
const installFailed = "windowsUpdate.theUpdateInstallerCouldNotBeStartedMake"

async function officialInstaller(request, tag) {
  const installer = await findInstaller(request, tag, 'win32', 'x64')
  if (!installer) throw new UpdateError("windowsUpdate.noVerifiableWindowsInstallerIsAvailableForThis")
  return installer
}

async function saveVerifiedInstaller(request, installer, path, progress) {
  try {
    await downloadVerified({ request, sources: [installer.mirror, installer.url], size: installer.size, sha256: installer.sha256, path, progress })
  } catch (error) {
    throw new UpdateError(error?.kind === 'invalid' ? invalidPackage : downloadFailed)
  }
}

function launchInstaller(path, installDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(path, ['/S', '--updated', '--force-run'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, NEW_WORLD_UPDATE_INSTALL_DIR: installDir },
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function createWindowsUpdater({ network, connection, cache, installDir, version }) {
  const cleanup = cleanDownloads(cache, version)
  let ready
  let downloading = false
  let installing = false

  const request = installerRequest(network, isUpdateUrl, connection)

  async function download(tag, progress) {
    if (!isNewerWindowsTag(tag, version)) throw new UpdateError("windowsUpdate.thisVersionCannotBeUsedForAnUpdate")
    if (downloading || installing) throw new UpdateError("windowsUpdate.anotherUpdateIsInProgressPleaseWait")
    if (ready?.tag === tag) return
    downloading = true
    let directory
    try {
      await cleanup
      const installed = await stat(join(installDir, 'Uninstall New World.exe')).catch(() => undefined)
      if (!installed?.isFile()) throw new UpdateError(installFailed)
      if (ready) {
        await removeDownload(ready.directory)
        ready = undefined
      }
      const installer = await officialInstaller(request, tag)
      directory = await downloadDirectory(cache, tag)
      const path = join(directory, installer.name)
      await saveVerifiedInstaller(request, installer, path, progress)
      ready = { ...installer, path, directory }
    } catch (error) {
      if (directory) await rmdir(directory).catch(() => {})
      throw error instanceof UpdateError ? error : new UpdateError(downloadFailed)
    } finally {
      downloading = false
    }
  }

  async function install(tag) {
    if (downloading || installing || !ready || ready.tag !== tag) throw new UpdateError("windowsUpdate.downloadAndVerifyThisVersionSInstallerFirst")
    installing = true
    try {
      if (!await matchesInstaller(ready.path, ready.size, ready.sha256)) throw new UpdateError(invalidPackage)
      await launchInstaller(ready.path, installDir)
    } catch (error) {
      await removeDownload(ready.directory)
      ready = undefined
      installing = false
      throw error instanceof UpdateError ? error : new UpdateError(installFailed)
    }
  }

  return { download, install }
}

module.exports = { createWindowsUpdater, UpdateError }
