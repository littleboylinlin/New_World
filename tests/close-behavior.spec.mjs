import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const require = createRequire(import.meta.url)
const behavior = require('../desktop/close-behavior.cjs')

const dirs = []

function sandbox() {
  const appData = mkdtempSync(join(tmpdir(), 'nw-behavior-'))
  dirs.push(appData)
  return appData
}

test.afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('没有配置时默认完全退出，且不产生配置文件', () => {
  const appData = sandbox()
  expect(behavior.readBehavior(appData)).toBe('quit')
  expect(existsSync(behavior.configFile(appData))).toBe(false)
})

test('保存关闭方式后可以重新读取', () => {
  const appData = sandbox()
  behavior.writeBehavior(appData, 'background')
  expect(behavior.readBehavior(appData)).toBe('background')
  expect(JSON.parse(readFileSync(behavior.configFile(appData), 'utf8'))).toEqual({ closeBehavior: 'background' })
  behavior.writeBehavior(appData, 'quit')
  expect(behavior.readBehavior(appData)).toBe('quit')
})

test('拒绝无效值，且不改动已有设置', () => {
  const appData = sandbox()
  behavior.writeBehavior(appData, 'background')
  for (const value of ['', 'minimize', null, 1, {}, undefined]) {
    expect(() => behavior.writeBehavior(appData, value)).toThrow()
  }
  expect(behavior.readBehavior(appData)).toBe('background')
  expect(behavior.isMode('quit')).toBe(true)
  expect(behavior.isMode('background')).toBe(true)
  expect(behavior.isMode('other')).toBe(false)
  expect(behavior.modes).toEqual(['quit', 'background'])
})

test('配置损坏或含无效值时回退到完全退出', () => {
  const appData = sandbox()
  const file = behavior.configFile(appData)
  writeFileSync(file, '{ 坏配置')
  expect(behavior.readBehavior(appData)).toBe('quit')
  writeFileSync(file, JSON.stringify({ closeBehavior: 'minimize' }))
  expect(behavior.readBehavior(appData)).toBe('quit')
  writeFileSync(file, JSON.stringify(null))
  expect(behavior.readBehavior(appData)).toBe('quit')
  writeFileSync(file, JSON.stringify({ closeBehavior: 'background', extra: 1 }))
  expect(behavior.readBehavior(appData)).toBe('background')
})

test('只有留后台且非强制退出时才隐藏窗口', () => {
  expect(behavior.closeAction('quit')).toBe('quit')
  expect(behavior.closeAction('background')).toBe('background')
  expect(behavior.closeAction('background', { forceQuit: true })).toBe('quit')
  expect(behavior.closeAction('quit', { forceQuit: true })).toBe('quit')
  expect(behavior.closeAction('invalid')).toBe('quit')
})
