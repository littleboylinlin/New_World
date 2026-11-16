import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const require = createRequire(import.meta.url)
const { projectPaths, readProjectFile, saveProjectFile, maxBytes } = require('../../desktop/project-files.cjs')

test('project CLI paths preserve Unicode, relative paths and spaces, ignore switches', () => {
  assert.deepEqual(projectPaths(['app', '--quick-note', '--evil.newworld', '中文 空格.NEWWorld', '/tmp/readme.txt'], '/tmp'), [resolve('/tmp/中文 空格.NEWWorld')])
})

test('project writes are atomic, verified, Unicode-safe; failures leave the old file intact and no partial', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nw-project-'))
  const path = join(directory, '中文 ✦ 稿件.newworld')
  try {
    await saveProjectFile(path, Buffer.from('PK first'))
    assert.equal((await readProjectFile(path)).name, '中文 ✦ 稿件.newworld')
    assert.equal((await readProjectFile(path)).bytes.toString(), 'PK first')
    const fs = await import('node:fs/promises')
    await assert.rejects(saveProjectFile(path, Buffer.from('PK replacement'), { ...fs, rename: async () => { throw new Error('disk failure') } }))
    assert.equal((await readFile(path)).toString(), 'PK first')
    assert.deepEqual(await readdir(directory), ['中文 ✦ 稿件.newworld'])
    await assert.rejects(saveProjectFile(path, Buffer.from('PK bad'), { ...fs, readFile: async () => Buffer.from('corrupt write') }))
    assert.equal((await readFile(path)).toString(), 'PK first')
    await saveProjectFile(path, Buffer.from('PK complete'))
    assert.equal((await readFile(path)).toString(), 'PK complete')
    const big = join(directory, 'huge.newworld')
    const handle = await fs.open(big, 'w'); await handle.truncate(maxBytes + 1); await handle.close()
    await assert.rejects(readProjectFile(big), /size/)
    await assert.rejects(readProjectFile(directory), /filename/)
    await assert.rejects(readProjectFile('relative.newworld'), /filename/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
