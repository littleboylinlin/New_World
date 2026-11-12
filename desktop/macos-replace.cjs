const { spawn } = require('node:child_process')
const { execFile } = require('node:child_process')
const { lstat, stat, readFile, writeFile, rename, rm, rmdir } = require('node:fs/promises')
const { dirname, isAbsolute, join, resolve } = require('node:path')
const { promisify } = require('node:util')

const command = promisify(execFile)
const tokenPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

async function writeJSON(path, value) {
  const temporary = path + '.tmp'
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, path)
}

function validatePlan(plan, cache) {
  if (!plan || !tokenPattern.test(plan.id) || !isAbsolute(plan.target) || !plan.target.endsWith('.app')
    || !/^\d+\.\d+\.\d+$/.test(plan.version) || !Number.isSafeInteger(plan.parentPid) || plan.parentPid <= 1
    || plan.directory !== join(resolve(cache), 'job-' + plan.id)
    || plan.stageRoot !== join(dirname(plan.target), '.NewWorld-update-' + plan.id)
    || plan.stage !== join(plan.stageRoot, 'New World.app')) throw new Error('Invalid Mac update transaction')
  return plan
}

async function swap(plan) {
  await command('/usr/bin/osascript', ['-l', 'JavaScript', join(__dirname, 'macos-swap.js'), plan.stage, plan.target], { timeout: 30_000 })
}

async function waitForExit(pid, timeout = 60_000) {
  const until = Date.now() + timeout
  while (alive(pid)) {
    if (Date.now() >= until) throw new Error('The application did not exit')
    await delay(200)
  }
}

async function launch(plan, failed = false) {
  const env = { ...process.env }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NEW_WORLD_UPDATE_TOKEN', 'NEW_WORLD_UPDATE_FAILED']) delete env[name]
  env[failed ? 'NEW_WORLD_UPDATE_FAILED' : 'NEW_WORLD_UPDATE_TOKEN'] = plan.id
  return new Promise((done, reject) => {
    const child = spawn(join(plan.target, 'Contents', 'MacOS', 'New World'), [], { env, detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); done(child.pid) })
  })
}

async function waitForBoot(plan, pid) {
  const until = Date.now() + 60_000
  while (Date.now() < until && alive(pid)) {
    const receipt = await readFile(join(plan.directory, 'boot.json'), 'utf8').then(JSON.parse).catch(() => undefined)
    if (receipt?.id === plan.id && receipt.version === plan.version && receipt.pid === pid) return
    await delay(200)
  }
  throw new Error('The updated application did not finish starting')
}

async function discardStage(plan) {
  const mount = await stat(join(plan.directory, 'mounted')).catch(() => undefined)
  if (mount && mount.dev !== (await stat(plan.directory)).dev) {
    await command('/usr/bin/hdiutil', ['detach', join(plan.directory, 'mounted')], { timeout: 30_000 })
  }
  await rm(plan.stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  await rmdir(plan.stageRoot)
  await rm(plan.directory, { recursive: true, force: true })
}

async function runUpdate(plan, options = {}) {
  const exchange = options.swap || swap
  const startApp = options.launch || launch
  const boot = options.waitForBoot || waitForBoot
  const parentExit = options.waitForExit || waitForExit
  const stop = options.stop || (async (pid) => {
    if (!alive(pid)) return
    process.kill(pid, 'SIGTERM')
    await waitForExit(pid, 5000).catch(async () => { if (alive(pid)) process.kill(pid, 'SIGKILL'); await waitForExit(pid, 5000) })
  })
  let exchanged = false
  let committed = false
  let pid
  const cache = dirname(plan.directory)
  validatePlan(plan, cache)
  try {
    await parentExit(plan.parentPid)
    await exchange(plan)
    exchanged = true
    pid = await startApp(plan)
    await boot(plan, pid)
    committed = true
    const result = { id: plan.id, version: plan.version, state: 'installed', pid }
    await discardStage(plan).catch((error) => { result.cleanupPending = true; console.warn('Mac update cleanup deferred:', error.code) })
    await writeJSON(join(cache, 'last-update.json'), result)
  } catch (error) {
    if (committed) throw error
    if (pid) await stop(pid)
    if (exchanged) await exchange(plan)
    const result = { id: plan.id, version: plan.version, state: 'rolled-back', error: String(error.message).slice(0, 500) }
    await writeJSON(join(cache, 'last-update.json'), result)
    if (exchanged || !alive(plan.parentPid)) {
      result.pid = await startApp(plan, true)
      await writeJSON(join(cache, 'last-update.json'), result)
    }
    await discardStage(plan).catch(() => {})
  }
}

async function finishBoot({ cache, target, version, token }) {
  if (tokenPattern.test(token || '')) {
    const plan = validatePlan(JSON.parse(await readFile(join(cache, 'job-' + token, 'plan.json'), 'utf8')), cache)
    if (plan.target !== target || plan.version !== version) throw new Error('Mac update receipt does not match this application')
    await writeJSON(join(plan.directory, 'boot.json'), { id: plan.id, version, pid: process.pid })
  }
  const directories = await require('node:fs/promises').readdir(cache, { withFileTypes: true }).catch(() => [])
  for (const entry of directories) {
    if (!entry.isDirectory() || !/^job-/.test(entry.name)) continue
    try {
      const plan = validatePlan(JSON.parse(await readFile(join(cache, entry.name, 'plan.json'), 'utf8')), cache)
      if (plan.target !== target || plan.directory !== join(cache, entry.name)) continue
      const worker = await readFile(join(plan.directory, 'worker.json'), 'utf8').then(JSON.parse).catch(() => undefined)
      if (Number.isSafeInteger(worker?.pid) && worker.pid > 1 && alive(worker.pid)) {
        const { stdout } = await command('/bin/ps', ['-p', String(worker.pid), '-o', 'command='])
        if (stdout.includes(join(plan.directory, 'macos-replace.cjs'))) continue
      }
      if (!(await lstat(target)).isDirectory()) continue
      await discardStage(plan)
    } catch (error) {
      if (error.code === 'ENOENT' && tokenPattern.test(entry.name.slice(4))) {
        await rm(join(cache, entry.name, 'plan.json.tmp'), { force: true }).catch(() => {})
        await rmdir(join(cache, entry.name)).catch(() => {})
      } else console.warn('Mac update recovery deferred:', error.code || error.message)
    }
  }
}

module.exports = { validatePlan, writeJSON, runUpdate, finishBoot }

if (require.main === module) {
  ;(async () => {
    const file = process.argv[2]
    const plan = validatePlan(JSON.parse(await readFile(file, 'utf8')), dirname(dirname(file)))
    if (process.send) await new Promise((done, reject) => process.send({ ready: true }, (error) => error ? reject(error) : done()))
    process.disconnect?.()
    await runUpdate(plan)
  })().catch((error) => { console.error(error); process.exitCode = 1 })
}
