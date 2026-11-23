import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { bendThrough, bindingGap, borderPoint, freeBend, lassoPick, pointInPolygon, snapRect, storyEdgePaths } from '../../src/story-settings/geometry.ts'
import { blankStoryCard, defaultStoryColor, emptyStoryBoard, isStoryCard, isStoryScene, matchesStoryCard, repairStoryRows, repairStoryScene, storySceneProblem, storyStateAt, uniqueAliases, validStoryRows } from '../../src/story-settings/model.ts'

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

test('boards saved by the previous canvas build load in the current format without losing a card', () => {
  const card = (id, name, extra = {}) => ({ ...node(id, name), x: 10, y: 20, width: 210, height: 140, ...extra })
  const old = (id, from, to, extra = {}) => ({ id, from, to, name: '', direction: 'forward', stroke: 'solid', color: defaultStoryColor, ...extra })
  const scene = {
    tags: [{ id: 'lead', name: '主线', color: '#440033' }],
    nodes: [
      card('keeper', '守灯人', { tagIds: ['lead', 'deleted-tag'], chapters: [{ editionId: 'd', chapterId: 'c' }, { editionId: 'd', chapterId: 'c' }] }),
      card('captain', '船长', { aliases: ['船长', '老船长'] }),
      card('nameless', '  '),
      { id: 'note', kind: 'text', x: 0, y: 0, width: 100, height: 40, text: '旁注' },
      { id: 'broken', kind: 'image', x: 0, y: 0, width: 100, height: 40, src: 'https://example.com/a.png', name: '' },
    ],
    edges: [
      old('kept', { nodeId: 'keeper', side: 'right' }, { nodeId: 'captain', side: 'left' }, { name: '师徒' }),
      old('onLine', { nodeId: 'note', side: 'top' }, { edgeId: 'kept', at: .4 }),
      old('toTrash', { nodeId: 'keeper', side: 'bottom' }, { nodeId: 'recycled', side: 'top' }),
      old('dangling', { nodeId: 'keeper', side: 'bottom' }, { nodeId: 'gone', side: 'top' }),
      old('onDangling', { nodeId: 'captain', side: 'top' }, { edgeId: 'dangling', at: .5 }),
      old('self', { nodeId: 'captain', side: 'top' }, { nodeId: 'captain', side: 'left' }),
      old('loopA', { nodeId: 'note', side: 'top' }, { edgeId: 'loopB', at: .5 }),
      old('loopB', { nodeId: 'note', side: 'left' }, { edgeId: 'loopA', at: .5 }),
    ],
  }
  assert.deepEqual(storySceneProblem(scene), { kind: 'tagMissing', id: 'keeper', name: '守灯人' })
  const repair = repairStoryScene(scene, { trashedCards: new Set(['recycled']), untitled: '未命名卡片' })
  assert.equal(isStoryScene(repair.scene), true)
  assert.equal(repair.changed, true)
  assert.deepEqual(repair.scene.nodes.map(({ id }) => id), ['keeper', 'captain', 'nameless', 'note'])
  assert.equal(repair.removedNodes, 1)
  assert.equal(repair.repairedCards, 3)
  const [keeper, captain, nameless] = repair.scene.nodes
  assert.deepEqual(keeper.tagIds, ['lead'])
  assert.deepEqual(keeper.chapters, [{ editionId: 'd', chapterId: 'c' }])
  assert.deepEqual(captain.aliases, ['老船长'])
  assert.equal(nameless.name, '未命名卡片')
  // Gone: the end that no longer exists, the link hanging on it, the self link and both halves of the loop.
  assert.deepEqual(repair.scene.edges.map(({ id }) => id), ['kept', 'onLine', 'toTrash'])
  assert.equal(repair.removedEdges, 5)
  assert.deepEqual(repair.scene.edges[0], { id: 'kept', from: { nodeId: 'keeper' }, to: { nodeId: 'captain' }, name: '师徒', direction: 'forward', stroke: 'solid', color: defaultStoryColor, bend: 0 })
  // A repaired board is stable: repairing again changes nothing.
  assert.equal(repairStoryScene(repair.scene, { trashedCards: new Set(['recycled']), untitled: '未命名卡片' }).changed, false)
  // Recycled cards and boards in exports are repaired the same way.
  const board = { library: 'original', bookId: 'root', revision: 'r', view: { x: 0, y: 0, zoom: 1 }, scene }
  const rows = repairStoryRows([board], [{ kind: 'storyCard', library: 'original', bookId: 'root', storyCard: { id: 'recycled', ...card('recycled', '旧卡'), aliases: ['旧卡'] } }], '未命名卡片')
  assert.equal(isStoryScene(rows.boards[0].scene), true)
  assert.ok(rows.boards[0].scene.edges.some(({ id }) => id === 'toTrash'))
  assert.equal(isStoryCard(rows.trash[0].storyCard), true)
})

