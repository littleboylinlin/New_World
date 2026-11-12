import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installerName, isStableTag } from './release.mjs'

export function validatePlan(plan, version) {
  if (plan.version !== version || !isStableTag('v' + version) || !Array.isArray(plan.platforms) || !plan.platforms.length
    || new Set(plan.platforms).size !== plan.platforms.length || plan.platforms.some((name) => !['windows', 'macos'].includes(name))) {
    throw new Error('Release platforms and version must be explicit and match package.json')
  }
  return plan
}

export function releaseAssets(plan) {
  return [
    ...(plan.platforms.includes('windows') ? [installerName('v' + plan.version, 'win32', 'x64')] : []),
    ...(plan.platforms.includes('macos') ? ['arm64', 'x64'].map((arch) => installerName('v' + plan.version, 'darwin', arch)) : []),
    'New-World-lang-zh-CN.json', 'New-World-lang-en.json',
  ]
}

export async function readPlan() {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'))
  return validatePlan(JSON.parse(await readFile('release.json', 'utf8')), version)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const plan = await readPlan()
  if (process.argv[2] === '--github-output') {
    await appendFile(process.env.GITHUB_OUTPUT, `windows=${plan.platforms.includes('windows')}\nmacos=${plan.platforms.includes('macos')}\nversion=${plan.version}\n`)
  } else if (process.argv[2] === '--title') {
    console.log('New World v' + plan.version + ' · ' + plan.platforms.map((name) => name === 'windows' ? 'Windows' : 'macOS').join(' & '))
  } else if (process.argv[2] === '--verify-artifacts') {
    const directory = process.argv[3]
    const expected = releaseAssets(plan).sort()
    const actual = (await readdir(directory)).filter((name) => name !== 'SHA256SUMS.txt').sort()
    if (expected.join('\n') !== actual.join('\n')) throw new Error('Release artifacts do not match the selected platforms')
    const languageManifest = JSON.parse(await readFile('public/locales/manifest.json', 'utf8'))
    for (const pack of Object.values(languageManifest.packs)) {
      if (createHash('sha256').update(await readFile(join(directory, pack.file))).digest('hex') !== pack.sha256) {
        throw new Error('Published language packs do not match the application manifest')
      }
    }
    const lines = []
    for (const file of expected) lines.push(createHash('sha256').update(await readFile(join(directory, file))).digest('hex') + '  ' + file)
    await writeFile(join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n')
  } else console.log(releaseAssets(plan).join('\n'))
}
