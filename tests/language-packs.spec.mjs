import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { systemLocale } from '../shared/language-packs.mjs'

const require = createRequire(import.meta.url)
const { createLanguageStore } = require('../desktop/language.cjs')
const manifest = JSON.parse(await readFile('public/locales/manifest.json', 'utf8'))

async function sandbox() {
  return mkdtemp(join(tmpdir(), 'nw-language-'))
}

function network(requests) {
  return async (url) => {
    requests.push(url)
    const name = url.split('/').at(-1)
    return new Response(await readFile(join('public/locales', name)))
  }
}

test('系统语言匹配中文，其他语言回退英语', () => {
  for (const value of ['zh-CN', 'zh-TW', 'zh_HK', 'ZH-sg']) expect(systemLocale(value)).toBe('zh-CN')
  for (const value of ['en-US', 'en-GB', 'fr-FR', '', null]) expect(systemLocale(value)).toBe('en')
})

test('首次只下载系统所需的一个语言包，重开和断网时复用缓存', async () => {
  const root = await sandbox()
  const requests = []
  try {
    const store = await createLanguageStore({ root, manifest, request: network(requests) })
    await store.initialize('en-US')
    expect(requests).toEqual([`https://github.com/littleboylinlin/New_World/releases/download/v${manifest.version}/New-World-lang-en.json`])
    expect(await readdir(join(root, 'packs', manifest.version))).toEqual(['en.json'])
    const offline = await createLanguageStore({ root, manifest, request: () => { throw new Error('offline') } })
    expect((await offline.initialize('zh-CN')).locale).toBe('en')
    expect(offline.current.messages['settings.title']).toBe('Settings')
    expect(requests).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('损坏的下载或缓存不会切换语言，重试后只取得所选语言', async () => {
  const root = await sandbox()
  const requests = []
  let damaged = false
  try {
    const store = await createLanguageStore({ root, manifest, request: (url) => damaged
      ? new Response('broken') : network(requests)(url) })
    await store.initialize('zh-CN')
    expect(await readdir(join(root, 'packs', manifest.version))).toEqual(['zh-CN.json'])
    damaged = true
    await expect(store.activate('en')).rejects.toThrow()
    expect(store.current.locale).toBe('zh-CN')
    expect(JSON.parse(await readFile(join(root, 'language.json'), 'utf8')).locale).toBe('zh-CN')
    damaged = false
    await store.activate('en')
    await writeFile(join(root, 'packs', manifest.version, 'en.json'), 'corrupt')
    const reopened = await createLanguageStore({ root, manifest, request: network(requests) })
    expect((await reopened.initialize('zh-CN')).locale).toBe('en')
    expect(requests.map((url) => url.split('/').at(-1))).toEqual([
      'New-World-lang-zh-CN.json', 'New-World-lang-en.json', 'New-World-lang-en.json',
    ])
    await expect(store.activate('../en')).rejects.toThrow('Unsupported language')
    expect(requests).toHaveLength(3)
  } finally { await rm(root, { recursive: true, force: true }) }
})
