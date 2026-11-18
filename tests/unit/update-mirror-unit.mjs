import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findInstaller, mirrorBase, mirrorLatest, readMirrorRelease, releaseEndpoint, releasePages } from '../../desktop/release.mjs'
import { mirrorManifest } from '../../desktop/mirror-manifest.mjs'

const require = createRequire(import.meta.url)
const { downloadVerified, leadBytes } = require('../../desktop/update-download.cjs')

const tag = 'v9.9.0'
const name = 'New-World-Setup-9.9.0-x64.exe'
const github = `${releasePages}download/${tag}/${name}`
const mirror = `${mirrorBase}${tag}/${name}`
const payload = Buffer.alloc(leadBytes * 2 + 12345, 7)
const sha256 = createHash('sha256').update(payload).digest('hex')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A source that sends `bytes` in 256 KiB chunks after `wait` ms each; `failAt` cuts the stream at that offset. */
function source({ bytes = payload, wait = 0, failAt, status = 200 } = {}) {
  const seen = { started: 0, aborted: false }
  const respond = (signal, range) => {
    if (range) return new Response('', { status, headers: { 'content-length': String(bytes.length) } })
    seen.started++
    signal?.addEventListener('abort', () => { seen.aborted = true })
    if (status !== 200) return new Response('missing', { status })
    let offset = 0
    return new Response(new ReadableStream({
      async pull(controller) {
        await sleep(wait)
        if (signal?.aborted) return controller.error(new DOMException('aborted', 'AbortError'))
        if (failAt !== undefined && offset >= failAt) return controller.error(new Error('connection reset'))
        if (offset >= bytes.length) return controller.close()
        const end = Math.min(offset + 256 * 1024, bytes.length)
        controller.enqueue(new Uint8Array(bytes.subarray(offset, end)))
        offset = end
      },
    }), { headers: { 'content-length': String(bytes.length) } })
  }
  return { seen, respond }
}

async function run(sources, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nw-mirror-'))
  const path = join(root, name)
  const updates = []
  const request = async (url, init) => {
    const entry = sources[url]
    if (!entry) throw new TypeError('unknown address ' + url)
    return entry.respond(init?.signal, init?.headers?.Range)
  }
  try {
    const used = await downloadVerified({ request, sources: [github, mirror], size: payload.length, sha256, path, progress: (received) => updates.push(received), ...options })
    return { used, bytes: await readFile(path), files: await readdir(root), updates }
  } catch (error) {
    return { error, files: await readdir(root) }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('the source that delivers the first megabyte wins and the other is aborted', async () => {
  const slow = source({ wait: 40 })
  const fast = source({ wait: 1 })
  const result = await run({ [github]: slow, [mirror]: fast })
  assert.equal(result.used, mirror)
  assert.ok(result.bytes.equals(payload))
  assert.deepEqual(result.files, [name])
  assert.equal(slow.seen.aborted, true)
  assert.equal(result.updates.at(-1), payload.length)
})

test('a corrupt winner is downloaded again from the other source', async () => {
  const corrupt = Buffer.from(payload)
  corrupt[corrupt.length - 1] ^= 1
  const result = await run({ [github]: source({ wait: 30 }), [mirror]: source({ bytes: corrupt, wait: 1 }) })
  assert.equal(result.used, github)
  assert.ok(result.bytes.equals(payload))
  assert.deepEqual(result.files, [name])
})

test('a winner that fails midway falls back to the other source', async () => {
  const result = await run({ [github]: source({ wait: 1, failAt: leadBytes + 256 * 1024 }), [mirror]: source({ wait: 30 }) })
  assert.equal(result.used, mirror)
  assert.ok(result.bytes.equals(payload))
})

test('one source missing is not an error while the other works', async () => {
  const result = await run({ [github]: source({ status: 404 }), [mirror]: source({ wait: 1 }) })
  assert.equal(result.used, mirror)
})

test('the download fails only when both sources fail, and leaves nothing behind', async () => {
  const corrupt = Buffer.from(payload)
  corrupt[0] ^= 1
  const result = await run({ [github]: source({ bytes: corrupt, wait: 1 }), [mirror]: source({ bytes: corrupt, wait: 20 }) })
  assert.equal(result.error.kind, 'invalid')
  assert.deepEqual(result.files, [])
  const offline = await run({ [github]: source({ status: 503 }), [mirror]: source({ failAt: 0 }) })
  assert.equal(offline.error.kind, 'failed')
  assert.deepEqual(offline.files, [])
})

const latest = {
  schema: 1, version: '9.9.0', tag, publishedAt: '2026-11-18T00:00:00.000Z', notes: '说明',
  assets: { 'windows-x64': { name, size: payload.length, sha256, url: mirror, github } },
}

test('installer details come from the mirror without asking GitHub', async () => {
  const requests = []
  const request = async (url) => { requests.push(url); return Response.json(latest) }
  const installer = await findInstaller(request, tag, 'win32', 'x64')
  assert.deepEqual(requests, [mirrorLatest])
  assert.deepEqual(installer, { tag, name, size: payload.length, sha256, url: github, mirror })
})

test('a stale, broken or missing mirror falls back to the GitHub API', async () => {
  const release = { tag_name: tag, draft: false, prerelease: false, assets: [{ name, size: 10, digest: 'sha256:' + 'b'.repeat(64), state: 'uploaded', browser_download_url: github }] }
  for (const mirrorReply of [Response.json({ ...latest, tag: 'v9.8.0' }), Response.json({ ...latest, assets: { 'windows-x64': { ...latest.assets['windows-x64'], url: 'https://evil.example/x.exe' } } }), new Response('', { status: 404 }), 'throw']) {
    const requests = []
    const request = async (url) => {
      requests.push(url)
      if (url === mirrorLatest) { if (mirrorReply === 'throw') throw new TypeError('offline'); return mirrorReply }
      return Response.json(release)
    }
    const installer = await findInstaller(request, tag, 'win32', 'x64')
    assert.deepEqual(requests, [mirrorLatest, `${releaseEndpoint}/tags/${tag}`])
    assert.deepEqual(installer, { tag, name, size: 10, sha256: 'b'.repeat(64), url: github, mirror })
  }
})

test('the publish script writes a latest.json the app accepts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-manifest-'))
  try {
    await writeFile(join(root, name), payload)
    await writeFile(join(root, 'New-World-9.9.0-macos-arm64.dmg'), 'disk image')
    const manifest = await mirrorManifest(tag, root, '2026-11-18T08:00:00Z', '修复说明')
    assert.deepEqual(Object.keys(manifest.assets), ['windows-x64', 'macos-arm64'])
    assert.equal(manifest.assets['windows-x64'].sha256, sha256)
    assert.equal(manifest.assets['macos-arm64'].url, `${mirrorBase}${tag}/New-World-9.9.0-macos-arm64.dmg`)
    const read = readMirrorRelease(JSON.parse(JSON.stringify(manifest)))
    assert.equal(read.tag, tag)
    assert.equal(read.notes, '修复说明')
    await assert.rejects(mirrorManifest('v9.9.0-beta.1', root, '2026-11-18T08:00:00Z', ''))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
