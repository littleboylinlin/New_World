import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const require = createRequire(import.meta.url)
const capture = require('../desktop/capture.cjs')
const t = (key) => `[${key}]`
const id = '0f8fad5b-d9cb-469f-a165-70867728950e'

test('灵感快捷键保存在配置文件里，坏文件和未知值回到默认', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nw-capture-'))
  try {
    expect(capture.readShortcut(root)).toBe('Control+Alt+N')
    capture.writeShortcut(root, 'Alt+Shift+N')
    expect(capture.readShortcut(root)).toBe('Alt+Shift+N')
    expect(JSON.parse(await readFile(capture.configFile(root), 'utf8'))).toEqual({ shortcut: 'Alt+Shift+N' })
    capture.writeShortcut(root, 'off')
    expect(capture.readShortcut(root)).toBe('off')
    expect(() => capture.writeShortcut(root, 'Control+Q')).toThrow()
    await writeFile(capture.configFile(root), '{"shortcut":"Control+Q"}')
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
  expect(capture.shortcutLabel('off', 'win32')).toBe('')
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
