import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

async function fixture(path, { corrupt = false, cancel = false, wrongPlatform = false } = {}) {
  const requests = []
  const opened = []
  const network = { webRequest: { onBeforeRequest: () => {} }, fetch: async (address) => {
    requests.push(address)
    if (address === releaseEndpoint + '/tags/' + tag) return Response.json(wrongPlatform ? { ...metadata, assets: [{ ...metadata.assets[0], name: 'New-World-Setup-1.0.0-x64.exe' }] } : metadata)
    return new Response(corrupt ? 'x' : bytes)
  } }
  const updater = await createMacUpdater({ network, version: '0.9.0', arch: 'arm64', chooseDestination: async () => cancel ? undefined : path, openPackage: async (path) => { opened.push(path); return '' } })
  return { updater, requests, opened }
}

test('DMG 校验后才替换目标文件，打开前重新校验', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nw-mac-update-'))
  const target = join(directory, name)
  try {
    const { updater, opened } = await fixture(target)
    await updater.download(tag, () => {})
    expect(await readFile(target)).toEqual(bytes)
    await writeFile(target, 'tampered')
    await expect(updater.install(tag)).rejects.toThrow('Checksum')
    expect(opened).toEqual([])
    await updater.download(tag, () => {})
    await updater.install(tag)
    expect(opened).toEqual([target])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('取消下载不取得 DMG，损坏的下载保留目标原文件，其他平台被拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nw-mac-update-'))
  const target = join(directory, name)
  try {
    await writeFile(target, 'keep')
    const canceled = await fixture(target, { cancel: true })
    expect(await canceled.updater.download(tag, () => {})).toBe(false)
    expect(canceled.requests).toHaveLength(1)
    const broken = await fixture(target, { corrupt: true })
    await expect(broken.updater.download(tag, () => {})).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('keep')
    const wrong = await fixture(target, { wrongPlatform: true })
    await expect(wrong.updater.download(tag, () => {})).rejects.toThrow('unavailable')
    expect(wrong.requests).toHaveLength(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
