import { version } from '../package.json'

const repository = 'littleboylinlin/New_World'
const releaseEndpoint = `https://api.github.com/repos/${repository}/releases/latest`
const releasePages = `https://github.com/${repository}/releases/tag/`
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
  | { kind: 'available'; tag: string; notes: string; url: string }
  | { kind: 'current' }
  | { kind: 'ahead'; tag: string }
  | { kind: 'unpublished' }
  | { kind: 'failed'; message: string }

function failed(message: string): UpdateResult {
  return { kind: 'failed', message }
}

function releaseResult(payload: unknown, current: Version): UpdateResult {
  const invalid = 'GitHub 返回的版本信息不完整或格式异常。请稍后重试。'
  if (!payload || typeof payload !== 'object') return failed(invalid)
  const { tag_name: tag, draft, prerelease, body } = payload as Record<string, unknown>
  if (typeof tag !== 'string' || typeof draft !== 'boolean' || typeof prerelease !== 'boolean') return failed(invalid)
  if (draft || prerelease) return { kind: 'unpublished' }
  const stable = parseVersion(tag)
  if (!stable) return failed(invalid)
  if (stable.prerelease) return { kind: 'unpublished' }

  const comparison = compareToStable(current, stable)
  if (comparison === 0) return { kind: 'current' }
  if (comparison > 0) return { kind: 'ahead', tag }

  const notes = typeof body === 'string' ? body.trim() : ''
  return {
    kind: 'available', tag, url: `${releasePages}${encodeURIComponent(tag)}`,
    notes: notes.length > notesLimit ? `${notes.slice(0, notesLimit)}\n\n完整说明见 GitHub 发布页。` : notes,
  }
}

export async function checkForUpdate(): Promise<UpdateResult> {
  const current = parseVersion(version)
  if (!current) return failed('无法识别当前运行版本。')
  if (!navigator.onLine) return failed('当前处于离线状态。联网后可以重试。')

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(releaseEndpoint, {
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
    return releaseResult(payload, current)
  } catch {
    return failed(controller.signal.aborted ? '检查更新超时。请稍后重试。' : '无法连接 GitHub 检查更新。请检查网络后重试。')
  } finally {
    window.clearTimeout(timeout)
  }
}
