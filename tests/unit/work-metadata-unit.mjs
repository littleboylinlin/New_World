import test from 'node:test'
import assert from 'node:assert/strict'
import { MetadataError, metadataLimits, validateWorkMetadata } from '../../src/work-metadata.ts'

test('known optional fields and inert future fields validate without defaults, changes or coercion', () => {
  for (const metadata of [{}, { author: '', synopsis: '', subtitle: '', tags: [], status: '' },
    { author: '笔名 <自由填写>', synopsis: '第一段\r\n\r\n第二段\n末行', subtitle: '副标题', tags: ['奇幻', '科幻, 悬疑'], status: 'future-state',
      extensions: { 'org.example.series': { id: 'literal-not-a-reference', bookId: 'keep', active: true, order: 3, empty: null, values: ['汉字', false] } } }]) {
    const before = structuredClone(metadata)
    validateWorkMetadata(metadata)
    assert.deepEqual(metadata, before)
  }
})

test('metadata rejects wrong known-field types, dangerous keys, binary/class values and unsupported JSON', () => {
  const cases = [null, [], 'text', { author: [] }, { synopsis: {} }, { tags: ['x','x'] }, { tags: [''] }, { tags: [' x '] }, { status: 1 },
    { author: 'two\nlines' }, { synopsis: '\0' }, { author: undefined }, { unknown: NaN }, { unknown: Infinity }, { unknown: 1n }, { unknown: Symbol('x') },
    { unknown: new Date() }, { unknown: new Map() }, { unknown: new Set() }, { unknown: new Uint8Array([1]) }, { unknown: new Blob(['x']) },
    { unknown: () => 1 }, { unknown: new Array(1) }, { unknown: Object.assign([1], { extra: 2 }) }, JSON.parse('{"future":{"__proto__":{"x":1}}}'),
    { future: { constructor: 'x' } }, { future: { prototype: 'x' } }, { future: { $resource: 'assets/evil.bin' } }]
  for (const metadata of cases) assert.throws(() => validateWorkMetadata(metadata), MetadataError)
  let called = false
  const object = { get future() { called = true; throw new Error('must not run') } }
  assert.throws(() => validateWorkMetadata(object), MetadataError); assert.equal(called, false)
  const array = [1]; Object.defineProperty(array, '0', { get() { called = true; return 1 } })
  assert.throws(() => validateWorkMetadata({ array }), MetadataError); assert.equal(called, false)
  const symbols = [1]; symbols[Symbol('extra')] = 2
  assert.throws(() => validateWorkMetadata({ symbols }), MetadataError)
})

test('metadata enforces per-field, UTF-8 byte, node, array and depth budgets', () => {
  let nested = { value: 'end' }; for (let i = 0; i < 14; i++) nested = { nested }
  for (const metadata of [{ author: 'x'.repeat(256) }, { synopsis: 'x'.repeat(metadataLimits.text + 1) }, { tags: Array.from({ length: 51 }, (_, i) => String(i)) },
    { status: 'x'.repeat(65) }, { extension: '汉'.repeat(44000) }, { array: Array(257).fill(0) }, nested,
    { tree: Array.from({ length: 20 }, () => Array(250).fill(0)) }]) assert.throws(() => validateWorkMetadata(metadata), MetadataError)
})
