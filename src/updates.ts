import { t } from './i18n'
import { version } from '../package.json'
import { readMacInstaller, readWindowsInstaller, releaseEndpoint, releasePages, desktopReleaseList } from '../desktop/release.mjs'

const timeoutMs = 8000
const notesLimit = 12000

export const runningVersion = `v${version}`

interface Version {
  numbers: bigint[]
  prerelease: boolean
}

const semver = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseVersion(value: string): Version | undefined {
  if (value.length > 256) return
  const match = semver.exec(value)
  if (!match || match[0] !== value) return
  const prerelease = match[4]
  if (prerelease?.split('.').some((identifier) => /^0[0-9]+$/.test(identifier))) return
  return { numbers: match.slice(1, 4).map((part) => BigInt(part)), prerelease: Boolean(prerelease) }
}

// The remote candidate is always a stable release. Build metadata has no precedence.
function compareToStable(current: Version, stable: Version) {
  for (const [index, number] of current.numbers.entries()) {
    if (number < stable.numbers[index]) return -1
    if (number > stable.numbers[index]) return 1
  }
  return current.prerelease ? -1 : 0
}

export type UpdateResult =
  | { kind: 'available'; tag: string; notes: string; url: string; windows?: true; macos?: true }
  | { kind: 'current' }
  | { kind: 'ahead'; tag: string }
  | { kind: 'unpublished' }
  | { kind: 'failed'; message: string }

function failed(message: string): UpdateResult {
  return { kind: 'failed', message }
}

const invalidRelease = t('updates.githubReturnedIncompleteOrInvalidReleaseInformationTry')

function readRelease(payload: unknown) {
  if (!payload || typeof payload !== 'object') return
  const { tag_name: tag, draft, prerelease, body, assets } = payload as Record<string, unknown>
  if (typeof tag !== 'string' || typeof draft !== 'boolean' || typeof prerelease !== 'boolean') return
  const version = parseVersion(tag)
  if (!version) return
  return { tag, version, stable: !draft && !prerelease && !version.prerelease, body, assets }
}

type Release = NonNullable<ReturnType<typeof readRelease>>

function describeRelease(release: Release, current: Version, platform?: string): UpdateResult {
  const { tag, version, body } = release
  const comparison = compareToStable(current, version)
  if (comparison === 0) return { kind: 'current' }
  if (comparison > 0) return { kind: 'ahead', tag }

  const notes = typeof body === 'string' ? body.trim() : ''
  return {
    kind: 'available', tag, url: `${releasePages}tag/${encodeURIComponent(tag)}`, windows: platform === 'win32' ? true : undefined, macos: platform === 'darwin' ? true : undefined,
    notes: notes.length > notesLimit ? t('updates.seeTheGithubReleasePageForTheFull', [notes.slice(0, notesLimit)]) : notes,
  }
}

function webReleaseResult(payload: unknown, current: Version): UpdateResult {
  const release = readRelease(payload)
  if (!release) return failed(invalidRelease)
  return release.stable ? describeRelease(release, current) : { kind: 'unpublished' }
}

function desktopReleaseResult(payload: unknown, current: Version): UpdateResult {
  if (!Array.isArray(payload)) return failed(invalidRelease)
  const releases = payload.map(readRelease).filter((release) => release !== undefined)
  if (payload.length && !releases.length) return failed(invalidRelease)
  const platform = window.newWorldDesktop?.platform ?? 'win32'
  const arch = window.newWorldDesktop?.arch ?? 'x64'
  let best: Release | undefined
  for (const release of releases) {
    const installer = platform === 'darwin' ? readMacInstaller(release.tag, release.assets, arch)
      : platform === 'win32' && arch === 'x64' ? readWindowsInstaller(release.tag, release.assets) : undefined
    if (!release.stable || !installer) continue
    if (!best || compareToStable(best.version, release.version) < 0) best = release
  }
  return best ? describeRelease(best, current, platform) : { kind: 'unpublished' }
}

export async function checkForUpdate(): Promise<UpdateResult> {
  const current = parseVersion(version)
  if (!current) return failed(t('updates.theRunningVersionCouldNotBeIdentified'))
  if (!navigator.onLine) return failed(t('updates.youAreOfflineConnectToTheInternetAnd'))

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  const desktop = !!window.newWorldDesktop
  try {
    const response = await fetch(desktop ? desktopReleaseList : `${releaseEndpoint}/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
      cache: 'no-store', signal: controller.signal,
    })
    if (response.status === 404) return { kind: 'unpublished' }
    if (response.status === 429 || (response.status === 403 && (
      response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')
    ))) {
      return failed(t('updates.theGithubUpdateApiRateLimitHasBeen'))
    }
    if (!response.ok) return failed(t('updates.githubCouldNotReturnReleaseInformationHttpTry', [response.status]))

    const payload: unknown = await response.json().catch(() => undefined)
    if (controller.signal.aborted) return failed(t('updates.theUpdateCheckTimedOutTryAgainLater'))
    return desktop ? desktopReleaseResult(payload, current) : webReleaseResult(payload, current)
  } catch {
    return failed(controller.signal.aborted ? t('updates.theUpdateCheckTimedOutTryAgainLater') : t('updates.githubCouldNotBeReachedCheckYourConnection'))
  } finally {
    window.clearTimeout(timeout)
  }
}
