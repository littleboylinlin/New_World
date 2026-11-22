import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { blankStoryCard, isStoryCard, matchesStoryCard, storyStateAt, uniqueAliases, validStoryRows } from '../../src/story-settings/model.ts'

const { isStorySettingsRoute, isTrustedSecondaryRenderer } = createRequire(import.meta.url)('../../desktop/ipc-guard.cjs')

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
  assert.equal(storyStateAt(card, { ...edition, id: 'third' }, 'c'), undefined)
  const reordered = { ...edition, chapters: ['d', 'c', 'b', 'a'].map((id) => ({ id })) }
  assert.equal(storyStateAt(card, reordered, 'c'), next)
  assert.equal(storyStateAt(card, reordered, 'a'), first)
  assert.equal(storyStateAt(card, { ...edition, chapters: [{ id: 'c' }] }, 'c'), undefined)
})

test('card import validation rejects orphan live cards, mismatched chapter ownership and duplicate IDs across trash', () => {
  const card = {
    ...blankStoryCard('character'), name: '守灯人', id: 'keeper', revision: 'revision',
    library: 'original', bookId: 'root', createdAt: 1, updatedAt: 1,
    chapters: [{ editionId: 'draft', chapterId: 'chapter' }],
  }
  const book = { library: 'original', id: 'root' }
  const chapter = { library: 'original', bookId: 'root', editionId: 'draft', id: 'chapter' }
  const deleted = { kind: 'storyCard', library: 'original', bookId: 'root', books: [], files: [], editions: [], chapters: [], storyCards: [card] }
  assert.equal(isStoryCard(card), true)
  assert.equal(isStoryCard({ ...card, aliases: ['Luna', 'ＬＵＮＡ'] }), false)
  assert.equal(isStoryCard({ ...card, states: [{ ...card.chapters[0], text: '' }] }), false)
  assert.equal(isStoryCard({ ...card, relations: [{ targetCardId: card.id, name: '师徒' }] }), false)
  assert.equal(validStoryRows([card], [book], [chapter], []), true)
  assert.equal(validStoryRows([card], [], [], []), false)
  assert.equal(validStoryRows([card], [book], [{ ...chapter, editionId: 'other' }], []), false)
  assert.equal(validStoryRows([card], [book], [], []), true)
  assert.equal(validStoryRows([card], [book], [], [deleted]), false)
  assert.equal(validStoryRows([], [book], [], [{ ...deleted, bookId: 'foreign' }]), false)
  assert.equal(validStoryRows([], [], [], [deleted]), true)
})

test('Electron accepts a work route and restricts secondary-window IPC to its own top frame', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  const appUrl = 'new-world://app/'
  const hash = `#/story-settings/original/${id}`
  assert.equal(isStorySettingsRoute(hash), true)
  assert.equal(isStorySettingsRoute(`#/story-settings/reference/${id}`), true)
  for (const bad of [null, `${hash}/other`, `${hash}?next=1`, `https://example.org/${hash}`, '#/story-settings/original/short']) {
    assert.equal(isStorySettingsRoute(bad), false)
  }
  const frame = { url: appUrl + hash }
  const webContents = { mainFrame: frame }
  const windows = [{ webContents }]
  const event = { sender: webContents, senderFrame: frame }
  assert.equal(isTrustedSecondaryRenderer(event, appUrl, windows), true)
  assert.equal(isTrustedSecondaryRenderer({ ...event, senderFrame: { url: frame.url } }, appUrl, windows), false)
  assert.equal(isTrustedSecondaryRenderer(event, appUrl, []), false)
})
