import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  expect(config).toEqual({
    frequency: 'daily', folder: null, encrypt: false, password: null, lastAutomatic: null,
    retention: { 'auto-backup': 10, 'before-restore': 10 },
  })
  expect(backups.folderOf(config, 'C:/Users/Elah/Documents')).toBe(join('C:/Users/Elah/Documents', 'New World Backups'))
  backups.writeConfig(appData, { ...config, frequency: 'weekly', folder: '/books/backups', lastAutomatic: 5 })
  expect(backups.readConfig(appData)).toMatchObject({ frequency: 'weekly', folder: '/books/backups', lastAutomatic: 5 })
  // Encryption without a saved password is treated as off.
  writeFileSync(backups.configFile(appData), '{"frequency":"hourly","encrypt":true,"retention":{"auto-backup":0,"before-restore":null}}')
  expect(backups.readConfig(appData)).toMatchObject({ frequency: 'daily', encrypt: false, retention: { 'auto-backup': 10, 'before-restore': null } })
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

const backupFile = (kind, day) => `New-World-${kind}-2026-11-${String(day).padStart(2, '0')}-090000.zip`

test('只写入规范命名的备份，确认清理只删除同类且最旧的普通备份文件', () => {
  const folder = join(sandbox(), 'nested', 'backups')
  expect(() => backups.saveBackup(folder, '../evil.zip', Buffer.from('x'))).toThrow()
  expect(() => backups.saveBackup(folder, 'notes.txt', Buffer.from('x'))).toThrow()
  const manual = backups.saveBackup(folder, 'New-World-backup-2026-11-13-114000.zip', Buffer.from('PK'))
  expect(readFileSync(manual, 'utf8')).toBe('PK')
  backups.saveBackup(folder, 'New-World-before-restore-2026-11-13-114500.zip', Buffer.from('PK'))
  for (let day = 1; day <= 12; day++) {
    backups.saveBackup(folder, backupFile('auto-backup', day), Buffer.from('PK'))
  }
  mkdirSync(join(folder, backupFile('auto-backup', 14)))
  writeFileSync(join(folder, 'notes.zip'), 'notes')
  writeFileSync(join(folder, 'New-World-auto-backup-2026-99-99-999999.zip'), 'notes')
  const plan = backups.retentionPlan(folder, 'auto-backup', 10)
  expect(plan.files).toEqual([1, 2].map((day) => backupFile('auto-backup', day)))
  expect(backups.pruneConfirmed(folder, 'auto-backup', 10, 'invalid')).toBe(false)
  expect(readdirSync(folder)).toContain(backupFile('auto-backup', 1))
  expect(backups.pruneConfirmed(folder, 'auto-backup', 10, plan.token)).toBe(true)
  const left = readdirSync(folder)
  expect(backups.excessBackups(folder, 'auto-backup', 10)).toEqual([])
  expect(left).toContain('New-World-backup-2026-11-13-114000.zip')
  expect(left).toContain('New-World-before-restore-2026-11-13-114500.zip')
  expect(left).toContain(backupFile('auto-backup', 14))
  expect(left).toContain('notes.zip')
  expect(left).toContain('New-World-auto-backup-2026-99-99-999999.zip')
  expect(left.some((name) => name.endsWith('.partial'))).toBe(false)
})

for (const limit of [5, 10, 20, null]) test(`自动备份和恢复前备份各自保留最新的 ${limit ?? '全部'} 份`, () => {
  const folder = sandbox()
  const retention = { 'auto-backup': limit, 'before-restore': limit }
  for (let day = 1; day <= 22; day++) {
    for (const kind of ['auto-backup', 'before-restore', 'backup']) {
      backups.saveBackup(folder, backupFile(kind, day), Buffer.from('PK'), retention)
    }
  }
  const files = readdirSync(folder).sort()
  for (const kind of ['auto-backup', 'before-restore', 'backup']) {
    const keep = kind === 'backup' ? 22 : limit ?? 22
    expect(files.filter((name) => backups.backupKind(name) === kind))
      .toEqual(Array.from({ length: keep }, (_, index) => backupFile(kind, 23 - keep + index)))
  }
})

test('升级遗留的超额备份等手动确认，过期清单不能删除新文件', () => {
  const folder = sandbox()
  const kind = 'before-restore'
  for (let day = 1; day <= 11; day++) backups.saveBackup(folder, backupFile(kind, day), Buffer.from('PK'))
  const old = backups.retentionPlan(folder, kind, 10)
  expect(old.files).toEqual([backupFile(kind, 1)])
  backups.saveBackup(folder, backupFile(kind, 12), Buffer.from('PK'), { [kind]: 10 })
  expect(readdirSync(folder)).toHaveLength(12)
  expect(backups.pruneConfirmed(folder, kind, 10, old.token)).toBe(false)
  const now = backups.retentionPlan(folder, kind, 10)
  expect(now.files).toEqual([1, 2].map((day) => backupFile(kind, day)))
  expect(backups.pruneConfirmed(folder, kind, 10, now.token)).toBe(true)
  expect(readdirSync(folder)).toHaveLength(10)
})
