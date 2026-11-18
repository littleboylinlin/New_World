// Writes latest.json for the R2 mirror from a directory of verified release files.
// Usage: node desktop/mirror-manifest.mjs <tag> <directory> <published-at> <notes-file>
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { installerName, isStableTag, mirrorBase, readMirrorRelease, releasePages } from './release.mjs'

const platforms = [['windows-x64', 'win32', 'x64'], ['macos-arm64', 'darwin', 'arm64'], ['macos-x64', 'darwin', 'x64']]

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function mirrorManifest(tag, directory, publishedAt, notes) {
  if (!isStableTag(tag)) throw new Error(`Not a stable tag: ${tag}`)
  if (Number.isNaN(Date.parse(publishedAt))) throw new Error(`Invalid publish date: ${publishedAt}`)
  const assets = {}
  for (const [key, platform, arch] of platforms) {
    const name = installerName(tag, platform, arch)
    const path = join(directory, name)
    const file = await stat(path).catch(() => undefined)
    if (!file?.isFile()) continue
    assets[key] = {
      name, size: file.size, sha256: await sha256(path),
      url: `${mirrorBase}${tag}/${name}`, github: `${releasePages}download/${tag}/${name}`,
    }
  }
  if (!Object.keys(assets).length) throw new Error(`No installers for ${tag} in ${directory}`)
  const manifest = {
    schema: 1, version: tag.slice(1), tag, publishedAt: new Date(publishedAt).toISOString(),
    releaseUrl: `${releasePages}tag/${tag}`, notes, assets,
    checksums: { name: 'SHA256SUMS.txt', url: `${mirrorBase}${tag}/SHA256SUMS.txt` },
  }
  if (!readMirrorRelease(manifest)) throw new Error('The manifest does not pass the app\'s own check')
  return manifest
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tag, directory, publishedAt, notesFile] = process.argv.slice(2)
  const notes = notesFile ? (await readFile(notesFile, 'utf8')).trim() : ''
  process.stdout.write(`${JSON.stringify(await mirrorManifest(tag, directory, publishedAt, notes), null, 2)}\n`)
}
