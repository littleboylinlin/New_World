const { createHash } = require('node:crypto')
const { createReadStream, createWriteStream } = require('node:fs')
const { rename, rm } = require('node:fs/promises')
const { addAbortSignal, Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { fileInfo, partialDownload } = require('./update-partial.cjs')

const leadBytes = 1024 * 1024
const connections = 6
const blockRetries = 3

class DownloadProblem extends Error {
  constructor(kind) {
    super(kind)
    this.kind = kind
  }
}

function installerRequest(network, allowUrl, connection) {
  function restrict(session) {
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, done) => {
      done({ cancel: request.method !== 'GET' || !allowUrl(request.url) })
    })
    return session
  }
  const sessions = [restrict(network)]
  return (url, options, slot = 0) => {
    const session = sessions[slot] ??= connection ? restrict(connection(slot)) : network
    return session.fetch(url, { credentials: 'omit', cache: 'no-store', ...options })
  }
}

async function matchesInstaller(path, size, sha256) {
  const info = await fileInfo(path)
  if (!info?.isFile() || info.size !== size) return false
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex') === sha256
}

function trackProgress(total, progress, initial) {
  let received = initial
  let transferred = 0
  let since = performance.now()
  function report() {
    const now = performance.now()
    progress(received, total, Math.round(transferred * 1000 / Math.max(now - since, 1)))
    since = now
    transferred = 0
  }
  report()
  const timer = setInterval(report, 250)
  return {
    advance(bytes) {
      received += bytes
      transferred += Math.max(0, bytes)
    },
    reset() {
      received = transferred = 0
      since = performance.now()
      report()
    },
    report,
    stop: () => clearInterval(timer),
  }
}

async function requestWithTimeout({ request, url, signal, timeoutMs, headers, slot }, consume) {
  const controller = new AbortController()
  const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    active.throwIfAborted()
    response = await request(url, { redirect: 'follow', signal: active, headers }, slot)
    active.throwIfAborted()
    timer.refresh()
    return await consume(response, () => timer.refresh(), active)
  } catch (error) {
    controller.abort()
    if (signal?.aborted) throw new DownloadProblem('aborted')
    if (error instanceof DownloadProblem) throw error
    throw new DownloadProblem('failed')
  } finally {
    clearTimeout(timer)
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {})
  }
}

function checkLength(response, size) {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) !== size) throw new DownloadProblem('invalid')
}

