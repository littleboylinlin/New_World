import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const require = createRequire(import.meta.url)
const storage = require('../desktop/storage-location.cjs')

const dirs = []

function sandbox() {
  const appData = mkdtempSync(join(tmpdir(), 'nw-location-'))
  dirs.push(appData)
  return appData
}

function seedLibrary(profile, marker = '数据') {
  const folder = join(profile, 'IndexedDB', 'leveldb')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'marker.txt'), marker)
}

function markerAt(profile) {
  const file = join(profile, 'IndexedDB', 'leveldb', 'marker.txt')
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

test.afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('没有配置时使用默认位置，且不产生配置文件或搬运', () => {
  const appData = sandbox()
  const state = storage.readLocation(appData)
  expect(state.current).toBe(join(appData, 'NewWorld'))
  expect(state.custom).toBe(false)
  expect(state.pending).toBe(null)
  expect(existsSync(storage.configFile(appData))).toBe(false)
  const applied = storage.applyPending(appData)
  expect(applied.current).toBe(join(appData, 'NewWorld'))
  expect(applied.moved).toBe(false)
})

test('拒绝无效目标：相对路径、当前位置、父子目录、非空目录、安装目录', () => {
  const appData = sandbox()
  const current = storage.defaultLocation(appData)
  mkdirSync(current, { recursive: true })
  const programDir = join(appData, 'Program')
  mkdirSync(programDir, { recursive: true })
  const occupied = join(appData, ' occupied')
  mkdirSync(occupied, { recursive: true })
  writeFileSync(join(occupied, 'photo.txt'), 'x')

  const check = (target) => storage.validateTarget(target, { current, appData, programDir })
  expect(check('相对/路径')).not.toBe(null)
  expect(check('')).not.toBe(null)
  expect(check(current)).not.toBe(null)
  expect(check(appData)).not.toBe(null)
  expect(check(join(current, '子目录'))).not.toBe(null)
  expect(check(occupied)).not.toBe(null)
  expect(check(join(programDir, '书库'))).not.toBe(null)
  expect(check(join(appData, 'Fresh'))).toBe(null)
})

test('更改位置：写入待搬运，启动期把书库搬到新目录并记住', () => {
  const appData = sandbox()
  const current = storage.defaultLocation(appData)
  seedLibrary(current, '旧位置内容')
  const target = join(appData, 'MyBooks')

  const set = storage.setLocation(appData, target)
  expect(set.error).toBe(null)
  expect(storage.readLocation(appData).pending).toEqual({ from: current, to: target })

  const applied = storage.applyPending(appData)
  expect(applied.moved).toBe(true)
  expect(applied.current).toBe(target)
  expect(applied.custom).toBe(true)
  expect(markerAt(target)).toBe('旧位置内容')

  const state = storage.readLocation(appData)
  expect(state.pending).toBe(null)
  expect(state.custom).toBe(true)
})

test('恢复默认：把自定义位置的书库搬回默认目录并清掉自定义状态', () => {
  const appData = sandbox()
  const current = storage.defaultLocation(appData)
  seedLibrary(current, '初始内容')
  const target = join(appData, 'MyBooks')
  storage.setLocation(appData, target)
  storage.applyPending(appData)
  seedLibrary(target, '自定义位置新内容')

  const reset = storage.resetLocation(appData)
  expect(reset.unchanged).toBe(false)
  expect(storage.readLocation(appData).pending).toEqual({ from: target, to: current })

  const applied = storage.applyPending(appData)
  expect(applied.moved).toBe(true)
  expect(applied.current).toBe(current)
  expect(applied.custom).toBe(false)
  expect(markerAt(current)).toBe('自定义位置新内容')
  expect(storage.readLocation(appData).pending).toBe(null)
})

test('已是默认位置时，恢复默认不做任何搬运', () => {
  const appData = sandbox()
  const reset = storage.resetLocation(appData)
  expect(reset.unchanged).toBe(true)
  expect(storage.readLocation(appData).pending).toBe(null)
})

test('搬运时清理目标目录里的旧书库数据，避免新旧混合', () => {
  const appData = sandbox()
  const current = storage.defaultLocation(appData)
  seedLibrary(current, '最新内容')
  const target = join(appData, 'Reused')
  seedLibrary(target, '过期内容')
  storage.setLocation(appData, target)
  const applied = storage.applyPending(appData)
  expect(applied.moved).toBe(true)
  expect(markerAt(target)).toBe('最新内容')
})

test('配置损坏或待搬运目标非法时回退到原位置，不丢数据', () => {
  const appData = sandbox()
  const current = storage.defaultLocation(appData)
  seedLibrary(current, '保留内容')
  storage.writeLocation(appData, { current, pending: { from: current, to: current } })
  const applied = storage.applyPending(appData)
  expect(applied.moved).toBe(false)
  expect(applied.error).not.toBe(null)
  expect(applied.current).toBe(current)
  expect(markerAt(current)).toBe('保留内容')

  writeFileSync(storage.configFile(appData), '{ 坏配置')
  expect(storage.readLocation(appData).current).toBe(current)
})
