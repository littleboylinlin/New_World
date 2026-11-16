import test from 'node:test'
import assert from 'node:assert/strict'
import { anchorMatches, annotationSegments, markAttributes, popupPosition, sourceHash, validAnnotations, validColor } from '../../src/annotations/model.ts'

const annotation = (id, from, to) => ({ id, anchor: { from, to }, color: '#123abc', createdAt: 0 })

test('overlaps preserve every owner, including nested and adjacent annotations', () => {
  const items = [annotation('b', 3, 10), annotation('a', 0, 6), annotation('c', 4, 5), annotation('d', 10, 11)]
  assert.deepEqual(annotationSegments(items).map(({ from, to, items }) => [from, to, items.map(({ id }) => id)]), [
    [0, 3, ['a']], [3, 4, ['a', 'b']], [4, 5, ['a', 'b', 'c']], [5, 6, ['a', 'b']], [6, 10, ['b']], [10, 11, ['d']],
  ])
})

test('anchors require fingerprint, exact position, kind, bounds and quote; never search for repeated strings', async () => {
  const text = '重复。\nEnglish! 重复。🙂'
  const hash = await sourceHash(text)
  const from = text.lastIndexOf('重复。')
  const anchor = { version: 1, kind: 'text', from, to: from + 3, quote: '重复。', sourceHash: hash }
  const matches = (value, digest = hash) => anchorMatches(value, digest, 'text', text.length, (from, to) => text.slice(from, to))
  assert.equal(matches(anchor), true)
  assert.equal(matches(anchor, await sourceHash('新增。' + text)), false)
  for (const change of [{ from: 0, to: 3.5 }, { to: text.length + 1 }, { from: -1 }, { kind: 'document' }, { quote: '其他' }, { version: 2 }]) {
    assert.equal(matches({ ...anchor, ...change }), false)
  }
})

test('color styles reject CSS injection and keep all overlap colors without overriding text color', () => {
  assert.equal(validColor('#aAbB00'), true)
  assert.equal(validColor('red; color:white'), false)
  const style = markAttributes([{ ...annotation('a', 0, 2), color: 'red; color:white' }, annotation('b', 1, 3)]).style
  assert.match(style, /linear-gradient/)
  assert.doesNotMatch(style, /color:white/)
  assert.match(style, /#123abc/)
})

test('floating elements fit both sides and small/zoomed viewports', () => {
  for (const view of [{ left: 0, top: 0, width: 390, height: 844 }, { left: 80, top: 150, width: 220, height: 280 }]) {
    const width = Math.min(360, view.width - 20), height = Math.min(300, view.height - 20)
    for (const anchor of [{ left: -200, top: -300, right: -100, bottom: -250 }, { left: 999, top: 999, right: 1009, bottom: 1019 }, { left: 180, top: 300, right: 200, bottom: 330 }]) {
      const p = popupPosition(anchor, width, height, view)
      assert.ok(p.left >= view.left + 10 && p.top >= view.top + 10)
      assert.ok(p.left + width <= view.left + view.width - 10 && p.top + height <= view.top + view.height - 10)
    }
  }
})


test('optional metadata validates before rendering or saving, including backup corruption', async () => {
  const item = {
    id: crypto.randomUUID(), text: '批注', color: '#123abc', display: 'mark', collapsed: false, createdAt: 1,
    anchor: { version: 1, kind: 'text', from: 0, to: 2, quote: '原文', sourceHash: await sourceHash('原文') },
  }
  assert.equal(validAnnotations({ revision: 0, items: [] }), true)
  assert.equal(validAnnotations({ revision: 1, items: [item] }), true)
  for (const value of [null, {}, { revision: 1, items: [null] }, { revision: -1, items: [item] },
    { revision: 0, items: [item, item] }, { revision: 0, items: [{ ...item, id: 'invalid id' }] },
    { revision: 0, items: [{ ...item, text: ' '.repeat(3) }] },
    { revision: 0, items: [{ ...item, anchor: { ...item.anchor, from: NaN } }] }]) {
    assert.equal(validAnnotations(value), false)
  }
})
