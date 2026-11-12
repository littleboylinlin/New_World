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
