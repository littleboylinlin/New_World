import { TextWriter, Uint8ArrayReader, ZipReader } from '@zip.js/zip.js'
import { readFile } from 'node:fs/promises'
import { test, expect } from './app-test.mjs'
import {
  action, boardState, cardPanel, editCard, edgeGeometry, expectOnOutline, newCard, newStoryWork, openStoryWindow,
  saveCard, seedBoard, status, storyCard,
} from './story-settings-helpers.mjs'

test.setTimeout(90_000)

// A board as the previous build of the canvas stored it: links had a fixed side and no bend.
const oldCard = (id, name, x, y, extra = {}) => ({
  id, kind: 'card', x, y, width: 210, height: 140, name, aliases: [], tagIds: [], fields: [], body: '', chapters: [], states: [], ...extra,
})
const oldLink = (id, from, to, extra = {}) => ({ id, from, to, name: '', direction: 'forward', stroke: 'solid', color: '#64748b', ...extra })
const previousScene = {
  tags: [{ id: 'lead', name: '主线', color: '#d9480f' }],
  nodes: [
    oldCard('keeper', '守灯人', 40, 120, { tagIds: ['lead'], aliases: ['灯长'], body: '灯灭后不得出航。' }),
    oldCard('captain', '船长', 420, 120),
    oldCard('harbor', '雾港', 230, 420, { fields: [{ key: '位置', value: '北岸' }] }),
  ],
  edges: [
    oldLink('mentor', { nodeId: 'keeper', side: 'right' }, { nodeId: 'captain', side: 'left' }, { name: '师徒' }),
    oldLink('lives', { nodeId: 'harbor', side: 'top' }, { edgeId: 'mentor', at: .5 }),
    oldLink('lost', { nodeId: 'keeper', side: 'bottom' }, { nodeId: 'no-such-card', side: 'top' }),
  ],
}
const cardsOf = (scene) => scene.nodes.filter((node) => node.kind === 'card')

test('上一版格式的画布能正常打开，移除无效连线后继续保存，卡片一张不少 @webkit', async ({ page }) => {
  await page.goto('/#/writing')
  await newStoryWork(page, '旧画布')
  const story = await openStoryWindow(page)
  // Phone width, as the problem was found on a phone.
  await story.setViewportSize({ width: 390, height: 844 })
  await seedBoard(story, previousScene)

  // One note about the broken link, and the board is saved back in the current format.
  await expect(status(story)).toContainText('有 1 条无效连线已被移除')
  await expect(story.getByRole('alert')).toBeHidden()
  await expect.poll(async () => (await boardState(story)).scene.edges.map(({ id }) => id)).toEqual(['mentor', 'lives'])
  const repaired = (await boardState(story)).scene
  expect(repaired.edges[0]).toEqual({ id: 'mentor', from: { nodeId: 'keeper' }, to: { nodeId: 'captain' }, name: '师徒', direction: 'forward', stroke: 'solid', color: '#64748b', bend: 0 })
  expect(repaired.edges[1]).toMatchObject({ from: { nodeId: 'harbor' }, to: { edgeId: 'mentor', at: .5 }, bend: 0 })
  expect(cardsOf(repaired)).toEqual(cardsOf(previousScene))
  expect(repaired.tags).toEqual(previousScene.tags)

  // The old links are drawn again, glued to the cards.
  await expect(story.locator('.story-edge-label')).toHaveText('师徒')
  for (const id of ['mentor', 'lives']) expect(await story.locator(`[data-edge-id="${id}"] .story-line`).getAttribute('d')).not.toContain('NaN')
  const mentor = await edgeGeometry(story, 'mentor')
  expectOnOutline(previousScene.nodes[0], mentor.from)
  expectOnOutline(previousScene.nodes[1], mentor.to)

  // Editing and saving work again.
  await newCard(story, '旅客')
  await expect.poll(async () => cardsOf((await boardState(story)).scene).map(({ name }) => name)).toEqual(['守灯人', '船长', '雾港', '旅客'])
  await expect(story.getByRole('alert')).toBeHidden()

  // The note is shown once: the stored board no longer needs repair.
  const saved = await boardState(story)
  await story.reload()
  await expect(storyCard(story, '旅客')).toBeVisible()
  await expect(status(story)).toBeHidden()
  expect(await boardState(story)).toEqual(saved)
})

test('全库备份把上一版画布按当前格式导出，不会因旧数据失败', async ({ page }, info) => {
  await page.goto('/#/writing')
  await newStoryWork(page, '只在备份里出现的旧画布')
  const story = await openStoryWindow(page)
  // Store the old board without opening it, so only the backup sees it.
  await story.evaluate(async (scene) => {
    const key = location.hash.split('?')[0].split('/').slice(-2)
    const db = await new Promise((resolve, reject) => { const q = indexedDB.open('new-world-library'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error) })
    const tx = db.transaction('storyBoards', 'readwrite')
    tx.objectStore('storyBoards').put({ library: key[0], bookId: key[1], scene, view: { x: 0, y: 0, zoom: 1 }, revision: crypto.randomUUID() })
    await new Promise((resolve) => { tx.oncomplete = resolve })
    db.close()
  }, previousScene)
  await story.close()
  await page.goto('/#/settings/backup')
  const download = page.waitForEvent('download')
  await page.getByRole('region', { name: '备份与恢复', exact: true }).getByRole('button', { name: '立即备份', exact: true }).click()
  const path = info.outputPath('old-canvas-backup.zip')
  await (await download).saveAs(path)
  const zip = new ZipReader(new Uint8ArrayReader(await readFile(path)), { useWebWorkers: false })
  const entry = (await zip.getEntries()).find((item) => item.filename === 'new-world-backup.json')
  const manifest = JSON.parse(await entry.getData(new TextWriter()))
  await zip.close()
  const [board] = manifest.storyBoards
  expect(cardsOf(board.scene)).toEqual(cardsOf(previousScene))
  expect(board.scene.edges.map(({ id, bend }) => [id, bend])).toEqual([['mentor', 0], ['lives', 0]])
})

test('保存失败时说明具体原因，并选中出问题的卡片', async ({ page }) => {
  await page.goto('/#/writing')
  await newStoryWork(page, '报错要具体')
  const story = await openStoryWindow(page)
  await newCard(story, '周行')
  await editCard(story, '周行')
  const panel = cardPanel(story)
  // Link the same chapter twice.
  await action(panel, '关联章节').click()
  await panel.getByRole('combobox', { name: '关联章节', exact: true }).last().selectOption({ label: '第 1 章 · 第一章' })
  await saveCard(story)
  const reason = '卡片「周行」重复关联了「第 1 章 · 第一章」。'
  await expect(story.getByRole('alert')).toHaveText(reason)
  await expect(panel.getByRole('status')).toHaveText(reason)
  await expect(storyCard(story, '周行')).toHaveAttribute('aria-pressed', 'true')
  expect((await boardState(story)).scene.nodes[0].chapters).toHaveLength(1)
  // The refused change is rolled back; the next one saves as usual.
  await action(panel, '关闭编辑面板').click()
  await newCard(story, '旅客', { x: 200, y: 520 })
  await expect.poll(async () => (await boardState(story)).scene.nodes.map(({ name }) => name)).toEqual(['周行', '旅客'])
  await expect(story.getByRole('alert')).toBeHidden()
})
