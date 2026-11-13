import { createRequire } from 'node:module'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const require = createRequire(import.meta.url)
const backups = require('../desktop/backup.cjs')

const dirs = []
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'nw-backup-'))
  dirs.push(dir)
  return dir
}

test.afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('备份设置默认每天自动备份到「文稿」下的文件夹，损坏的设置回到默认', () => {
  const appData = sandbox()
  const config = backups.readConfig(appData)
  expect(config).toEqual({ frequency: 'daily', folder: null, encrypt: false, password: null, lastAutomatic: null })
  expect(backups.folderOf(config, 'C:/Users/Elah/Documents')).toBe(join('C:/Users/Elah/Documents', 'New World Backups'))
  backups.writeConfig(appData, { ...config, frequency: 'weekly', folder: '/books/backups', lastAutomatic: 5 })
  expect(backups.readConfig(appData)).toMatchObject({ frequency: 'weekly', folder: '/books/backups', lastAutomatic: 5 })
  // Encryption without a saved password is treated as off.
  writeFileSync(backups.configFile(appData), '{"frequency":"hourly","encrypt":true}')
  expect(backups.readConfig(appData)).toMatchObject({ frequency: 'daily', encrypt: false })
  writeFileSync(backups.configFile(appData), 'not json')
  expect(backups.readConfig(appData).frequency).toBe('daily')
})

test('按频率判断是否该自动备份', () => {
  const day = 24 * 60 * 60 * 1000
  const now = 100 * day
  expect(backups.due({ frequency: 'off', lastAutomatic: null }, now)).toBe(false)
  expect(backups.due({ frequency: 'daily', lastAutomatic: null }, now)).toBe(true)
  expect(backups.due({ frequency: 'daily', lastAutomatic: now - day + 1 }, now)).toBe(false)
  expect(backups.due({ frequency: 'daily', lastAutomatic: now - day }, now)).toBe(true)
  expect(backups.due({ frequency: 'weekly', lastAutomatic: now - 6 * day }, now)).toBe(false)
  expect(backups.due({ frequency: 'weekly', lastAutomatic: now - 7 * day }, now)).toBe(true)
})

test('只写入规范命名的备份，自动备份只保留最新的几份，手动备份不删', () => {
  const folder = join(sandbox(), 'nested', 'backups')
  expect(() => backups.saveBackup(folder, '../evil.zip', Buffer.from('x'))).toThrow()
  expect(() => backups.saveBackup(folder, 'notes.txt', Buffer.from('x'))).toThrow()
  const manual = backups.saveBackup(folder, 'New-World-backup-2026-11-13-114000.zip', Buffer.from('PK'))
  expect(readFileSync(manual, 'utf8')).toBe('PK')
  backups.saveBackup(folder, 'New-World-before-restore-2026-11-13-114500.zip', Buffer.from('PK'))
  for (let day = 1; day <= 12; day++) {
    backups.saveBackup(folder, `New-World-auto-backup-2026-11-${String(day).padStart(2, '0')}-090000.zip`, Buffer.from('PK'))
  }
  expect(backups.pruneAutomatic(folder)).toEqual(['New-World-auto-backup-2026-11-02-090000.zip', 'New-World-auto-backup-2026-11-01-090000.zip'])
  const left = readdirSync(folder)
  expect(left.filter((name) => name.startsWith('New-World-auto-backup-'))).toHaveLength(backups.keepAutomatic)
  expect(left).toContain('New-World-backup-2026-11-13-114000.zip')
  expect(left).toContain('New-World-before-restore-2026-11-13-114500.zip')
  expect(left.some((name) => name.endsWith('.partial'))).toBe(false)
})
