import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { computeLayout, fits, insertPane, moveDivider, paneIds, readTree, removePane, sideAt } from '../../src/shell/split-tree.ts'

const require = createRequire(import.meta.url)
const { isReadingRoute } = require('../../desktop/ipc-guard.cjs')

const rect = (layout, id) => {
  const value = layout.panes.get(id)
  return [value.left, value.top, value.width, value.height]
}

describe('分块布局树', () => {
  it('在一个块旁放下新块时平分它的空间，四个方向都对', () => {
    const one = { pane: 'main' }
    assert.deepEqual(rect(computeLayout(insertPane(one, 'r', { target: 'main', side: 'right' }), 1000, 800), 'r'), [500, 0, 500, 800])
    assert.deepEqual(rect(computeLayout(insertPane(one, 'l', { target: 'main', side: 'left' }), 1000, 800), 'l'), [0, 0, 500, 800])
    assert.deepEqual(rect(computeLayout(insertPane(one, 't', { target: 'main', side: 'top' }), 1000, 800), 't'), [0, 0, 1000, 400])
    assert.deepEqual(rect(computeLayout(insertPane(one, 'b', { target: 'main', side: 'bottom' }), 1000, 800), 'b'), [0, 400, 1000, 400])
  })

  it('右半块再分出下方成为右下四分之一；沿整个区域的边放下占满那一边', () => {
    let tree = insertPane({ pane: 'main' }, 'r', { target: 'main', side: 'right' })
    tree = insertPane(tree, 'q', { target: 'r', side: 'bottom' })
    let layout = computeLayout(tree, 1000, 800)
    assert.deepEqual(rect(layout, 'q'), [500, 400, 500, 400])
    assert.deepEqual(rect(layout, 'r'), [500, 0, 500, 400])
    assert.deepEqual(rect(layout, 'main'), [0, 0, 500, 800])
    tree = insertPane(tree, 'all', { target: null, side: 'bottom' })
    layout = computeLayout(tree, 1000, 800)
    assert.deepEqual(rect(layout, 'all'), [0, 400, 1000, 400])
    assert.deepEqual(rect(layout, 'main'), [0, 0, 500, 400])
  })

  it('同方向的分块合并成一层，各块所占比例不变', () => {
    let tree = insertPane({ pane: 'a' }, 'b', { target: 'a', side: 'right' })
    tree = insertPane(tree, 'c', { target: 'b', side: 'right' })
    assert.equal(tree.dir, 'row')
    assert.deepEqual(tree.children.map((child) => child.pane), ['a', 'b', 'c'])
    assert.deepEqual(tree.sizes, [.5, .25, .25])
  })

  it('关掉一个块，空间还给相邻的块；只剩一个时不再分块', () => {
    let tree = insertPane({ pane: 'main' }, 'r', { target: 'main', side: 'right' })
    tree = insertPane(tree, 'q', { target: 'r', side: 'bottom' })
    tree = removePane(tree, 'r')
    assert.deepEqual(paneIds(tree), ['main', 'q'])
    assert.deepEqual(rect(computeLayout(tree, 1000, 800), 'q'), [500, 0, 500, 800])
    assert.deepEqual(removePane(tree, 'q'), { pane: 'main' })
    assert.equal(removePane({ pane: 'main' }, 'main'), undefined)
  })

  it('最小尺寸：放不下就不允许；拖分隔线停在最小尺寸', () => {
    const tree = insertPane({ pane: 'main' }, 'r', { target: 'main', side: 'right' })
    assert.equal(fits(tree, 600, 800, 260, 160), true)
    assert.equal(fits(insertPane(tree, 'x', { target: 'r', side: 'right' }), 600, 800, 260, 160), false)
    const divider = computeLayout(tree, 1000, 800).dividers[0]
    const moved = moveDivider(tree, divider.path, divider.index, 10, divider.span, 260, 160)
    assert.deepEqual(rect(computeLayout(moved, 1000, 800), 'main'), [0, 0, 260, 800])
    const far = moveDivider(tree, divider.path, divider.index, 990, divider.span, 260, 160)
    assert.deepEqual(rect(computeLayout(far, 1000, 800), 'r'), [740, 0, 260, 800])
  })

  it('落点取最近的边；读回保存的布局时拒绝坏数据', () => {
    const box = { left: 0, top: 0, width: 400, height: 300 }
    assert.equal(sideAt(box, 390, 150), 'right')
    assert.equal(sideAt(box, 200, 10), 'top')
    assert.equal(sideAt(box, 5, 290), 'left')
    const tree = insertPane({ pane: 'main' }, 'r', { target: 'main', side: 'right' })
    assert.deepEqual(readTree(JSON.parse(JSON.stringify(tree))), tree)
    assert.equal(readTree({ dir: 'row', sizes: [1], children: [{ pane: 'a' }] }), undefined)
    assert.equal(readTree({ dir: 'row', sizes: [1, 1], children: [{ pane: 'a' }, { pane: 'a' }] }), undefined)
    assert.equal(readTree({ dir: 'diagonal', sizes: [1, 1], children: [{ pane: 'a' }, { pane: 'b' }] }), undefined)
    assert.equal(readTree({ dir: 'row', sizes: [-1, 1], children: [{ pane: 'a' }, { pane: 'b' }] }), undefined)
  })
})

describe('桌面版对照窗口路由', () => {
  const id = '6b12f70d-2b2b-4af7-9821-ab9611aa8212'
  it('只接受一个章节或一个原文件的只读路由', () => {
    assert.equal(isReadingRoute(`#/compare/original/${id}/${id}/${id}`), true)
    assert.equal(isReadingRoute(`#/compare/reference/${id}/file`), true)
    assert.equal(isReadingRoute(`#/original/${id}`), false)
    assert.equal(isReadingRoute(`#/compare/original/${id}/file?x=1`), false)
    assert.equal(isReadingRoute(`#/compare/other/${id}/file`), false)
    assert.equal(isReadingRoute(`https://example.com/#/compare/original/${id}/file`), false)
    assert.equal(isReadingRoute(42), false)
  })
})
