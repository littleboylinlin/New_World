const { spawn, execFile } = require('node:child_process')
const { constants, openSync, closeSync } = require('node:fs')
const { access, copyFile, lstat, mkdir, open, readFile, rm, rmdir } = require('node:fs/promises')
const { dirname, join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const { promisify } = require('node:util')
const { validatePlan, writeJSON, finishBoot } = require('./macos-replace.cjs')

const command = promisify(execFile)
const identifier = 'com.littleboylinlin.newworld'

async function hasArchitecture(path, arch) {
  const expected = { arm64: 0x0100000c, x64: 0x01000007 }[arch]
  if (!expected) return false
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(1024)
    const { bytesRead } = await file.read(bytes)
    if (bytesRead < 8) return false
    if (bytes.readUInt32LE(0) === 0xfeedfacf) return bytes.readUInt32LE(4) === expected
    const magic = bytes.readUInt32BE(0)
    if (![0xcafebabe, 0xcafebabf].includes(magic)) return false
    const count = bytes.readUInt32BE(4), stride = magic === 0xcafebabe ? 20 : 32
    if (count > 32 || 8 + count * stride > bytesRead) return false
    for (let index = 0; index < count; index++) if (bytes.readUInt32BE(8 + index * stride) === expected) return true
    return false
  } finally { await file.close() }
}

function createMacInstaller({ bundle, cache, arch, prepareLanguage }) {
  bundle = resolve(bundle)
  cache = resolve(cache)

  async function prepare(dmg, tag) {
    if (process.platform !== 'darwin' || !(await lstat(bundle)).isDirectory() || !bundle.endsWith('.app')) throw new Error('Use an installed Mac app')
    await access(dirname(bundle), constants.W_OK)
    await access(bundle, constants.W_OK)
    const id = randomUUID()
    const directory = join(cache, 'job-' + id)
    const stageRoot = join(dirname(bundle), '.NewWorld-update-' + id)
    const plan = validatePlan({ id, directory, stageRoot, stage: join(stageRoot, 'New World.app'), target: bundle, version: tag.slice(1), parentPid: process.pid }, cache)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    let mounted = false
    const mount = join(directory, 'mounted')
    try {
      await writeJSON(join(directory, 'plan.json'), plan)
      await mkdir(stageRoot, { mode: 0o700 })
      await mkdir(mount)
      await command('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { timeout: 60_000 })
      mounted = true
      const source = join(mount, 'New World.app')
      if (!(await lstat(source)).isDirectory()) throw new Error('The installer has no application bundle')
      const plist = join(source, 'Contents', 'Info.plist')
      for (const [key, expected] of [['CFBundleIdentifier', identifier], ['CFBundleShortVersionString', plan.version], ['CFBundleExecutable', 'New World']]) {
        const { stdout } = await command('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])
        if (stdout.trim() !== expected) throw new Error('The application metadata does not match this update')
      }
      if (!await hasArchitecture(join(source, 'Contents', 'MacOS', 'New World'), arch)) throw new Error('The installer is for another Mac architecture')
      await command('/usr/bin/ditto', [source, plan.stage], { timeout: 90_000 })
      await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', plan.stage], { timeout: 30_000 })
      const manifest = JSON.parse(await readFile(join(plan.stage, 'Contents', 'Resources', 'app.asar', 'desktop', 'language-manifest.json'), 'utf8'))
      if (manifest.version !== plan.version) throw new Error('The language manifest is for another version')
      await prepareLanguage(manifest)
      await command('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 })
      mounted = false
      for (const file of ['macos-replace.cjs', 'macos-swap.js']) await copyFile(join(__dirname, file), join(directory, file))
      return plan
    } catch (error) {
      if (mounted) await command('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 }).catch(() => {})
      await rm(plan.stage, { recursive: true, force: true }).catch(() => {})
      await rmdir(stageRoot).catch(() => {})
      await rm(directory, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  async function install(plan) {
    const log = openSync(join(plan.directory, 'worker.log'), 'a', 0o600)
    const child = spawn(process.execPath, [join(plan.directory, 'macos-replace.cjs'), join(plan.directory, 'plan.json')], {
      detached: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', log, log],
    })
    closeSync(log)
    let failure
    child.once('error', (error) => { failure = error })
    child.once('exit', (code) => { failure = new Error('The Mac update helper exited: ' + code) })
    try {
      await writeJSON(join(plan.directory, 'worker.json'), { pid: child.pid })
      const until = Date.now() + 10_000
      while (true) {
        if (failure) throw failure
        const ready = await readFile(join(plan.directory, 'worker-ready.json'), 'utf8').then(JSON.parse).catch(() => undefined)
        if (ready?.id === plan.id && ready.pid === child.pid) break
        if (Date.now() >= until) throw new Error('The Mac update helper did not start')
        await new Promise((done) => setTimeout(done, 100))
      }
    } catch (error) {
      child.kill()
      await rm(plan.stage, { recursive: true, force: true }).catch(() => {})
      await rmdir(plan.stageRoot).catch(() => {})
      await rm(plan.directory, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    child.unref()
  }

  return { prepare, install, finishBoot: (version, token) => finishBoot({ cache, target: bundle, version, token }) }
}

module.exports = { createMacInstaller, hasArchitecture }
