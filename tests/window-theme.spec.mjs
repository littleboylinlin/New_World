import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const require = createRequire(import.meta.url)
const windowTheme = require('../desktop/window-theme.cjs')

const dirs = []

function sandbox() {
  const appData = mkdtempSync(join(tmpdir(), 'nw-theme-'))
  dirs.push(appData)
  return appData
}

test.afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('没有记录时窗口跟随系统，且不产生配置文件', () => {
  const appData = sandbox()
  expect(windowTheme.readTheme(appData)).toBe('system')
  expect(existsSync(windowTheme.configFile(appData))).toBe(false)
})

test('记住主题，损坏或未知的记录回到跟随系统', () => {
  const appData = sandbox()
  windowTheme.writeTheme(appData, 'dark')
  expect(windowTheme.readTheme(appData)).toBe('dark')
  expect(() => windowTheme.writeTheme(appData, 'neon')).toThrow()
  expect(windowTheme.readTheme(appData)).toBe('dark')
  writeFileSync(windowTheme.configFile(appData), '{"theme":"neon"}')
  expect(windowTheme.readTheme(appData)).toBe('system')
  writeFileSync(windowTheme.configFile(appData), 'not json')
  expect(windowTheme.readTheme(appData)).toBe('system')
})

test('窗口底色与页面底色一致，跟随系统时按系统深浅色选择', () => {
  expect(windowTheme.backgroundColor('white', true)).toBe('#f4eee2')
  expect(windowTheme.backgroundColor('dark', false)).toBe('#131210')
  expect(windowTheme.backgroundColor('beige', true)).toBe('#ebdfc5')
  expect(windowTheme.backgroundColor('system', true)).toBe('#131210')
  expect(windowTheme.backgroundColor('system', false)).toBe('#f4eee2')
  expect(windowTheme.themeSource('dark')).toBe('dark')
  expect(windowTheme.themeSource('beige')).toBe('light')
  expect(windowTheme.themeSource('system')).toBe('system')
})
