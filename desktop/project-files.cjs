// Project files are explicit imports/exports, never an alternate live database.
const { randomUUID, createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const { basename, dirname, extname, isAbsolute, join, resolve } = require('node:path')
const maxBytes = 512 * 1024 * 1024
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

function projectPaths(argv, cwd = process.cwd()) {
  return argv.filter((arg) => typeof arg === 'string' && !arg.startsWith('-') && extname(arg).toLowerCase() === '.newworld')
    .map((arg) => isAbsolute(arg) ? arg : resolve(cwd, arg))
}
async function readProjectFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || extname(path).toLowerCase() !== '.newworld') throw new Error('Invalid project filename')
  // Read through a handle: a replaced path cannot bypass the size check.
  const handle = await fs.open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || !stat.size || stat.size > maxBytes) throw new Error('Invalid project file size')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) throw new Error('Project file changed while reading')
      offset += result.bytesRead
    }
    const after = await handle.stat()
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Project file changed while reading')
    return { name: basename(path), bytes }
  } finally { await handle.close() }
}
async function saveProjectFile(path, input, operations = fs) {
  if (typeof path !== 'string' || !isAbsolute(path) || extname(path).toLowerCase() !== '.newworld'
    || !(input instanceof Uint8Array) || !input.byteLength || input.byteLength > maxBytes) throw new Error('Invalid project export')
  const bytes = Buffer.from(input)
  const temp = join(dirname(path), `.newworld-${randomUUID()}.partial`)
  let handle
  try {
    handle = await operations.open(temp, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close(); handle = undefined
    // Re-read the written file. The renderer has validated these exact bytes with readProject.
    if (digest(await operations.readFile(temp)) !== digest(bytes)) throw new Error('Project write verification failed')
    await operations.rename(temp, path)
  } finally {
    await handle?.close().catch(() => {})
    await operations.rm(temp, { force: true }).catch(() => {})
  }
}
module.exports = { projectPaths, readProjectFile, saveProjectFile, maxBytes }
