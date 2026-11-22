import test from 'node:test'
import assert from 'node:assert/strict'
import { isLargeChange, largeChangeChars, replacedLength } from '../../src/documents/change-size.ts'

const chapter = '雾从海面上漫过来的时候，林栖正把最后一盏灯点亮。'.repeat(40)

test('replacedLength measures the span of the old text between the first and last difference', () => {
  assert.equal(replacedLength('abcdef', 'abcdef'), 0)
  assert.equal(replacedLength('abcdef', 'abXYef'), 2)
  assert.equal(replacedLength('abcdef', 'abef'), 2)
  assert.equal(replacedLength('abcdef', 'abcdefghi'), 0)
  assert.equal(replacedLength('aaaa', 'aa'), 2)
  assert.equal(replacedLength('', 'new text'), 0)
})

test('typing, small edits and additions are not large changes', () => {
  assert.equal(isLargeChange(chapter, chapter + '她回头看了一眼。'), false)
  assert.equal(isLargeChange(chapter, chapter.slice(0, 100) + '改' + chapter.slice(101)), false)
  assert.equal(isLargeChange(chapter, chapter.slice(0, 300) + '新'.repeat(5000) + chapter.slice(300)), false)
})

test('select-all replace, large deletions and pasting over much of a chapter are large changes', () => {
  assert.equal(isLargeChange(chapter, '另一章的内容'), true)
  assert.equal(isLargeChange(chapter, ''), true)
  assert.equal(isLargeChange(chapter, chapter.slice(0, chapter.length / 2)), true)
  assert.equal(isLargeChange(chapter, '粘'.repeat(chapter.length)), true)
})

test('short chapters need a large enough change, and big chapters a large enough share', () => {
  const short = '短'.repeat(150)
  assert.equal(isLargeChange(short, ''), false)
  const exact = '字'.repeat(largeChangeChars)
  assert.equal(isLargeChange(exact, ''), true)
  const long = '长'.repeat(10000)
  assert.equal(isLargeChange(long, long.slice(500)), false)
  assert.equal(isLargeChange(long, long.slice(3000)), true)
})
