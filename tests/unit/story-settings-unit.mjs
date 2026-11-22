import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { bendThrough, bindingGap, borderPoint, freeBend, snapRect, storyEdgePaths } from '../../src/story-settings/geometry.ts'
import { blankStoryCard, defaultStoryColor, emptyStoryBoard, isStoryCard, isStoryScene, matchesStoryCard, storyStateAt, uniqueAliases, validStoryRows } from '../../src/story-settings/model.ts'

const { isStorySettingsRoute, isTrustedSecondaryRenderer } = createRequire(import.meta.url)('../../desktop/ipc-guard.cjs')
const node = (id, name) => ({ ...blankStoryCard(), id, name, kind: 'card', x: 12, y: 4, width: 210, height: 127 })
const relation = (id, to, from = { nodeId: 'keeper' }) => ({ id, from, to, name: '', stroke: 'solid', direction: 'forward', color: defaultStoryColor, bend: 0 })

test('story aliases retain spelling, deduplicate normalized names and support case and width insensitive search', () => {
  const name = '守灯人'
  const aliases = uniqueAliases(name, ['  守灯人  ', '  Luna ', 'ＬＵＮＡ', '老灯长', ' ', '守灯人'])
  assert.deepEqual(aliases, ['Luna', '老灯长'])
  const card = { name, aliases }
  assert.equal(matchesStoryCard(card, ' ＵＮＡ '), true)
  assert.equal(matchesStoryCard(card, '灯长'), true)
  assert.equal(matchesStoryCard(card, '守灯人'), true)
  assert.equal(matchesStoryCard(card, '未知别名'), false)
})

test('chapter states use the latest present anchor in the current edition only', () => {
  const edition = { id: 'draft', chapters: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })) }
  const first = { editionId: edition.id, chapterId: 'b', text: '初登场' }
  const next = { editionId: edition.id, chapterId: 'd', text: '成为船长' }
  const card = { states: [next, { editionId: 'other', chapterId: 'a', text: '另一版' }, first] }
  assert.equal(storyStateAt(card, edition, 'a'), undefined)
  assert.equal(storyStateAt(card, edition, 'b'), first)
  assert.equal(storyStateAt(card, edition, 'c'), first)
  assert.equal(storyStateAt(card, edition, 'd'), next)
  assert.equal(storyStateAt(card, edition, 'e'), next)
  assert.equal(storyStateAt(card, edition, 'removed'), undefined)
  assert.equal(storyStateAt(card, { ...edition, id: 'other' }, 'c')?.text, '另一版')
  const reordered = { ...edition, chapters: ['d', 'c', 'b', 'a'].map((id) => ({ id })) }
  assert.equal(storyStateAt(card, reordered, 'c'), next)
  assert.equal(storyStateAt(card, reordered, 'a'), first)
  assert.equal(storyStateAt(card, { ...edition, chapters: [{ id: 'c' }] }, 'c'), undefined)
})

test('the board accepts free fields and line-to-line references, rejects a cyclic edge and invalid raster source', () => {
  const keeper = { ...node('keeper', '守灯人'), tagIds: ['lead'], fields: [{ key: '班次', value: '夜' }, { key: '自定义字段', value: '值' }] }
  const scene = {
    tags: [{ id: 'lead', name: '主线', color: '#440033' }], nodes: [keeper, node('port', '雾港')],
    edges: [relation('a', { nodeId: 'port' }), relation('b', { edgeId: 'a', at: .3 }), relation('c', { x: 40, y: -12.5 }, { x: 0, y: 0 })],
  }
  assert.equal(isStoryScene(scene), true)
  assert.equal(isStoryScene({ ...scene, edges: [relation('a', { edgeId: 'b', at: .5 }), scene.edges[1]] }), false)
  assert.equal(isStoryScene({ ...scene, edges: [relation('a', { nodeId: 'port' }, { edgeId: 'b', at: .5 }), scene.edges[1]] }), false)
  assert.equal(isStoryScene({ ...scene, edges: [relation('a', { nodeId: 'keeper' })] }), false)
  assert.equal(isStoryScene({ ...scene, edges: [{ ...relation('a', { nodeId: 'port' }), from: { nodeId: 'keeper', side: 'right' } }] }), false)
  assert.equal(isStoryScene({ ...scene, edges: [{ ...relation('a', { nodeId: 'port' }), bend: undefined }] }), false)
  assert.equal(isStoryScene({ ...scene, nodes: [...scene.nodes, { id: 'bad', name: 'image', kind: 'image', x: 1, y: 1, width: 50, height: 50, src: 'https://example.com' }] }), false)
  assert.equal(isStoryCard({ ...keeper, aliases: ['Luna', 'ＬＵＮＡ'] }), false)
})

