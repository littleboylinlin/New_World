import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { diffText, splitAtBoundaries, tokenize } from '../../src/ai/text-diff.ts'

const applyAll = (text, hunks) => [...hunks].sort((a, b) => b.from - a.from)
  .reduce((value, hunk) => value.slice(0, hunk.from) + hunk.insert + value.slice(hunk.to), text)

describe('AI 文本 diff', () => {
  it('中文按字、英文按词切分', () => {
    assert.deepEqual(tokenize('他说：hello world。'), ['他', '说', '：', 'hello', ' ', 'world', '。'])
  })

  it('只标出改动的位置，逐处套用后得到新文本', () => {
    const before = '他慢慢的走进房间，看见桌子上放着一封信。'
    const after = '他慢慢地走进房间，看见桌上放着一封旧信。'
    const hunks = diffText(before, after)
    assert.equal(applyAll(before, hunks), after)
    assert.equal(hunks.length, 3)
    assert.deepEqual(hunks.map((hunk) => before.slice(hunk.from, hunk.to)), ['的', '子', ''])
  })

  it('拒绝其中一处时其他处仍可单独套用', () => {
    const before = 'The quick brown fox jumps over the lazy dog.'
    const after = 'The swift brown fox leaps over the lazy dog.'
    const hunks = diffText(before, after)
    assert.equal(hunks.length, 2)
    assert.equal(applyAll(before, [hunks[1]]), 'The quick brown fox leaps over the lazy dog.')
  })

  it('完全相同时没有改动；完全不同也能还原', () => {
    assert.deepEqual(diffText('一样', '一样'), [])
    assert.equal(applyAll('甲乙丙', diffText('甲乙丙', '丁戊')), '丁戊')
    assert.equal(applyAll('', diffText('', '新的')), '新的')
  })

  it('一处修改跨格式分界时在分界处拆开，插入的字跟着它前面的原字', () => {
    // 「天很蓝」加粗，「今天」普通：边界在 2。
    const before = '今天天很蓝'
    const hunk = { from: 1, to: 4, insert: '日天空很' }
    const pieces = splitAtBoundaries(before, hunk, [2])
    assert.equal(pieces.length, 2)
    assert.ok(pieces.every((piece) => piece.from >= 2 || piece.to <= 2))
    assert.equal(applyAll(before, pieces), '今日天空很蓝')
  })

  it('相隔一个字的两处修改不跨格式分界合并', () => {
    const before = '今天天很蓝'
    const after = '今日天空很蓝'
    assert.equal(diffText(before, after).length, 1)
    const hunks = diffText(before, after, { boundaries: [2] })
    assert.equal(hunks.length, 2)
    assert.ok(hunks.every((hunk) => !(hunk.from < 2 && hunk.to > 2)))
    assert.equal(applyAll(before, hunks), after)
  })

  it('分界不在改动范围内时保持原样', () => {
    const hunk = { from: 3, to: 5, insert: 'xy' }
    assert.deepEqual(splitAtBoundaries('abcdefg', hunk, [1, 6]), [hunk])
  })
})
