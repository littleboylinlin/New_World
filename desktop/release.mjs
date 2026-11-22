const repository = 'littleboylinlin/New_World'
export const releaseEndpoint = 'https://api.github.com/repos/' + repository + '/releases'
export const releasePages = 'https://github.com/' + repository + '/releases/'
export const desktopReleaseList = releaseEndpoint + '?per_page=100'
// Release files mirrored to R2. Not writenewworld.com, which redirects visitors from some regions.
export const mirrorBase = 'https://dl.writenewworld.com/'
export const mirrorLatest = mirrorBase + 'latest.json'

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const cdnHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
export const maxInstallerBytes = 1024 * 1024 * 1024

export function isStableTag(tag) {
  return typeof tag === 'string' && tag.length <= 40 && tag.trim() === tag && stableTag.test(tag)
}

export function isNewerTag(tag, currentVersion) {
  const current = 'v' + currentVersion
  if (!isStableTag(tag) || !isStableTag(current)) return false
  const before = current.slice(1).split('.').map(BigInt)
  const after = tag.slice(1).split('.').map(BigInt)
  for (const [index, part] of after.entries()) {
    if (part !== before[index]) return part > before[index]
  }
  return false
}

export function installerName(tag, platform, arch) {
  if (!isStableTag(tag)) return
  if (platform === 'win32' && arch === 'x64') return `New-World-Setup-${tag.slice(1)}-x64.exe`
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return `New-World-${tag.slice(1)}-macos-${arch}.dmg`
}

/** The small Windows installer that downloads the app package while it installs. */
export const onlineInstallerName = (tag) => isStableTag(tag) ? `New-World-Online-Setup-${tag.slice(1)}-x64.exe` : undefined
/** The app package the online installer downloads from the mirror. */
export const windowsPackageName = (tag) => isStableTag(tag) ? `New-World-${tag.slice(1)}-x64.nsis.7z` : undefined

function readInstaller(tag, assets, platform, arch) {
  const name = installerName(tag, platform, arch)
  if (!name || !Array.isArray(assets)) return
  const url = releasePages + 'download/' + tag + '/' + name
  for (const asset of assets) {
    if (!asset || asset.name !== name || asset.state !== 'uploaded' || asset.browser_download_url !== url) continue
    const { size, digest } = asset
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxInstallerBytes) continue
    if (typeof digest !== 'string' || digest.length !== 71 || !/^sha256:[0-9a-f]{64}$/i.test(digest)) continue
    return { tag, name, url, size, sha256: digest.slice(7).toLowerCase() }
  }
}

export const readWindowsInstaller = (tag, assets) => readInstaller(tag, assets, 'win32', 'x64')

export const platformKey = (platform, arch) => platform === 'win32' && arch === 'x64' ? 'windows-x64'
  : platform === 'darwin' && ['arm64', 'x64'].includes(arch) ? `macos-${arch}` : undefined

/** Reads the mirror's latest.json. Anything malformed is treated as no answer, so callers fall back to GitHub. */
export function readMirrorRelease(payload) {
  if (!payload || typeof payload !== 'object' || payload.schema !== 1) return
  const { tag, publishedAt, notes, assets } = payload
  if (!isStableTag(tag) || typeof publishedAt !== 'string' || !assets || typeof assets !== 'object') return
  const installers = {}
  for (const [key, platform, arch] of [['windows-x64', 'win32', 'x64'], ['macos-arm64', 'darwin', 'arm64'], ['macos-x64', 'darwin', 'x64']]) {
    const entry = assets[key]
    if (entry === undefined) continue
    const name = installerName(tag, platform, arch)
    if (!entry || entry.name !== name || entry.url !== mirrorBase + tag + '/' + name) return
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > maxInstallerBytes) return
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) return
    installers[key] = { tag, name, size: entry.size, sha256: entry.sha256, url: releasePages + 'download/' + tag + '/' + name, mirror: entry.url }
  }
  return { tag, publishedAt, notes: typeof notes === 'string' ? notes : '', installers }
}

export const mirrorInstallerUrl = (tag, name) => mirrorBase + tag + '/' + name
export const readMacInstaller = (tag, assets, arch) => readInstaller(tag, assets, 'darwin', arch)

export function isInstallerUrl(address, platform, arch) {
  let url
  try { url = new URL(address) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false
  const tagEndpoint = releaseEndpoint + '/tags/'
  if (url.href.startsWith(tagEndpoint)) return isStableTag(url.href.slice(tagEndpoint.length))
  const downloadBase = releasePages + 'download/'
  if (url.href.startsWith(downloadBase)) {
    const tag = url.href.slice(downloadBase.length).split('/')[0]
    const name = installerName(tag, platform, arch)
    return Boolean(name) && url.href === downloadBase + tag + '/' + name
  }
  if (url.href === mirrorLatest) return true
  if (url.href.startsWith(mirrorBase)) {
    const [tag, name, extra] = url.pathname.slice(1).split('/')
    return extra === undefined && !url.search && Boolean(name) && installerName(tag, platform, arch) === name
  }
  return cdnHosts.has(url.hostname) && /^\/github-production-release-asset(?:-[a-z0-9]+)?\//.test(url.pathname)
}

export const isWindowsUpdateUrl = (address) => isInstallerUrl(address, 'win32', 'x64')

/**
 * Installer details for one tag: the mirror's latest.json first, the GitHub API only when the mirror
 * has nothing for this tag. Every installer comes with both download addresses.
 */
export async function findInstaller(request, tag, platform, arch) {
  const key = platformKey(platform, arch)
  if (!key || !isStableTag(tag)) return
  try {
    const response = await request(mirrorLatest, { redirect: 'error', signal: AbortSignal.timeout(8000) })
    const mirror = response.ok ? readMirrorRelease(await response.json()) : undefined
    if (mirror?.tag === tag && mirror.installers[key]) return mirror.installers[key]
  } catch { /* The GitHub API below still knows the release. */ }
  const response = await request(releaseEndpoint + '/tags/' + tag, {
    headers: { Accept: 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(8000),
  })
  const release = response.ok && await response.json()
  const installer = release?.tag_name === tag && release.draft === false && release.prerelease === false
    && readInstaller(tag, release.assets, platform, arch)
  return installer ? { ...installer, mirror: mirrorInstallerUrl(tag, installer.name) } : undefined
}
