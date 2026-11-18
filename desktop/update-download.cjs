const { createHash } = require('node:crypto')
const { createWriteStream } = require('node:fs')
const { rename, rm } = require('node:fs/promises')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const leadBytes = 1024 * 1024

/** kind: 'invalid' when size or SHA-256 disagree, 'failed' for network trouble, 'aborted' for the race loser. */
class DownloadProblem extends Error {
  constructor(kind) {
    super(kind)
    this.kind = kind
  }
}

async function fetchInto({ request, url, file, size, sha256, signal, timeoutMs, onBytes, onLead }) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  const hash = createHash('sha256')
  const lead = Math.min(leadBytes, size)
  let received = 0
  let led = false
  try {
    const response = await request(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok || !response.body) throw new DownloadProblem('failed')
    const declared = response.headers?.get?.('content-length')
    if (declared && Number(declared) !== size) throw new DownloadProblem('invalid')
    timer.refresh()
    const count = new Transform({
      transform(chunk, _encoding, done) {
        timer.refresh()
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
    await pipeline(Readable.fromWeb(response.body), count, createWriteStream(file, { flags: 'wx' }), { signal: controller.signal })
    if (received !== size || hash.digest('hex') !== sha256) throw new DownloadProblem('invalid')
  } catch (error) {
    await rm(file, { force: true })
    if (error instanceof DownloadProblem) throw error
    throw new DownloadProblem(signal.aborted ? 'aborted' : 'failed')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/**
 * Starts every source at once and keeps the one that delivers the first megabyte; the others are aborted.
 * The result must match size and SHA-256. If the kept source fails or is corrupt, each other source is
 * tried again on its own; only when all of them fail is the error raised. Resolves to the URL used.
 */
async function downloadVerified({ request, sources, size, sha256, path, progress, timeoutMs = 45_000 }) {
  const attempts = sources.map((url, index) => ({ url, file: `${path}.${index}.part`, controller: new AbortController() }))
  let winner
  let shown = 0
  const report = (attempt, received) => {
    if (winner ? winner !== attempt : received <= shown) return
    shown = received
    progress(received, size)
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

  progress(0, size)
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
      progress(0, size)
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
    for (const attempt of attempts) if (attempt !== used) await rm(attempt.file, { force: true })
  }
}

module.exports = { downloadVerified, DownloadProblem, leadBytes }
