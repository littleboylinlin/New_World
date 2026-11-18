import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './app-test.mjs'

const require = createRequire(import.meta.url)
const capture = require('../desktop/capture.cjs')
const t = (key) => `[${key}]`
const id = '0f8fad5b-d9cb-469f-a165-70867728950e'

test('灵感快捷键保存在配置文件里，坏文件和未知值回到默认', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-capture-'))
  try {
    expect(capture.readShortcut(root)).toBe('Control+Alt+N')
    for (const shortcut of ['Alt+Shift+N', 'Control+Shift+A', 'Control+Shift+Space', 'Shift+F1', 'Shift+F24']) {
      capture.writeShortcut(root, shortcut)
      expect(capture.readShortcut(root)).toBe(shortcut)
      expect(JSON.parse(await readFile(capture.configFile(root), 'utf8'))).toEqual({ shortcut })
    }
    capture.writeShortcut(root, 'off')
    expect(capture.readShortcut(root)).toBe('off')
    for (const invalid of ['A', '1', 'Tab', 'Space', 'Control', 'Alt+Alt+N', 'CtrlFake+N', 'Shift+A', 'Shift+1', 'Shift+Space', 'Shift+F0', 'Shift+F25']) {
      expect(() => capture.writeShortcut(root, invalid)).toThrow()
    }
    await writeFile(capture.configFile(root), '{"shortcut":"Shift+A"}')
    expect(capture.readShortcut(root)).toBe('Control+Alt+N')
    await writeFile(capture.configFile(root), 'not json')
    expect(capture.readShortcut(root)).toBe('Control+Alt+N')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('快捷键按平台显示', () => {
  expect(capture.shortcutLabel('Control+Alt+N', 'win32')).toBe('Ctrl + Alt + N')
  expect(capture.shortcutLabel('Control+Shift+Space', 'win32')).toBe('Ctrl + Shift + Space')
  expect(capture.shortcutLabel('Control+Alt+N', 'darwin')).toBe('⌃⌥N')
  expect(capture.shortcutLabel('Alt+Shift+N', 'darwin')).toBe('⌥⇧N')
  expect(capture.shortcutLabel('Shift+Command+F8', 'darwin')).toBe('⇧⌘F8')
  expect(capture.shortcutLabel('off', 'win32')).toBe('')
})

test('设置录制全局快捷键，单用 Shift 仅允许 F1–F24，冲突时保留旧设置', async ({ page }, testInfo) => {
  const path = testInfo.outputPath('capture-settings')
  const registered = new Set(['Alt+Shift+F9'])
  const attempts = []
  const changes = []
  const globalShortcut = {
    isRegistered: (shortcut) => registered.has(shortcut),
    register: (shortcut) => {
      attempts.push(shortcut)
      if (shortcut === 'Control+Shift+F9') return false
      registered.add(shortcut)
      return true
    },
    unregister: (shortcut) => registered.delete(shortcut),
  }
  let binding = capture.createShortcutRegistration(path, globalShortcut, () => {})
  binding.start()
  for (const invalid of ['Shift+A', 'Shift+1']) expect(binding.change(invalid)).toEqual({ ok: false, error: 'invalid' })
  await page.exposeFunction('getTestCaptureState', () => ({ ...binding.state(), label: capture.shortcutLabel(binding.state().shortcut, 'win32') }))
  await page.exposeFunction('setTestCaptureShortcut', (shortcut) => {
    changes.push(shortcut)
    const result = binding.change(shortcut)
    if (result.ok) result.state.label = capture.shortcutLabel(result.state.shortcut, 'win32')
    return result
  })
  await page.addInitScript(() => {
    window.newWorldDesktop = {
      platform: 'win32',
      onCloseRequested() {},
      onUpdateProgress() {},
      isMaximized: async () => false,
      onMaximizeChange() {},
      getCloseBehavior: async () => 'quit',
      getStorageLocation: async () => ({ path: 'C:\\书库', defaultPath: 'C:\\书库', custom: false }),
      getCaptureState: () => window.getTestCaptureState(),
      setCaptureShortcut: (shortcut) => window.setTestCaptureShortcut(shortcut),
    }
  })
  await page.goto('/#/settings/capture')
  const section = page.locator('.settings-panel[data-category="capture"]')
  const recorder = section.getByRole('button', { name: /^全局快捷键 / })
  const alert = section.getByRole('alert')
  await expect(recorder).toHaveText('Ctrl + Alt + N')
  await recorder.click()
  await expect(recorder).toHaveAttribute('aria-pressed', 'true')
  for (const key of ['n', '2', 'Tab', 'Space', 'Shift+A', 'Shift+1', 'Shift+Space']) {
    await page.keyboard.press(key)
    await expect(alert).toContainText('只用 Shift 时，请搭配 F1–F24。')
    await expect(recorder).toHaveAttribute('aria-pressed', 'true')
  }
  expect(changes).toEqual([])
  expect(attempts).toEqual(['Control+Alt+N'])
  await page.keyboard.press('Escape')
  await expect(recorder).toHaveText('Ctrl + Alt + N')

  await recorder.click()
  await page.keyboard.press('Shift+F8')
  await expect(recorder).toHaveText('Shift + F8')
  await expect(section.getByRole('status')).toHaveText('已保存')
  expect(capture.readShortcut(path)).toBe('Shift+F8')
  expect(registered.has('Control+Alt+N')).toBe(false)

  for (const chord of ['Alt+Shift+F9', 'Control+Shift+F9']) {
    await recorder.click()
    await page.keyboard.press(chord)
    await expect(alert).toHaveText('该组合键已被占用')
    await expect(recorder).toHaveText('Shift + F8')
    expect(capture.readShortcut(path)).toBe('Shift+F8')
    expect(registered.has('Shift+F8')).toBe(true)
  }
  expect(registered.has('Alt+Shift+F9')).toBe(true)
  expect(attempts).toEqual(['Control+Alt+N', 'Shift+F8', 'Control+Shift+F9'])

  registered.delete('Shift+F8')
  binding = capture.createShortcutRegistration(path, globalShortcut, () => {})
  binding.start()
  await page.reload()
  await expect(recorder).toHaveText('Shift + F8')
  await section.getByRole('button', { name: '关闭快捷键', exact: true }).click()
  await expect(recorder).toHaveText('已关闭')
  expect(registered.has('Shift+F8')).toBe(false)
  await section.getByRole('button', { name: '恢复默认', exact: true }).click()
  await expect(recorder).toHaveText('Ctrl + Alt + N')
  expect(capture.readShortcut(path)).toBe('Control+Alt+N')
  expect(registered.has('Control+Alt+N')).toBe(true)
})

test('全局快捷键保存失败时撤销新注册，旧快捷键仍可用', async ({}, testInfo) => {
  const path = testInfo.outputPath('capture-settings')
  capture.writeShortcut(path, 'Control+Shift+F8')
  await mkdir(`${capture.configFile(path)}.partial`)
  const registered = new Set()
  const binding = capture.createShortcutRegistration(path, {
    isRegistered: (shortcut) => registered.has(shortcut),
    register: (shortcut) => { registered.add(shortcut); return true },
    unregister: (shortcut) => registered.delete(shortcut),
  }, () => {})
  binding.start()
  expect(() => binding.change('Control+Shift+F9')).toThrow()
  expect([...registered]).toEqual(['Control+Shift+F8'])
  expect(binding.state().shortcut).toBe('Control+Shift+F8')
  expect(capture.readShortcut(path)).toBe('Control+Shift+F8')
})

test('页面报告的最近作品会被检查和截短', () => {
  expect(capture.recentWorks('nope')).toEqual([])
  const works = capture.recentWorks([
    { title: '雾钟', hash: `#/original/${id}` },
    { title: '', hash: `#/original/${id}` },
    { title: '外链', hash: 'https://example.com' },
    { title: '注入', hash: `#/original/${id}/../x` },
    { title: 'x'.repeat(200), hash: `#/reference/${id}` },
    ...Array.from({ length: 8 }, (_, index) => ({ title: `作品${index}`, hash: `#/original/${id}` })),
  ])
  expect(works).toHaveLength(5)
  expect(works[0]).toEqual({ title: '雾钟', hash: `#/original/${id}` })
  expect(works[1].title).toHaveLength(80)
})

test('托盘菜单列出速记、最近作品和备份，动作交回主进程', () => {
  const calls = []
  const options = {
    t, shortcut: 'Control+Alt+N',
    recent: [{ title: '雾钟', hash: `#/original/${id}` }],
    capture: () => calls.push('capture'),
    command: (value) => calls.push(value),
    showFolder: () => calls.push('folder'),
    settings: () => calls.push('settings'), show: () => calls.push('show'), quit: () => calls.push('quit'),
  }
  const menu = capture.trayTemplate(options)
  const labels = menu.filter((item) => item.label).map((item) => item.label)
  expect(labels[0]).toMatch(/^\[ideas\.capture\]\t/)
  expect(labels).toContain('[tray.recent]')
  expect(labels).toContain('[backup.now]')
  menu[0].click()
  menu.find((item) => item.label === '[shelf.newNovel]').click()
  menu.find((item) => item.label === '[tray.recent]').submenu[0].click()
  menu.find((item) => item.label === '[ideas.title]').click()
  menu.find((item) => item.label === '[backup.now]').click()
  expect(calls).toEqual(['capture', { type: 'new-novel' }, { type: 'open', hash: `#/original/${id}` }, { type: 'ideas' }, { type: 'backup' }])

  const empty = capture.trayTemplate({ ...options, recent: [], shortcut: 'off' })
  expect(empty[0].label).toBe('[ideas.capture]')
  expect(empty.find((item) => item.label === '[tray.recent]').submenu).toEqual([{ label: '[tray.noRecent]', enabled: false }])
})

test('右键菜单：拼写建议、编辑、选中文字存为灵感', () => {
  const flags = { canCut: true, canCopy: true, canPaste: true }
  const saved = []
  const actions = { t, replace() {}, learn() {}, saveIdea: (text) => saved.push(text) }
  expect(capture.contextTemplate({ selectionText: '', isEditable: false, editFlags: flags, dictionarySuggestions: [] }, actions)).toBeNull()

  const plain = capture.contextTemplate({ selectionText: '  雾里的钟  ', isEditable: false, editFlags: flags, dictionarySuggestions: [] }, actions)
  expect(plain.map((item) => item.label ?? item.type)).toEqual(['[main.copy]', 'separator', '[ideas.saveSelection]'])
  plain.at(-1).click()
  expect(saved).toEqual(['雾里的钟'])

  const typo = capture.contextTemplate({ misspelledWord: 'teh', selectionText: 'teh', isEditable: true, editFlags: flags, dictionarySuggestions: ['the', 'ten'] }, actions)
  expect(typo.map((item) => item.label ?? item.type)).toEqual([
    'the', 'ten', '[spelling.addToDictionary]', 'separator',
    '[main.cut]', '[main.copy]', '[main.paste]', '[common.selectAll]', 'separator', '[ideas.saveSelection]',
  ])
  // The capture window has no "save as note" of its own.
  const inCapture = capture.contextTemplate({ selectionText: 'x', isEditable: true, editFlags: flags, dictionarySuggestions: [] }, { ...actions, saveIdea: undefined })
  expect(inCapture.map((item) => item.label ?? item.type)).toEqual(['[main.cut]', '[main.copy]', '[main.paste]', '[common.selectAll]'])
})
