const { createHash } = require('node:crypto')
const { lstat, open, readFile, rename, rm, writeFile } = require('node:fs/promises')

const blockBytes = 4 * 1024 * 1024
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function fileInfo(path) {
  try { return await lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

function partialDownload(path, size, sha256) {
  const data = `${path}.range.part`
  const state = `${data}.json`
  const temporary = `${state}.tmp`
  const blocks = Array.from({ length: Math.ceil(size / blockBytes) }, (_, index) => {
    const start = index * blockBytes
    return { index, start, length: Math.min(blockBytes, size - start) }
  })
  const completed = new Map()

  async function discard() {
    await rm(state, { force: true })
    await rm(temporary, { force: true })
    await rm(data, { force: true })
    completed.clear()
  }

  async function restore() {
    await rm(temporary, { force: true })
    const [info, record] = await Promise.all([fileInfo(data), fileInfo(state)])
    if (!info && !record) return
    if (!info?.isFile() || info.size !== size || !record?.isFile()) return discard()
    let saved
    try { saved = JSON.parse(await readFile(state, 'utf8')) }
    catch (error) { if (error instanceof SyntaxError) return discard(); throw error }
    if (saved?.version !== 1 || saved.size !== size || saved.sha256 !== sha256 || saved.blockBytes !== blockBytes
      || !Array.isArray(saved.completed) || !saved.completed.length || saved.completed.length > blocks.length) return discard()
    const restored = new Map()
    for (const entry of saved.completed) {
      if (!Array.isArray(entry) || entry.length !== 2) return discard()
      const [index, hash] = entry
      if (!Number.isInteger(index) || !blocks[index] || restored.has(index) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return discard()
      restored.set(index, hash)
    }
    // These hashes detect damage to the saved data. The release hash is still checked at the end.
    const file = await open(data, 'r')
    let intact = true
    try {
      for (const [index, hash] of restored) {
        const { start, length } = blocks[index]
        const bytes = Buffer.allocUnsafe(length)
        const { bytesRead } = await file.read(bytes, 0, length, start)
        if (bytesRead !== length || digest(bytes) !== hash) { intact = false; break }
      }
    } finally { await file.close() }
    if (!intact) return discard()
    for (const [index, hash] of restored) completed.set(index, hash)
  }

  async function writer() {
    const file = await open(data, completed.size ? 'r+' : 'wx+', 0o600)
    try {
      if (!completed.size) await file.truncate(size)
    } catch (error) {
      await file.close()
      throw error
    }
    let writing = Promise.resolve()
    return {
      save({ index, start }, bytes) {
        writing = writing.then(async () => {
          let written = 0
          while (written < bytes.length) {
            const { bytesWritten } = await file.write(bytes, written, bytes.length - written, start + written)
            if (!bytesWritten) throw new Error('Incomplete installer write')
            written += bytesWritten
          }
          // Persist the bytes before publishing the completion record. Serialize both operations.
          await file.datasync()
          const hash = digest(bytes)
          const saved = { version: 1, size, sha256, blockBytes, completed: [...completed, [index, hash]] }
          await writeFile(temporary, JSON.stringify(saved), { flag: 'wx', mode: 0o600, flush: true })
          await rename(temporary, state)
          completed.set(index, hash)
        })
        return writing
      },
      close: () => file.close(),
    }
  }

  return {
    data, restore, discard, writer,
    get complete() { return completed.size === blocks.length },
    get pending() { return blocks.filter(({ index }) => !completed.has(index)) },
    get received() { return [...completed.keys()].reduce((total, index) => total + blocks[index].length, 0) },
  }
}

module.exports = { blockBytes, fileInfo, partialDownload }