test('a refused save names the card, the repeated chapter or the size', () => {
  const scene = (nodes, edges = []) => ({ tags: [], nodes, edges })
  assert.deepEqual(storySceneProblem(scene([{ ...node('a', '甲'), name: '' }])), { kind: 'cardName', id: 'a', name: '' })
  const twice = { ...node('a', '甲'), chapters: [{ editionId: 'e', chapterId: 'c' }, { editionId: 'e', chapterId: 'c' }] }
  assert.deepEqual(storySceneProblem(scene([twice])), { kind: 'chapter', id: 'a', name: '甲', chapter: { editionId: 'e', chapterId: 'c' } })
  const state = { ...node('a', '甲'), states: [{ editionId: 'e', chapterId: 'c', text: ' ' }] }
  assert.deepEqual(storySceneProblem(scene([state])), { kind: 'state', id: 'a', name: '甲', chapter: { editionId: 'e', chapterId: 'c' } })
  const big = { ...node('a', '甲'), body: 'x'.repeat(21 * 1024 * 1024) }
  assert.deepEqual(storySceneProblem(scene([big])), { kind: 'size', bytes: new TextEncoder().encode(JSON.stringify(scene([big]))).length, limit: 20 * 1024 * 1024 })
  assert.deepEqual(storySceneProblem(scene([node('a', '甲'), node('a', '乙')])), { kind: 'duplicate', id: 'a' })
  const loop = [relation('x', { edgeId: 'y', at: .5 }), relation('y', { edgeId: 'x', at: .5 })]
  assert.equal(storySceneProblem(scene([node('keeper', '甲')], loop)).kind, 'cycle')
})

test('a lasso picks objects by their middle and arrows only when both ends and the middle are inside', () => {
  const box = (id, x, y) => ({ id, x, y, width: 100, height: 60 })
  const nodes = [box('in', 0, 0), box('edge', 80, 0), box('out', 400, 0)]
  const paths = new Map([
    ['inside', { from: { x: 10, y: 10 }, to: { x: 90, y: 50 }, mid: { x: 50, y: 30 } }],
    ['half', { from: { x: 10, y: 10 }, to: { x: 450, y: 30 }, mid: { x: 230, y: 20 } }],
  ])
  // A concave loop: the notch leaves out the middle of `edge` (at 130, 30).
  const loop = [{ x: -20, y: -20 }, { x: 200, y: -20 }, { x: 115, y: 30 }, { x: 200, y: 80 }, { x: -20, y: 80 }]
  assert.deepEqual(lassoPick(loop, nodes, paths), ['in', 'inside'])
  assert.deepEqual(lassoPick(loop.slice(0, 2), nodes, paths), [])
  assert.equal(pointInPolygon({ x: 0, y: 0 }, loop), true)
  assert.equal(pointInPolygon({ x: 150, y: 30 }, loop), false)
})
