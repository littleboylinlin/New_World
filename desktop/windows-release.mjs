const repository = 'littleboylinlin/New_World'
export const releaseEndpoint = 'https://api.github.com/repos/' + repository + '/releases'
export const releasePages = 'https://github.com/' + repository + '/releases/'
export const windowsReleaseList = releaseEndpoint + '?per_page=100'

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const cdnHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com'])

export function isWindowsTag(tag) {
  return typeof tag === 'string' && tag.length <= 40 && tag.trim() === tag && stableTag.test(tag)
}

export function isNewerWindowsTag(tag, currentVersion) {
  const current = 'v' + currentVersion
  if (!isWindowsTag(tag) || !isWindowsTag(current)) return false
  const before = current.slice(1).split('.').map(BigInt)
  const after = tag.slice(1).split('.').map(BigInt)
  for (const [index, part] of after.entries()) {
    if (part !== before[index]) return part > before[index]
  }
  return false
}

function installerName(tag) {
  return 'New-World-Setup-' + tag.slice(1) + '-x64.exe'
}

function installerUrl(tag) {
  return releasePages + 'download/' + tag + '/' + installerName(tag)
}

export function readWindowsInstaller(tag, assets) {
  if (!isWindowsTag(tag) || !Array.isArray(assets)) return
  const name = installerName(tag)
  const url = installerUrl(tag)
  for (const asset of assets) {
    if (!asset || asset.name !== name || asset.state !== 'uploaded' || asset.browser_download_url !== url) continue
    const { size, digest } = asset
    if (!Number.isSafeInteger(size) || size <= 0) continue
    if (typeof digest !== 'string' || digest.length !== 71 || !/^sha256:[0-9a-f]{64}$/i.test(digest)) continue
    return { tag, name, url, size, sha256: digest.slice(7).toLowerCase() }
  }
}

export function isUpdateUrl(address) {
  let url
  try { url = new URL(address) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false
  const tagEndpoint = releaseEndpoint + '/tags/'
  if (url.href.startsWith(tagEndpoint)) return isWindowsTag(url.href.slice(tagEndpoint.length))
  const downloadBase = releasePages + 'download/'
  if (url.href.startsWith(downloadBase)) {
    const tag = url.href.slice(downloadBase.length).split('/')[0]
    return isWindowsTag(tag) && url.href === installerUrl(tag)
  }
  return cdnHosts.has(url.hostname) && /^\/github-production-release-asset(?:-[a-z0-9]+)?\//.test(url.pathname)
}
