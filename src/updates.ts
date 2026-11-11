import { version } from '../package.json'
import { readWindowsInstaller, releaseEndpoint, releasePages, windowsReleaseList } from '../desktop/windows-release.mjs'

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
  | { kind: 'available'; tag: string; notes: string; url: string; windows?: true }
  | { kind: 'current' }
  | { kind: 'ahead'; tag: string }
  | { kind: 'unpublished' }
  | { kind: 'failed'; message: string }

function failed(message: string): UpdateResult {
  return { kind: 'failed', message }
}

const invalidRelease = 'GitHub 返回的版本信息不完整或格式异常。请稍后重试。'

function readRelease(payload: unknown) {
  if (!payload || typeof payload !== 'object') return
  const { tag_name: tag, draft, prerelease, body, assets } = payload as Record<string, unknown>
  if (typeof tag !== 'string' || typeof draft !== 'boolean' || typeof prerelease !== 'boolean') return
  const version = parseVersion(tag)
  if (!version) return
  return { tag, version, stable: !draft && !prerelease && !version.prerelease, body, assets }
}

type Release = NonNullable<ReturnType<typeof readRelease>>

function describeRelease(release: Release, current: Version, windows?: true): UpdateResult {
  const { tag, version, body } = release
  const comparison = compareToStable(current, version)
  if (comparison === 0) return { kind: 'current' }
  if (comparison > 0) return { kind: 'ahead', tag }

  const notes = typeof body === 'string' ? body.trim() : ''
  return {
    kind: 'available', tag, url: `${releasePages}tag/${encodeURIComponent(tag)}`, windows,
    notes: notes.length > notesLimit ? `${notes.slice(0, notesLimit)}\n\n完整说明见 GitHub 发布页。` : notes,
  }
}

function webReleaseResult(payload: unknown, current: Version): UpdateResult {
  const release = readRelease(payload)
  if (!release) return failed(invalidRelease)
  return release.stable ? describeRelease(release, current) : { kind: 'unpublished' }
}

function windowsReleaseResult(payload: unknown, current: Version): UpdateResult {
  if (!Array.isArray(payload)) return failed(invalidRelease)
  const releases = payload.map(readRelease).filter((release) => release !== undefined)
  if (payload.length && !releases.length) return failed(invalidRelease)
  let best: Release | undefined
  for (const release of releases) {
    if (!release.stable || !readWindowsInstaller(release.tag, release.assets)) continue
    if (!best || compareToStable(best.version, release.version) < 0) best = release
  }
  return best ? describeRelease(best, current, true) : { kind: 'unpublished' }
}

export async function checkForUpdate(): Promise<UpdateResult> {
  const current = parseVersion(version)
  if (!current) return failed('无法识别当前运行版本。')
  if (!navigator.onLine) return failed('当前处于离线状态。联网后可以重试。')

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  const desktop = !!window.newWorldDesktop
  try {
    const response = await fetch(desktop ? windowsReleaseList : `${releaseEndpoint}/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
      cache: 'no-store', signal: controller.signal,
    })
    if (response.status === 404) return { kind: 'unpublished' }
    if (response.status === 429 || (response.status === 403 && (
      response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')
    ))) {
      return failed('GitHub 更新接口达到请求限额。请稍后重试。')
    }
    if (!response.ok) return failed(`GitHub 暂时无法返回版本信息（HTTP ${response.status}）。请稍后重试。`)

    const payload: unknown = await response.json().catch(() => undefined)
    if (controller.signal.aborted) return failed('检查更新超时。请稍后重试。')
    return desktop ? windowsReleaseResult(payload, current) : webReleaseResult(payload, current)
  } catch {
    return failed(controller.signal.aborted ? '检查更新超时。请稍后重试。' : '无法连接 GitHub 检查更新。请检查网络后重试。')
  } finally {
    window.clearTimeout(timeout)
  }
}
