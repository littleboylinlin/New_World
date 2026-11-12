import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, utimes, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const require = createRequire(import.meta.url)
const { cleanDownloads, cleanLanguageCache, cleanLegacyMacDownloads } = require('../desktop/cleanup.cjs')
const { createLanguageStore } = require('../desktop/language.cjs')
const { runUpdate, finishBoot, validatePlan } = require('../desktop/macos-replace.cjs')
const { hasArchitecture } = require('../desktop/macos-install.cjs')
const manifest = JSON.parse(await readFile('public/locales/manifest.json', 'utf8'))
const exists = (path) => stat(path).then(() => true, () => false)

test('直接读取 Mac 可执行文件芯片信息，无需安装开发工具', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-mach-o-'))
  try {
    const file = join(root, 'New World')
    const header = Buffer.alloc(32)
    header.writeUInt32LE(0xfeedfacf, 0)
    header.writeUInt32LE(0x0100000c, 4)
    await writeFile(file, header)
    expect(await hasArchitecture(file, 'arm64')).toBe(true)
    expect(await hasArchitecture(file, 'x64')).toBe(false)
    await writeFile(file, 'invalid')
    expect(await hasArchitecture(file, 'arm64')).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('更新缓存只清理应用创建的目录，不跟随链接或删除其他文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-cleanup-'))
  try {
    const cache = join(root, 'cache'), books = join(root, 'books')
    await mkdir(join(cache, 'download-Ab123C'), { recursive: true })
    await writeFile(join(cache, 'download-Ab123C', 'previous.exe'), 'old')
    await mkdir(books)
    await writeFile(join(books, 'manuscript.txt'), 'keep')
    await mkdir(join(cache, 'unrelated'))
    await symlink(books, join(cache, 'download-Qw123E'), 'dir')
    await cleanDownloads(cache)
    expect(await exists(join(cache, 'download-Ab123C'))).toBe(false)
    expect(await readFile(join(books, 'manuscript.txt'), 'utf8')).toBe('keep')
    expect(await readdir(cache)).toEqual(['download-Qw123E', 'unrelated'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('新版语言包准备成功后才清理旧包，保留偏好、当前语言及非缓存文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-cleanup-'))
  try {
    for (const version of ['0.0.0', '0.0.1', '99.0.0']) {
      await mkdir(join(root, 'packs', version), { recursive: true })
      await writeFile(join(root, 'packs', version, 'en.json'), 'old')
    }
    await writeFile(join(root, 'packs', '0.0.1', 'notes.txt'), 'keep')
    const store = await createLanguageStore({ root, manifest, developmentRoot: join(process.cwd(), 'public', 'locales') })
    await store.initialize('en-US')
    await store.prepare('zh-CN')
    expect(await exists(join(root, 'packs', '0.0.0'))).toBe(true)
    expect(JSON.parse(await readFile(join(root, 'language.json'), 'utf8')).locale).toBe('en')
    await store.cleanup()
    expect(await exists(join(root, 'packs', '0.0.0'))).toBe(false)
    expect(await readdir(join(root, 'packs', '0.0.1'))).toEqual(['notes.txt'])
    expect(await readdir(join(root, 'packs', manifest.version))).toEqual(['en.json', 'zh-CN.json'])
    expect(await readFile(join(root, 'packs', '99.0.0', 'en.json'), 'utf8')).toBe('old')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('语言包获取失败不清理旧包，异常临时文件可在后续启动回收', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-cleanup-'))
  try {
    await mkdir(join(root, 'packs', '0.0.0'), { recursive: true })
    await writeFile(join(root, 'packs', '0.0.0', 'en.json'), 'old')
    const store = await createLanguageStore({ root, manifest, request: async () => new Response('broken') })
    await expect(store.initialize('en-US')).rejects.toThrow()
    expect(await readFile(join(root, 'packs', '0.0.0', 'en.json'), 'utf8')).toBe('old')
    const temporary = join(root, `language.json.${randomUUID()}.tmp`)
    await writeFile(temporary, 'interrupted')
    await utimes(temporary, 0, 0)
    await cleanLanguageCache(root, manifest.version)
    expect(await exists(temporary)).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Mac 旧下载残留只匹配应用临时文件，保留手动保存的 DMG', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-cleanup-'))
  try {
    const dmg = 'New-World-0.9.0-macos-arm64.dmg'
    const temporary = dmg + '.' + randomUUID() + '.download'
    for (const name of [dmg, temporary, 'my-book.download']) { await writeFile(join(root, name), 'keep'); await utimes(join(root, name), 0, 0) }
    await cleanLegacyMacDownloads(root)
    expect(await readdir(root)).toEqual([dmg, 'my-book.download'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function transaction(root) {
  const id = randomUUID(), cache = join(root, 'cache'), target = join(root, 'New World.app')
  const directory = join(cache, 'job-' + id), stageRoot = join(root, '.NewWorld-update-' + id)
  const stage = join(stageRoot, 'New World.app')
  await mkdir(directory, { recursive: true }); await mkdir(stage, { recursive: true }); await mkdir(target)
  await writeFile(join(target, 'obsolete.txt'), 'old')
  await writeFile(join(stage, 'current.txt'), 'new')
  const plan = { id, directory, stageRoot, stage, target, version: '1.0.0', parentPid: 10000 }
  await writeFile(join(directory, 'plan.json'), JSON.stringify(plan))
  const swap = async () => { const temporary = join(stageRoot, 'exchange'); await rename(target, temporary); await rename(stage, target); await rename(temporary, stage) }
  return { plan, cache, swap }
}

test('Mac 整包替换成功后移除旧文件、备份和事务目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-replace-'))
  try {
    const { plan, cache, swap } = await transaction(root)
    await writeFile(join(root, 'books.txt'), 'keep')
    await runUpdate(plan, { swap, launch: async () => 12345, waitForExit: async () => {}, waitForBoot: async () => { expect(await readFile(join(plan.target, 'current.txt'), 'utf8')).toBe('new'); expect(await exists(join(plan.stage, 'obsolete.txt'))).toBe(true) } })
    expect(await readdir(plan.target)).toEqual(['current.txt'])
    expect(await exists(plan.stageRoot)).toBe(false)
    expect(await exists(plan.directory)).toBe(false)
    expect(JSON.parse(await readFile(join(cache, 'last-update.json'), 'utf8')).state).toBe('installed')
    expect(await readFile(join(root, 'books.txt'), 'utf8')).toBe('keep')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Mac 新版启动失败时恢复完整旧包，回退后清理失败的新包', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-replace-'))
  try {
    const { plan, cache, swap } = await transaction(root)
    const launches = [], stopped = []
    await runUpdate(plan, { swap, launch: async (_, failed) => { launches.push(Boolean(failed)); return 12345 }, waitForExit: async () => {}, waitForBoot: async () => { throw new Error('boot failed') }, stop: async (pid) => { stopped.push(pid) } })
    expect(await readdir(plan.target)).toEqual(['obsolete.txt'])
    expect(launches).toEqual([false, true])
    expect(stopped).toEqual([12345])
    expect(await exists(plan.stageRoot)).toBe(false)
    expect(JSON.parse(await readFile(join(cache, 'last-update.json'), 'utf8')).state).toBe('rolled-back')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Mac 中断后的旧包在应用正常启动后回收，拒绝越界路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-replace-'))
  try {
    const { plan, cache, swap } = await transaction(root)
    expect(() => validatePlan({ ...plan, stage: root }, cache)).toThrow()
    await swap()
    await finishBoot({ cache, target: plan.target, version: plan.version })
    expect(await readdir(plan.target)).toEqual(['current.txt'])
    expect(await exists(plan.directory)).toBe(false)
    expect(await exists(plan.stageRoot)).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Mac 启动确认保留当前更新事务，交由更新进程清理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-replace-'))
  try {
    const { plan, cache, swap } = await transaction(root)
    await swap()
    await finishBoot({ cache, target: plan.target, version: plan.version, token: plan.id })
    expect(await readFile(join(plan.stage, 'obsolete.txt'), 'utf8')).toBe('old')
    expect(JSON.parse(await readFile(join(plan.directory, 'boot.json'), 'utf8'))).toMatchObject({ id: plan.id, version: plan.version, pid: process.pid })
  } finally { await rm(root, { recursive: true, force: true }) }
})
