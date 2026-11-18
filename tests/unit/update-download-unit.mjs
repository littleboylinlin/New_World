import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { installerName, mirrorInstallerUrl, mirrorLatest, platformKey, releasePages } from '../../desktop/release.mjs'

const require = createRequire(import.meta.url)
const { downloadVerified } = require('../../desktop/update-download.cjs')
const { createWindowsUpdater } = require('../../desktop/windows-update.cjs')
const { createMacUpdater } = require('../../desktop/macos-update.cjs')
const blockSize = 4 * 1024 * 1024
const probe = 'bytes=0-0'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

const ranges = (size) => Array.from({ length: Math.ceil(size / blockSize) }, (_, index) => {
  const start = index * blockSize
  return `bytes=${start}-${Math.min(start + blockSize, size) - 1}`
})

async function until(condition) {
  const deadline = performance.now() + 4_000
  while (performance.now() < deadline) {
    if (await condition()) return
    await wait(15)
  }
  assert.fail('Timed out waiting for the download')
}

async function source(t, bytes, { supportsRange = true, respond = ({ send }) => send() } = {}) {
  const requests = []
  let active = 0, peak = 0
  const server = createServer((request, response) => {
    const range = request.headers.range
    requests.push(range ?? 'whole')
    const match = supportsRange && range && /^bytes=(\d+)-(\d+)$/.exec(range)
    const start = match ? Number(match[1]) : 0
    const end = match ? Number(match[2]) : bytes.length - 1
    const headers = { 'content-length': String(end - start + 1) }
    const status = match ? 206 : 200
    if (match) headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`
    if (match && range !== probe) {
      peak = Math.max(peak, ++active)
      response.once('close', () => { --active })
    }
    const data = bytes.subarray(start, end + 1)
    const send = (body = data) => response.writeHead(status, headers).end(body)
    Promise.resolve(respond({ range, start, status, headers, data, send, response })).catch((error) => response.destroy(error))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return { url: `http://127.0.0.1:${server.address().port}`, requests, get peak() { return peak } }
}

async function fixture(t, size = blockSize * 2 + 123) {
  const root = await mkdtemp(join(tmpdir(), 'nw-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'installer')
  const bytes = Buffer.alloc(size)
  for (let start = 0; start < size; start += blockSize) {
    bytes.fill(start / blockSize + 1, start, Math.min(size, start + blockSize))
  }
  const sha256 = hash(bytes)
  const updates = []
  const progress = (...event) => updates.push(event)
  const download = (sources, options = {}) => downloadVerified({
    request: fetch, sources, size, sha256, path, progress, ...options,
  })
  return { root, path, size, bytes, sha256, updates, progress, download }
}

test('按 4 MiB 分块并保持六条并发，优先使用镜像，汇总进度和速度', { timeout: 10_000 }, async (t) => {
  const { path, size, bytes, updates, download } = await fixture(t, blockSize * 6 + 123)
  const gate = Promise.withResolvers()
  const mirror = await source(t, bytes, { respond: async ({ range, response, status, headers, data, send }) => {
    if (range === probe) { send(); return }
    const first = Math.min(64 * 1024, data.length)
    response.writeHead(status, headers).write(data.subarray(0, first))
    await gate.promise
    response.end(data.subarray(first))
  } })
  const github = await source(t, bytes)
  const downloading = download([mirror.url, github.url])
  const observed = downloading.catch(() => {})
  try {
    await until(() => mirror.requests.length >= 7)
    await until(() => updates.some(([received, total, speed]) => received > 0 && received < total && speed > 0))
    assert.deepEqual(mirror.requests, [probe, ...ranges(size).slice(0, 6)])
    assert.equal(mirror.peak, 6)
    await until(() => updates.at(-1)[0] > 0 && updates.at(-1)[2] === 0)
  } finally { gate.resolve(); await observed }
  await downloading
  assert.deepEqual(mirror.requests, [probe, ...ranges(size)])
  assert.deepEqual(github.requests, [])
  assert.deepEqual(updates[0], [0, size, 0])
  assert.equal(updates.at(-1)[0], size)
  assert.ok((await readFile(path)).equals(bytes))
})

for (const interruption of ['停顿', '断开']) {
  test(`连接中途${interruption}时只从另一个源重下受影响的块`, { timeout: 10_000 }, async (t) => {
    const { path, size, bytes, updates, download } = await fixture(t)
    const failedRange = ranges(size)[1]
    const mirror = await source(t, bytes, { respond: ({ range, response, status, headers, data, send }) => {
      if (range !== failedRange) { send(); return }
      response.writeHead(status, headers).write(data.subarray(0, 64 * 1024), () => {
        if (interruption === '断开') response.destroy()
      })
    } })
    const github = await source(t, bytes)
    await download([mirror.url, github.url], { timeoutMs: 600 })
    assert.deepEqual(mirror.requests, [probe, ...ranges(size)])
    assert.deepEqual(github.requests, [probe, failedRange])
    assert.ok(updates.every(([received, total]) => received >= 0 && received <= total))
    assert.equal(updates.at(-1)[0], size)
    assert.ok((await readFile(path)).equals(bytes))
  })
}

test('慢速连接持续收到数据时继续下载当前块', { timeout: 10_000 }, async (t) => {
  const { path, size, bytes, download } = await fixture(t, 256 * 1024)
  const mirror = await source(t, bytes, { respond: async ({ range, response, status, headers, data, send }) => {
    if (range === probe) { send(); return }
    response.writeHead(status, headers)
    for (let start = 0; start < size; start += 32 * 1024) {
      response.write(data.subarray(start, start + 32 * 1024))
      await wait(100)
    }
    response.end()
  } })
  const github = await source(t, bytes)
  await download([mirror.url, github.url], { timeoutMs: 500 })
  assert.deepEqual(mirror.requests, [probe, ...ranges(size)])
  assert.deepEqual(github.requests, [])
  assert.ok((await readFile(path)).equals(bytes))
})

test('没有 Range 时保留整包下载，有可用 Range 时只向支持的源要分块', async (t) => {
  const { path, root, size, bytes, download } = await fixture(t)
  const whole = await source(t, bytes, { supportsRange: false })
  const ranged = await source(t, bytes)
  await download([whole.url, ranged.url])
  assert.deepEqual(whole.requests, [probe])
  assert.deepEqual(ranged.requests, [probe, ...ranges(size)])
  assert.ok((await readFile(path)).equals(bytes))
  await rm(path)
  await download([whole.url])
  assert.deepEqual(whole.requests, [probe, probe, 'whole'])
  assert.ok((await readFile(path)).equals(bytes))
  assert.deepEqual(await readdir(root), ['installer'])
})

test('响应忽略已探测的 Range 时，改走可用的整包源', async (t) => {
  const { path, bytes, download } = await fixture(t)
  const mirror = await source(t, bytes, { respond: ({ range, response, send }) => {
    if (range === probe) send()
    else response.writeHead(200, { 'content-length': bytes.length }).end(bytes)
  } })
  const github = await source(t, bytes, { supportsRange: false })
  await download([mirror.url, github.url])
  assert.equal(mirror.requests[0], probe)
  assert.ok(mirror.requests.length > 1)
  assert.ok([mirror, github].some(({ requests }) => requests.includes('whole')))
  assert.ok((await readFile(path)).equals(bytes))
})

test('源声明的文件大小不符时，改用确认大小的分块源', async (t) => {
  const { path, size, bytes, download } = await fixture(t)
  const mismatch = await source(t, Buffer.concat([bytes, Buffer.of(0)]))
  const github = await source(t, bytes)
  await download([mismatch.url, github.url])
  assert.deepEqual(mismatch.requests, [probe])
  assert.deepEqual(github.requests, [probe, ...ranges(size)])
  assert.ok((await readFile(path)).equals(bytes))
})

for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64']]) {
  test(`${platform} 用尽单块重试后保留进度，重启后只下载缺少的块`, { timeout: 10_000 }, async (t) => {
    const { root, size, bytes, sha256, updates, progress } = await fixture(t, blockSize + 123)
    const tag = 'v0.23.1'
    const name = installerName(tag, platform, arch)
    const cache = join(root, 'cache')
    const path = join(cache, 'download-' + tag, name)
    const state = path + '.range.part.json'
    const unavailable = Promise.withResolvers()
    const retries = []
    let broken = true
    const respond = (label) => async ({ start, response, send }) => {
      if (broken && start === blockSize) {
        retries.push(label)
        await unavailable.promise
        response.writeHead(503).end()
      } else send()
    }
    const mirror = await source(t, bytes, { respond: respond('镜像') })
    const github = await source(t, bytes, { respond: respond('GitHub') })
    const metadata = {
      schema: 1, tag, publishedAt: '2026-11-18T00:00:00Z',
      assets: { [platformKey(platform, arch)]: {
        name, size, sha256, url: mirrorInstallerUrl(tag, name), github: `${releasePages}download/${tag}/${name}`,
      } },
    }
    const network = {
      webRequest: { onBeforeRequest() {} },
      fetch(url, init) {
        if (url === mirrorLatest) return Response.json(metadata)
        return fetch(url.startsWith(releasePages) ? github.url : mirror.url, init)
      },
    }
    const options = { network, cache, version: '0.23.0' }
    await writeFile(join(root, 'Uninstall New World.exe'), '')
    const create = () => platform === 'win32' ? createWindowsUpdater({ ...options, installDir: root })
      : createMacUpdater({ ...options, arch })
    const first = await create()
    const rejected = assert.rejects(first.download(tag, progress), {
      message: 'windowsUpdate.theInstallerCouldNotBeDownloadedCheckYour',
    })
    try {
      await until(() => readFile(state, 'utf8').then((record) => JSON.parse(record).completed.length === 1, () => false))
    } finally { unavailable.resolve() }
    await rejected
    assert.deepEqual(retries, ['镜像', 'GitHub', '镜像', 'GitHub'])
    await assert.rejects(readFile(path), { code: 'ENOENT' })
    // Simulate the temporary record left by a process that exited before renaming it.
    await writeFile(state + '.tmp', 'incomplete')
    broken = false
    mirror.requests.length = github.requests.length = updates.length = 0
    const restarted = await create()
    await restarted.download(tag, progress)
    assert.deepEqual(updates[0], [blockSize, size, 0])
    assert.deepEqual(mirror.requests, [probe, ranges(size)[1]])
    assert.deepEqual(github.requests, [])
    assert.deepEqual(await readdir(join(cache, 'download-' + tag)), [name])
    assert.ok((await readFile(path)).equals(bytes))
  })
}

test('缓存文件大小、发行校验值或分块校验不一致时重新下载', async (t) => {
  const { path, size, bytes, sha256, updates, download } = await fixture(t, blockSize + 123)
  const local = await source(t, bytes)
  const partial = path + '.range.part'
  for (const changed of ['长度', '发行校验值', '保存的字节']) {
    const previous = Buffer.from(bytes)
    if (changed === '保存的字节') previous[0] ^= 1
    await writeFile(partial, previous.subarray(0, changed === '长度' ? size - 1 : size))
    await writeFile(partial + '.json', JSON.stringify({
      version: 1, size, blockBytes: blockSize, sha256: changed === '发行校验值' ? '0'.repeat(64) : sha256,
      completed: [[0, hash(bytes.subarray(0, blockSize))]],
    }))
    local.requests.length = updates.length = 0
    await download([local.url])
    assert.deepEqual(updates[0], [0, size, 0], changed)
    assert.deepEqual(local.requests, [probe, ...ranges(size)], changed)
    assert.ok((await readFile(path)).equals(bytes))
    await rm(path)
  }
})

test('下载的某一块被篡改时整包校验失败，清理临时文件并重新下载', async (t) => {
  const { root, path, size, bytes, download } = await fixture(t)
  const changed = ranges(size)[1]
  let corrupt = true
  const mirror = await source(t, bytes, { respond: ({ range, data, send }) => {
    if (!corrupt || range !== changed) { send(); return }
    const bad = Buffer.from(data)
    bad[0] ^= 1
    send(bad)
  } })
  await assert.rejects(download([mirror.url]), { kind: 'invalid' })
  assert.deepEqual(await readdir(root), [])
  corrupt = false
  mirror.requests.length = 0
  await download([mirror.url])
  assert.deepEqual(mirror.requests, [probe, ...ranges(size)])
  assert.ok((await readFile(path)).equals(bytes))
})
