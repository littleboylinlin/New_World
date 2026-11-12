const repository = 'littleboylinlin/New_World'
export const releaseEndpoint = 'https://api.github.com/repos/' + repository + '/releases'
export const releasePages = 'https://github.com/' + repository + '/releases/'
export const desktopReleaseList = releaseEndpoint + '?per_page=100'

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const cdnHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com'])

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

function readInstaller(tag, assets, platform, arch) {
  const name = installerName(tag, platform, arch)
  if (!name || !Array.isArray(assets)) return
  const url = releasePages + 'download/' + tag + '/' + name
  for (const asset of assets) {
    if (!asset || asset.name !== name || asset.state !== 'uploaded' || asset.browser_download_url !== url) continue
    const { size, digest } = asset
    if (!Number.isSafeInteger(size) || size <= 0) continue
    if (typeof digest !== 'string' || digest.length !== 71 || !/^sha256:[0-9a-f]{64}$/i.test(digest)) continue
    return { tag, name, url, size, sha256: digest.slice(7).toLowerCase() }
  }
}

export const readWindowsInstaller = (tag, assets) => readInstaller(tag, assets, 'win32', 'x64')
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
  return cdnHosts.has(url.hostname) && /^\/github-production-release-asset(?:-[a-z0-9]+)?\//.test(url.pathname)
}

export const isWindowsUpdateUrl = (address) => isInstallerUrl(address, 'win32', 'x64')
