import { readFile } from 'node:fs/promises'
import { REPO } from '../config.mjs'

const INSTALLERS = {
  'windows-x64': /^New-World-Setup-.+-x64\.exe$/,
  'windows-x64-online': /^New-World-Online-Setup-.+-x64\.exe$/,
  'macos-arm64': /^New-World-.+-macos-arm64\.dmg$/,
  'macos-x64': /^New-World-.+-macos-x64\.dmg$/,
}
// The language packs are published with every release under fixed names (desktop/release-plan.mjs).
const LANGUAGE_PACKS = {
  'lang-zh-CN': /^New-World-lang-zh-CN\.json$/,
  'lang-en': /^New-World-lang-en\.json$/,
}

async function github(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'new-world-site' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers })
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status} ${response.statusText}`)
  return response.json()
}

async function checksums(release) {
  const sums = release.assets.find((asset) => asset.name === 'SHA256SUMS.txt')
  if (!sums) return new Map()
  const response = await fetch(sums.browser_download_url)
  if (!response.ok) throw new Error(`SHA256SUMS.txt: ${response.status}`)
  const text = await response.text()
  return new Map(text.split('\n').map((line) => line.trim().split(/\s+\*?/)).filter(([hash, name]) => name && /^[0-9a-f]{64}$/.test(hash)).map(([hash, name]) => [name, hash]))
}

export async function latestRelease() {
  if (process.env.LATEST_JSON) return JSON.parse(await readFile(process.env.LATEST_JSON, 'utf-8'))

  // /releases/latest only returns published releases that are neither drafts nor prereleases.
  const release = await github('/releases/latest')
  let sums
  const assets = {}
  // A release may cover only some platforms (release.json); the site offers what it has.
  for (const [platform, pattern] of Object.entries({ ...INSTALLERS, ...LANGUAGE_PACKS })) {
    const asset = release.assets.find((item) => pattern.test(item.name))
    if (!asset) continue
    let sha256 = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null
    if (!sha256) sha256 = (sums ??= await checksums(release)).get(asset.name) ?? null
    if (!sha256) throw new Error(`${asset.name} has no SHA-256 checksum`)
    assets[platform] = { name: asset.name, url: asset.browser_download_url, sha256, size: asset.size }
  }
  if (!Object.keys(INSTALLERS).some((platform) => assets[platform])) throw new Error(`${release.tag_name} has no installer`)
  return {
    version: release.tag_name.replace(/^v/, ''),
    tag: release.tag_name,
    publishedAt: release.published_at,
    releaseUrl: release.html_url,
    assets,
  }
}