async function fetchInto({ request, url, file, size, sha256, signal, timeoutMs, onBytes, onLead }) {
  try {
    await requestWithTimeout({ request, url, signal, timeoutMs }, async (response, refresh, active) => {
      if (!response.ok || !response.body) throw new DownloadProblem('failed')
      checkLength(response, size)
      const hash = createHash('sha256')
      const lead = Math.min(leadBytes, size)
      let received = 0
      let led = false
      const count = new Transform({
        transform(chunk, _encoding, done) {
          refresh()
          received += chunk.length
          if (received > size) return done(new DownloadProblem('invalid'))
          hash.update(chunk)
          onBytes(received)
          if (!led && received >= lead) {
            led = true
            onLead()
          }
          done(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(response.body), count, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: active })
      if (received !== size || hash.digest('hex') !== sha256) throw new DownloadProblem('invalid')
    })
  } catch (error) {
    await rm(file, { force: true })
    throw error
  }
}

// Older servers still race to the first megabyte and then download the package in one stream.
async function downloadWhole({ request, size, sha256, path, timeoutMs }, sources, progress) {
  const attempts = sources.map((url, index) => ({ url, file: `${path}.${index}.part`, controller: new AbortController() }))
  let winner
  let shown = 0
  const report = (attempt, received) => {
    if (winner ? winner !== attempt : received <= shown) return
    progress.advance(received - shown)
    shown = received
  }
  const run = (attempt, alone) => fetchInto({
    request, url: attempt.url, file: attempt.file, size, sha256, signal: attempt.controller.signal, timeoutMs,
    onBytes: (received) => report(attempt, received),
    onLead: () => {
      if (alone || winner) return
      winner = attempt
      for (const other of attempts) if (other !== attempt) other.controller.abort()
    },
  })

  const raced = await Promise.allSettled(attempts.map((attempt) => run(attempt, false)))
  const finished = (attempt) => raced[attempts.indexOf(attempt)].status === 'fulfilled'
  let used = winner && finished(winner) ? winner : attempts.find(finished)
  const problems = raced.flatMap((result) => result.status === 'rejected' && result.reason.kind !== 'aborted' ? [result.reason] : [])

  if (!used && winner) {
    for (const attempt of attempts) {
      if (attempt === winner) continue
      attempt.controller = new AbortController()
      winner = attempt
      shown = 0
      progress.reset()
      try {
        await run(attempt, true)
        used = attempt
        break
      } catch (error) {
        problems.push(error)
      }
    }
  }
  try {
    if (!used) throw problems.find((problem) => problem.kind === 'invalid') ?? problems[0] ?? new DownloadProblem('failed')
    await rename(used.file, path)
    return used.url
  } finally {
    await Promise.all(attempts.map((attempt) => rm(attempt.file, { force: true })))
  }
}

async function fetchRange({ request, size, timeoutMs, slot }, url, { start, length }, signal, onBytes) {
  const end = start + length - 1
  const headers = { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' }
  return requestWithTimeout({ request, url, headers, signal, timeoutMs, slot }, async (response, refresh, active) => {
    if (!response.ok || !response.body) throw new DownloadProblem('failed')
    if (response.status === 200) {
      checkLength(response, size)
      throw new DownloadProblem('unsupported')
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
    const encoding = response.headers.get('content-encoding')
    if (response.status !== 206 || !range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) !== size
      || encoding && encoding.toLowerCase() !== 'identity') throw new DownloadProblem('invalid')
    checkLength(response, length)
    const bytes = Buffer.allocUnsafe(length)
    let received = 0
    for await (const chunk of addAbortSignal(active, Readable.fromWeb(response.body))) {
      refresh()
      if (received + chunk.length > length) throw new DownloadProblem('invalid')
      bytes.set(chunk, received)
      received += chunk.length
      onBytes?.(chunk.length)
    }
    if (received !== length) throw new DownloadProblem('invalid')
    return bytes
  })
}

async function probeRange(options, source, signal) {
  try {
    await fetchRange({ ...options, timeoutMs: Math.min(options.timeoutMs, 8_000) }, source.url, { start: 0, length: 1 }, signal)
    source.mode = 'range'
  } catch (error) {
    source.mode = error.kind === 'unsupported' ? 'whole' : 'unavailable'
  }
}

async function rangeSource(options, sources, start, signal) {
  for (let offset = 0; offset < sources.length && !signal?.aborted; offset++) {
    const index = (start + offset) % sources.length
    const source = sources[index]
    // Probe lazily in priority order. A working mirror can start transferring before GitHub answers.
    await (source.probed ??= probeRange(options, source, signal))
    if (source.mode === 'range' && !signal?.aborted) return index
  }
}

async function fetchBlock(options, sources, block, signal, progress) {
  let index = await rangeSource(options, sources, 0, signal)
  let problem = new DownloadProblem('failed')
  for (let attempt = 0; index !== undefined && !signal.aborted; attempt++) {
    const source = sources[index]
    let received = 0
    try {
      return await fetchRange(options, source.url, block, signal, (bytes) => {
        received += bytes
        progress.advance(bytes)
      })
    } catch (error) {
      progress.advance(-received)
      if (error.kind === 'unsupported') source.mode = 'whole'
      else if (error.kind !== 'aborted') problem = error
      if (attempt === blockRetries) break
      index = await rangeSource(options, sources, index + 1, signal)
    }
  }
  throw problem
}

async function downloadBlocks(options, sources, part, progress) {
  const pending = part.pending
  const file = await part.writer()
  const controller = new AbortController()
  let next = 0
  let failure
  async function worker(slot) {
    const connection = { ...options, slot }
    while (!controller.signal.aborted && next < pending.length) {
      const block = pending[next++]
      try {
        const bytes = await fetchBlock(connection, sources, block, controller.signal, progress)
        await file.save(block, bytes)
      } catch (error) {
        failure ??= error
        controller.abort()
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(connections, pending.length) }, (_, slot) => worker(slot)))
    if (failure) throw failure
  } finally { await file.close() }
}

/** Prefer the first range-capable source and retry only the failed block on other sources. */
async function downloadVerified({ request, sources, size, sha256, path, progress, timeoutMs = 45_000 }) {
  // Clean up the single-stream attempts left by a previous process.
  await Promise.all(sources.map((_, index) => rm(`${path}.${index}.part`, { force: true })))
  const part = partialDownload(path, size, sha256)
  if (await fileInfo(path)) {
    if (await matchesInstaller(path, size, sha256)) {
      await part.discard()
      progress(size, size, 0)
      return
    }
    await rm(path, { force: true })
    await part.discard()
  }
  await part.restore()
  const tracker = trackProgress(size, progress, part.received)
  const options = { request, size, sha256, path, timeoutMs }
  const candidates = [...new Set(sources)].map((url) => ({ url }))

  async function finishBlocks() {
    const valid = await matchesInstaller(part.data, size, sha256)
    if (valid) await rename(part.data, path)
    await part.discard()
    if (valid) tracker.report()
    return valid
  }

  async function whole(urls, previous) {
    tracker.reset()
    try {
      const used = await downloadWhole(options, urls, tracker)
      await part.discard()
      tracker.report()
      return used
    } catch (error) {
      throw previous?.kind === 'invalid' && error.kind !== 'invalid' ? previous : error
    }
  }

  try {
    if (part.complete) {
      if (await finishBlocks()) return
      tracker.reset()
    }
    const primary = await rangeSource(options, candidates, 0)
    if (primary === undefined) return await whole(sources)
    try {
      await downloadBlocks(options, candidates, part, tracker)
    } catch (error) {
      if (!(error instanceof DownloadProblem)) throw error
      if (!part.received) await part.discard()
      const fallback = candidates.filter((source) => source.mode === 'whole').map((source) => source.url)
      if (!fallback.length) throw error
      return await whole(fallback, error)
    }
    if (await finishBlocks()) return
    // Only the release's whole-file hash is authoritative. A mismatched file has no reusable blocks.
    const invalid = new DownloadProblem('invalid')
    const alternate = candidates.filter((_, index) => index !== primary).map((source) => source.url)
    if (!alternate.length) throw invalid
    return await whole(alternate, invalid)
  } finally { tracker.stop() }
}

module.exports = { downloadVerified, installerRequest, matchesInstaller, DownloadProblem, leadBytes }