test('archives validate the work owner, card identity and chapter scope across the recycle bin', () => {
  const card = { ...node('keeper', '守灯人'), chapters: [{ editionId: 'draft', chapterId: 'chapter' }] }
  const work = { library: 'original', bookId: 'root' }
  const board = emptyStoryBoard(work)
  board.scene.nodes.push(card)
  const book = { library: 'original', id: 'root' }
  const chapter = { ...work, editionId: 'draft', id: 'chapter' }
  const deleted = { kind: 'storyCard', ...work, books: [], files: [], editions: [], chapters: [], storyCard: card }
  assert.equal(validStoryRows([board], [book], [chapter], []), true)
  assert.equal(validStoryRows([board], [], [], []), false)
  assert.equal(validStoryRows([board], [book], [{ ...chapter, editionId: 'other' }], []), false)
  assert.equal(validStoryRows([board], [book], [], [deleted]), false)
  assert.equal(validStoryRows([], [], [], [deleted]), true)
})

test('Electron accepts chapter context on the work route and limits secondary IPC to the top frame', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  const appUrl = 'new-world://app/'
  const hash = `#/story-settings/original/${id}`
  assert.equal(isStorySettingsRoute(hash), true)
  assert.equal(isStorySettingsRoute(`${hash}?edition=${id}&chapter=${id}`), true)
  for (const bad of [null, `${hash}/other`, `${hash}?next=1`, `${hash}?edition=${id}`, `https://example.org/${hash}`, '#/story-settings/original/short']) {
    assert.equal(isStorySettingsRoute(bad), false)
  }
  const frame = { url: appUrl + hash }
  const webContents = { mainFrame: frame }
  const windows = [{ webContents }]
  const event = { sender: webContents, senderFrame: frame }
  assert.equal(isTrustedSecondaryRenderer(event, appUrl, windows), true)
  assert.equal(isTrustedSecondaryRenderer({ ...event, senderFrame: { url: frame.url } }, appUrl, windows), false)
})

test('arrow ends glue to the outline facing the other end, follow resizes and spread parallel arrows apart', () => {
  const a = { ...node('a', '甲'), x: 0, y: 0, width: 100, height: 50 }
  const b = { ...node('b', '乙'), x: 300, y: 0, width: 100, height: 50 }
  const scene = { tags: [], nodes: [a, b], edges: [relation('e', { nodeId: 'b' }, { nodeId: 'a' })] }
  let path = storyEdgePaths(scene).get('e')
  assert.deepEqual([path.from, path.to], [{ x: 100 + bindingGap, y: 25 }, { x: 300 - bindingGap, y: 25 }])
  path = storyEdgePaths({ ...scene, nodes: [a, { ...b, y: 200, height: 80 }] }).get('e')
  assert.ok(Math.abs(Math.min(Math.abs(path.to.y - (200 - bindingGap)), Math.abs(path.to.x - (300 - bindingGap)))) < 1e-9)
  const curved = storyEdgePaths({ ...scene, edges: [{ ...scene.edges[0], bend: 40 }] }).get('e')
  // A curved arrow leaves each card on the side facing its curve.
  assert.ok(curved.from.y > 25 && curved.to.y > 25 && curved.from.x === 100 + bindingGap)
  assert.equal(Math.round(bendThrough(curved.from, curved.to, curved.mid)), 40)
  assert.deepEqual(borderPoint({ x: 0, y: 0, width: 100, height: 50 }, { x: 50, y: -100 }, 0), { x: 50, y: 0 })
  assert.equal(freeBend([]), 0)
  assert.equal(freeBend([0]), 48)
  assert.equal(freeBend([0, 48]), -48)
  // Snapping aligns the nearest edge within the threshold and reports the guide.
  const snap = snapRect({ x: 3, y: 100, width: 50, height: 20 }, [{ x: 0, y: 0, width: 80, height: 30 }], 8)
  assert.equal(snap.dx, -3)
  assert.deepEqual(snap.guides[0], { axis: 'x', at: 0, from: 0, to: 120 })
  assert.equal(snapRect({ x: 120, y: 100, width: 50, height: 20 }, [{ x: 0, y: 0, width: 80, height: 30 }], 8).dx, 0)
})
