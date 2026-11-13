import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const require = createRequire(import.meta.url)
const spelling = require('../desktop/spelling.cjs')

const dirs = []
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'nw-spelling-'))
  dirs.push(dir)
  return dir
}

test.afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('随应用附带美式和英式英语词典，复制到配置目录且不覆盖已有文件', () => {
  const bundled = readdirSync('desktop/dictionaries').filter((name) => name.endsWith('.bdic')).sort()
  expect(bundled).toEqual(['en-GB-10-2.bdic', 'en-US-10-2.bdic'])
  expect(spelling.languages).toEqual(['en-US', 'en-GB'])

  const profile = sandbox()
  expect(spelling.installDictionaries(profile).sort()).toEqual(bundled)
  const target = join(profile, 'Dictionaries')
  expect(readdirSync(target).sort()).toEqual(bundled)
  expect(readFileSync(join(target, 'en-US-10-2.bdic')).equals(readFileSync('desktop/dictionaries/en-US-10-2.bdic'))).toBe(true)

  writeFileSync(join(target, 'en-GB-10-2.bdic'), 'kept')
  expect(spelling.installDictionaries(profile)).toEqual([])
  expect(readFileSync(join(target, 'en-GB-10-2.bdic'), 'utf8')).toBe('kept')
})

test('只有拼错的单词才有右键菜单，列出建议并可加入词典', () => {
  const actions = []
  const handlers = { replace: (word) => actions.push(['replace', word]), learn: (word) => actions.push(['learn', word]), t: (key) => key }
  expect(spelling.menuTemplate({ misspelledWord: '', dictionarySuggestions: [] }, handlers)).toBeNull()

  const menu = spelling.menuTemplate({ misspelledWord: 'Teh', dictionarySuggestions: ['The', 'Tech', 'Ten'] }, handlers)
  expect(menu.map((item) => item.label ?? item.type)).toEqual(['The', 'Tech', 'Ten', 'separator', 'spelling.addToDictionary'])
  menu[0].click()
  menu.at(-1).click()
  expect(actions).toEqual([['replace', 'The'], ['learn', 'Teh']])

  const empty = spelling.menuTemplate({ misspelledWord: 'Xqzt', dictionarySuggestions: [] }, handlers)
  expect(empty[0]).toEqual({ label: 'spelling.noSuggestions', enabled: false })
})

test('自带词典之外，可添加文件名与 Chromium 一致的 .bdic 词典，并能移除', () => {
  const profile = sandbox()
  const english = readFileSync('desktop/dictionaries/en-US-10-2.bdic')
  expect(() => spelling.addDictionary(profile, 'french.bdic', english)).toThrow(expect.objectContaining({ code: 'name' }))
  expect(() => spelling.addDictionary(profile, 'en-US-10-2.bdic', english)).toThrow(expect.objectContaining({ code: 'bundled' }))
  expect(() => spelling.addDictionary(profile, 'fr-FR-3-0.bdic', Buffer.from('not a dictionary at all'))).toThrow(expect.objectContaining({ code: 'format' }))
  expect(() => spelling.addDictionary(profile, 'fr-FR-3-0.bdic', Buffer.alloc(spelling.maxBytes + 1))).toThrow(expect.objectContaining({ code: 'size' }))

  // Chromium's download server uses lower case names; the file is saved under the name Chromium loads.
  expect(spelling.addDictionary(profile, 'fr-fr-3-0.bdic', english)).toBe('fr-FR')
  expect(spelling.addDictionary(profile, 'af-ZA-3-0.bdic', english)).toBe('af-ZA')
  expect(readdirSync(join(profile, 'Dictionaries')).sort()).toEqual(['af-ZA-3-0.bdic', 'fr-FR-3-0.bdic'])
  expect(spelling.addedLanguages(profile)).toEqual(['af-ZA', 'fr-FR'])
  const available = ['af', 'en-GB', 'en-US', 'fr', 'fr-FR']
  expect(spelling.activeLanguages(profile, available)).toEqual(['en-US', 'en-GB', 'af', 'fr-FR'])

  // A newer file for the same language replaces the older one.
  mkdirSync(join(profile, 'Dictionaries'), { recursive: true })
  expect(spelling.addDictionary(profile, 'uk-UA-4-0.bdic', english)).toBe('uk-UA')
  expect(spelling.addDictionary(profile, 'uk-UA-5-0.bdic', english)).toBe('uk-UA')
  expect(readdirSync(join(profile, 'Dictionaries')).filter((name) => name.startsWith('uk-UA'))).toEqual(['uk-UA-5-0.bdic'])

  spelling.removeDictionary(profile, 'fr-FR')
  expect(spelling.addedLanguages(profile)).toEqual(['af-ZA', 'uk-UA'])
  expect(spelling.deletePendingRemovals(profile)).toEqual([])
  expect(readdirSync(join(profile, 'Dictionaries')).sort()).toEqual(['af-ZA-3-0.bdic', 'uk-UA-5-0.bdic'])
  expect(() => spelling.removeDictionary(profile, 'en-US')).toThrow(expect.objectContaining({ code: 'bundled' }))
})

test('下载链接只接受 https，且文件名要能对应到词典语言', () => {
  expect(spelling.downloadName('https://redirector.gvt1.com/edgedl/chrome/dict/fr-fr-3-0.bdic'))
    .toEqual({ url: 'https://redirector.gvt1.com/edgedl/chrome/dict/fr-fr-3-0.bdic', name: 'fr-fr-3-0.bdic' })
  expect(spelling.downloadName('https://example.com/dicts/de-DE-3-0.bdic?x=1').name).toBe('de-DE-3-0.bdic')
  for (const [link, code] of [
    ['http://example.com/fr-FR-3-0.bdic', 'link'], ['https://user:pass@example.com/fr-FR-3-0.bdic', 'link'],
    ['not a link', 'link'], ['https://example.com/french.bdic', 'name'], ['https://example.com/', 'name'],
  ]) expect(() => spelling.downloadName(link)).toThrow(expect.objectContaining({ code }))
})

test('仍被占用而没删掉的词典不再使用，下次启动时删除', () => {
  const profile = sandbox()
  const english = readFileSync('desktop/dictionaries/en-US-10-2.bdic')
  spelling.addDictionary(profile, 'fr-FR-3-0.bdic', english)
  // As if Windows had refused to delete the open file.
  writeFileSync(join(profile, 'Dictionaries', '.removed.json'), '["fr-FR"]\n')
  expect(spelling.addedLanguages(profile)).toEqual([])
  expect(spelling.activeLanguages(profile, ['en-US', 'en-GB', 'fr-FR'])).toEqual(['en-US', 'en-GB'])

  spelling.installDictionaries(profile)
  expect(readdirSync(join(profile, 'Dictionaries')).sort()).toEqual(['en-GB-10-2.bdic', 'en-US-10-2.bdic'])

  // Adding the language again takes it off the list.
  writeFileSync(join(profile, 'Dictionaries', '.removed.json'), '["fr-FR"]\n')
  expect(spelling.addDictionary(profile, 'fr-FR-3-0.bdic', english)).toBe('fr-FR')
  expect(spelling.addedLanguages(profile)).toEqual(['fr-FR'])
})
