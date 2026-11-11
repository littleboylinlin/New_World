const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { createReadStream, createWriteStream } = require('node:fs')
const { mkdir, mkdtemp, readdir, rm, stat } = require('node:fs/promises')
const { join } = require('node:path')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { isNewerWindowsTag, isUpdateUrl, readWindowsInstaller, releaseEndpoint } = require('./windows-release.mjs')

class UpdateError extends Error {}

const invalidPackage = '安装包大小或 SHA-256 校验不匹配，请重新下载。'
const downloadFailed = '下载安装包失败。请检查网络和可用磁盘空间后重试。'
const installFailed = '无法启动更新安装。请确认当前是通过 Windows 安装包安装的 New World 后重试。'

const removeDownload = (path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {})

async function cleanDownloads(cache) {
  const entries = await readdir(cache, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries.filter((entry) => entry.isDirectory() && /^download-[0-9A-Za-z]{6}$/.test(entry.name))
    .map((entry) => removeDownload(join(cache, entry.name))))
}

async function officialInstaller(request, tag) {
  const release = await request(releaseEndpoint + '/tags/' + tag, {
    headers: { Accept: 'application/vnd.github+json' },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  })
  const metadata = release.ok && await release.json()
  const installer = metadata?.tag_name === tag && metadata.draft === false && metadata.prerelease === false
    && readWindowsInstaller(tag, metadata.assets)
  if (!installer) throw new UpdateError('GitHub 暂未提供此版本可校验的 Windows 安装包，请重新检查更新。')
  return installer
}

async function saveVerifiedInstaller(request, installer, path, progress) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45_000)
  const { signal } = controller
  const hash = createHash('sha256')
  let received = 0
  let reportedAt = 0
  try {
    const response = await request(installer.url, { redirect: 'follow', signal })
    if (!response.ok || !response.body) throw new UpdateError(downloadFailed)
    timeout.refresh()
    progress(0, installer.size)
    const count = new Transform({
      transform(chunk, _encoding, done) {
        timeout.refresh()
        received += chunk.length
        if (received > installer.size) {
          done(new UpdateError(invalidPackage))
          return
        }
        hash.update(chunk)
        const now = Date.now()
        if (received === installer.size || now - reportedAt >= 150) {
          reportedAt = now
          progress(received, installer.size)
        }
        done(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body), count, createWriteStream(path, { flags: 'wx' }), { signal })
    if (received !== installer.size || hash.digest('hex') !== installer.sha256) throw new UpdateError(invalidPackage)
  } finally {
    clearTimeout(timeout)
  }
}

async function verifyOnDisk(installer) {
  if ((await stat(installer.path)).size !== installer.size) throw new UpdateError(invalidPackage)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(installer.path)) hash.update(chunk)
  if (hash.digest('hex') !== installer.sha256) throw new UpdateError(invalidPackage)
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

function createWindowsUpdater({ network, cache, installDir, version }) {
  const cleanup = cleanDownloads(cache)
  let ready
  let downloading = false
  let installing = false

  network.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, done) => {
    done({ cancel: request.method !== 'GET' || !isUpdateUrl(request.url) })
  })
  const request = (address, options) => network.fetch(address, { cache: 'no-store', credentials: 'omit', ...options })

  async function download(tag, progress) {
    if (!isNewerWindowsTag(tag, version)) throw new UpdateError('该版本不能用于更新，请重新检查更新。')
    if (downloading || installing) throw new UpdateError('正在处理另一次更新，请稍候。')
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
      await mkdir(cache, { recursive: true })
      directory = await mkdtemp(join(cache, 'download-'))
      const path = join(directory, installer.name)
      await saveVerifiedInstaller(request, installer, path, progress)
      ready = { ...installer, path, directory }
    } catch (error) {
      if (directory) await removeDownload(directory)
      throw error instanceof UpdateError ? error : new UpdateError(downloadFailed)
    } finally {
      downloading = false
    }
  }

  async function install(tag) {
    if (downloading || installing || !ready || ready.tag !== tag) throw new UpdateError('请先下载并校验此版本的安装包。')
    installing = true
    try {
      await verifyOnDisk(ready)
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
