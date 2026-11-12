import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from '@playwright/test'
import { releaseEndpoint, releasePages } from '../desktop/release.mjs'

const { createMacUpdater } = createRequire(import.meta.url)('../desktop/macos-update.cjs')
const tag = 'v1.0.0'
const name = 'New-World-1.0.0-macos-arm64.dmg'
const bytes = Buffer.from('test disk image')
const url = `${releasePages}download/${tag}/${name}`
const metadata = { tag_name: tag, draft: false, prerelease: false, assets: [{ name, size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), state: 'uploaded', browser_download_url: url }] }

async function fixture(cache, { corrupt = false, wrongPlatform = false, failInstall = false } = {}) {
  const requests = [], installed = []
  const network = { webRequest: { onBeforeRequest: () => {} }, fetch: async (address) => {
    requests.push(address)
    if (address === releaseEndpoint + '/tags/' + tag) return Response.json(wrongPlatform ? { ...metadata, assets: [{ ...metadata.assets[0], name: 'New-World-Setup-1.0.0-x64.exe' }] } : metadata)
    return new Response(corrupt ? 'x' : bytes)
  } }
  const installer = {
    prepare: async (path, tag) => { if (failInstall) throw new Error('invalid application'); return { bytes: await readFile(path), tag } },
    install: async (plan) => { installed.push(plan) },
  }
  return { updater: await createMacUpdater({ network, cache, version: '0.9.0', arch: 'arm64', installer }), requests, installed }
}

test('Mac 下载使用应用缓存，安装前复核，交接后清理安装包', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-mac-update-'))
  const cache = join(root, 'cache')
  try {
    await writeFile(join(root, 'saved-by-user.dmg'), 'keep')
    const { updater, installed } = await fixture(cache)
    await updater.download(tag, () => {})
    const target = join(cache, (await readdir(cache))[0], name)
    expect(await readFile(target)).toEqual(bytes)
    await writeFile(target, 'tampered')
    await expect(updater.install(tag)).rejects.toThrow('Checksum')
    expect(installed).toEqual([])
    expect(await readdir(cache)).toEqual([])
    await updater.download(tag, () => {})
    await updater.install(tag)
    expect(installed).toEqual([{ tag, bytes }])
    expect(await readdir(cache)).toEqual([])
    expect(await readFile(join(root, 'saved-by-user.dmg'), 'utf8')).toBe('keep')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Mac 拒绝损坏与其他平台的安装包，失败后没有下载残留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-mac-update-'))
  try {
    await mkdir(join(root, 'unrelated'))
    const broken = await fixture(root, { corrupt: true })
    await expect(broken.updater.download(tag, () => {})).rejects.toThrow()
    expect(await readdir(root)).toEqual(['unrelated'])
    const wrong = await fixture(root, { wrongPlatform: true })
    await expect(wrong.updater.download(tag, () => {})).rejects.toThrow('unavailable')
    expect(wrong.requests).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Mac 应用准备失败时清理缓存，允许重新下载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-mac-update-'))
  try {
    const { updater } = await fixture(root, { failInstall: true })
    await updater.download(tag, () => {})
    await expect(updater.install(tag)).rejects.toThrow('openFailed')
    expect(await readdir(root)).toEqual([])
    await updater.download(tag, () => {})
    expect(await readdir(root)).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
