import { test, expect } from './app-test.mjs'
import {
  action, arrow, boardState, canvas, card, cardPanel, drag, edgeGeometry, edgeMiddle, expectOnOutline, inlineField, intersects,
  liveView, midpoint, newCard, newStoryWork, openStoryWindow, props, seedBoard, selectEdge, status, storyCard, toPage, tool, toolbar,
} from './story-settings-helpers.mjs'

test.setTimeout(90_000)

const keeper = card('keeper', '守灯人', 160, 200)
const captain = card('captain', '船长', 600, 200)
const harbor = card('harbor', '雾港', 380, 430)

async function board(page, scene, view) {
  await page.goto('/#/writing')
  await newStoryWork(page, '画布手感')
  const story = await openStoryWindow(page)
  if (scene) await seedBoard(story, { tags: [], edges: [], ...scene }, view)
  return story
}

const center = async (page, node) => toPage(page, { x: node.x + node.width / 2, y: node.y + node.height / 2 })
const box = (locator) => locator.boundingBox()
const edges = (page) => expect.poll(async () => (await boardState(page)).scene.edges)

test('工具岛只有一排，快捷键切换工具，画完自动回到选择，Q 和双击工具按钮锁定工具', async ({ page }) => {
  const story = await board(page, { nodes: [keeper, captain] })
  const tools = toolbar(story).getByRole('button')
  await expect(tools).toHaveCount(8)
  const names = await tools.evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')))
  expect(names).toEqual(['选择', '平移', '卡片', '箭头', '文字', '分组框', '图片', '橡皮擦'])
  const layout = await toolbar(story).evaluate((bar) => {
    const items = [...bar.querySelectorAll('button')].map((item) => item.getBoundingClientRect())
    return { tops: new Set(items.map((item) => Math.round(item.top))).size, scroll: bar.scrollWidth - bar.clientWidth, top: bar.getBoundingClientRect().top, keys: [...bar.querySelectorAll('kbd')].map((key) => key.textContent) }
  })
  expect(layout).toEqual({ tops: 1, scroll: 0, top: layout.top, keys: ['1', 'H', '2', '5', '8', 'F', '9', '0'] })
  expect(layout.top).toBeLessThan(30)
  // No permanent delete or copy buttons; properties only appear with a selection.
  await expect(action(story, '删除')).toHaveCount(0)
  await expect(props(story)).toBeHidden()

  const pressed = (name) => expect(tool(story, name)).toHaveAttribute('aria-pressed', 'true')
  for (const [key, name] of [['h', '平移'], ['r', '卡片'], ['a', '箭头'], ['t', '文字'], ['f', '分组框'], ['e', '橡皮擦'], ['v', '选择'],
    ['2', '卡片'], ['5', '箭头'], ['8', '文字'], ['0', '橡皮擦'], ['1', '选择']]) {
    await canvas(story).press(key)
    await pressed(name)
  }
  // A card drawn with the card tool hands back to the select tool.
  await canvas(story).press('r')
  await canvas(story).click({ position: { x: 700, y: 520 } })
  await inlineField(story).fill('旅客')
  await inlineField(story).press('Enter')
  await expect(storyCard(story, '旅客')).toBeVisible()
  await pressed('选择')
  // Q keeps the arrow tool for several arrows in a row.
  await canvas(story).press('a')
  await canvas(story).press('q')
  await expect(tool(story, '箭头')).toHaveAttribute('data-locked', '')
  await drag(story, await center(story, keeper), await center(story, captain))
  await drag(story, await center(story, captain), await midpoint(storyCard(story, '旅客')))
  await edges(story).toHaveLength(2)
  await pressed('箭头')
  await canvas(story).press('q')
  await expect(tool(story, '箭头')).not.toHaveAttribute('data-locked', '')
  await drag(story, await midpoint(storyCard(story, '旅客')), await center(story, keeper))
  await edges(story).toHaveLength(3)
  await pressed('选择')
  // Double-clicking a tool button locks it too.
  await tool(story, '文字').dblclick()
  await expect(tool(story, '文字')).toHaveAttribute('data-locked', '')
  for (const [x, text] of [[200, '第一条'], [420, '第二条']]) {
    await canvas(story).click({ position: { x, y: 600 } })
    await inlineField(story, '纯文本').fill(text)
    await inlineField(story, '纯文本').press('Enter')
  }
  await expect(story.locator('.story-node-text')).toHaveCount(2)
  await pressed('文字')
  await canvas(story).press('Escape')
  await pressed('选择')
})

test('箭头：从卡片中间拖出绑定起点，靠近目标高亮，按住 Ctrl 不吸附，拖控制点改连和调弧度，双击写关系名', async ({ page }) => {
  const story = await board(page, { nodes: [keeper, captain, harbor] })
  await canvas(story).press('a')
  const start = await center(story, keeper)
  const near = await toPage(story, { x: captain.x - 8, y: captain.y + 30 })
  await story.mouse.move(start.x, start.y)
  await story.mouse.down()
  await story.mouse.move(near.x, near.y, { steps: 6 })
  await expect(storyCard(story, '船长')).toHaveClass(/story-bind-target/)
  await story.mouse.up()
  await edges(story).toEqual([expect.objectContaining({ from: { nodeId: 'keeper' }, to: { nodeId: 'captain' }, name: '' })])
  const [linked] = (await boardState(story)).scene.edges
  // No placeholder text on an unnamed arrow.
  await expect(story.locator(`[data-edge-id="${linked.id}"] text`)).toHaveCount(0)

  // Holding Ctrl leaves the end loose even right next to a card; releasing on blank leaves it loose too.
  await canvas(story).press('a')
  const beside = await toPage(story, { x: harbor.x + 20, y: harbor.y - 6 })
  await story.mouse.move(start.x, start.y)
  await story.mouse.down()
  await story.keyboard.down('Control')
  await story.mouse.move(beside.x, beside.y, { steps: 6 })
  await expect(story.locator('.story-bind-target')).toHaveCount(0)
  await story.mouse.up()
  await story.keyboard.up('Control')
  await expect.poll(async () => (await boardState(story)).scene.edges.length).toBe(2)
  const loose = (await boardState(story)).scene.edges[1]
  expect(loose.from).toEqual({ nodeId: 'keeper' })
  expect(loose.to).toEqual({ x: expect.any(Number), y: expect.any(Number) })
  expect((await boardState(story)).scene.nodes).toHaveLength(3)

  // Drag the loose end onto a card to connect it.
  await selectEdge(story, loose.id)
  const end = story.locator('[data-end="to"]')
  await drag(story, await midpoint(end), await center(story, harbor))
  await expect.poll(async () => (await boardState(story)).scene.edges[1].to).toEqual({ nodeId: 'harbor' })
  // Reconnect the first arrow's end from the captain to the harbor.
  await selectEdge(story, linked.id)
  await drag(story, await midpoint(story.locator('[data-end="to"]')), await toPage(story, { x: harbor.x + 140, y: harbor.y + 30 }))
  // The keeper already points at the harbor, so this is refused until confirmed.
  await expect(status(story)).toContainText('已经有这个关系了')
  expect((await boardState(story)).scene.edges[0].to).toEqual({ nodeId: 'captain' })
  await action(status(story), '仍然新建').click()
  await expect.poll(async () => (await boardState(story)).scene.edges[0].to).toEqual({ nodeId: 'harbor' })
  // Both arrows now join the same pair and must not lie on top of each other.
  const [a, b] = (await boardState(story)).scene.edges
  expect(Math.abs(a.bend - b.bend)).toBeGreaterThanOrEqual(24)
  // Pull the middle out into a curve.
  await selectEdge(story, linked.id)
  const bend = await midpoint(story.locator('[data-bend]'))
  await drag(story, bend, { x: bend.x + 60, y: bend.y - 40 })
  await expect.poll(async () => Math.abs((await boardState(story)).scene.edges[0].bend - a.bend)).toBeGreaterThan(20)

  // Double-click writes the name in place; Enter saves, Escape cancels.
  await story.mouse.dblclick(...Object.values(await edgeMiddle(story, linked.id)))
  await inlineField(story, '关系名称').fill('居于')
  await inlineField(story, '关系名称').press('Enter')
  await expect(story.locator(`[data-edge-id="${linked.id}"] .story-edge-label`)).toHaveText('居于')
  await expect(story.locator(`[data-edge-id="${linked.id}"] .story-line`)).toHaveAttribute('mask', /story-mask/)
  await story.mouse.dblclick(...Object.values(await edgeMiddle(story, linked.id)))
  await inlineField(story, '关系名称').fill('不要')
  await inlineField(story, '关系名称').press('Escape')
  await expect(inlineField(story, '关系名称')).toHaveCount(0)
  await expect.poll(async () => (await boardState(story)).scene.edges[0].name).toBe('居于')
  // Clicking elsewhere saves.
  await story.mouse.dblclick(...Object.values(await edgeMiddle(story, linked.id)))
  await inlineField(story, '关系名称').fill('守护')
  await canvas(story).click({ position: { x: 1000, y: 600 } })
  await expect.poll(async () => (await boardState(story)).scene.edges[0].name).toBe('守护')
})

test('移动和缩放卡片后，箭头两端仍贴在卡片边缘上', async ({ page }) => {
  const story = await board(page, { nodes: [keeper, captain], edges: [arrow('link', 'keeper', 'captain')] })
  const check = async () => {
    const { nodes } = (await boardState(story)).scene
    const geometry = await edgeGeometry(story, 'link')
    expectOnOutline(nodes.find(({ id }) => id === 'keeper'), geometry.from)
    expectOnOutline(nodes.find(({ id }) => id === 'captain'), geometry.to)
    return geometry
  }
  const first = await check()
  const from = await center(story, keeper)
  await story.keyboard.down('Control')
  await drag(story, from, { x: from.x + 130, y: from.y + 190 })
  await story.keyboard.up('Control')
  await expect.poll(async () => (await boardState(story)).scene.nodes[0].y).toBe(keeper.y + 190)
  const moved = await check()
  expect(moved.from).not.toEqual(first.from)
  await storyCard(story, '船长').click()
  const corner = await midpoint(story.locator('[data-corner="sw"]'))
  await drag(story, corner, { x: corner.x - 90, y: corner.y + 120 })
  await expect.poll(async () => (await boardState(story)).scene.nodes[1].height).toBe(captain.height + 120)
  const resized = await check()
  expect(resized.to).not.toEqual(moved.to)
  // While dragging (before saving) the drawn end already follows.
  const now = await midpoint(storyCard(story, '守灯人'))
  await story.mouse.move(now.x, now.y)
  await story.mouse.down()
  await story.mouse.move(now.x - 60, now.y - 50, { steps: 5 })
  const live = await edgeGeometry(story, 'link')
  const view = await liveView(story)
  const rect = await box(storyCard(story, '守灯人'))
  const area = await box(canvas(story))
  expectOnOutline({ x: (rect.x - area.x - view.x) / view.zoom, y: (rect.y - area.y - view.y) / view.zoom, width: rect.width / view.zoom, height: rect.height / view.zoom }, live.from)
  await story.mouse.up()
})

test('同方向重复连线被拦下并提示，仍然新建和反方向的线自动错开成弧线', async ({ page }) => {
  const story = await board(page, { nodes: [keeper, captain], edges: [arrow('link', 'keeper', 'captain')] })
  await canvas(story).press('a')
  await drag(story, await center(story, keeper), await center(story, captain))
  await expect(status(story)).toContainText('已经有这个关系了')
  await expect(story.locator('[data-edge-id="link"]')).toHaveClass(/selected/)
  await edges(story).toHaveLength(1)
  await action(status(story), '仍然新建').click()
  await edges(story).toHaveLength(2)
  await canvas(story).press('a')
  await drag(story, await center(story, captain), await center(story, keeper))
  await edges(story).toHaveLength(3)
  const ids = (await boardState(story)).scene.edges.map(({ id }) => id)
  const mids = await Promise.all(ids.map(async (id) => (await edgeGeometry(story, id)).mid))
  for (let i = 0; i < mids.length; i++) for (let j = i + 1; j < mids.length; j++) {
    expect(Math.hypot(mids[i].x - mids[j].x, mids[i].y - mids[j].y)).toBeGreaterThan(30)
  }
  // Ctrl/⌘+D on a selected arrow adds one more parallel arrow, also spread apart.
  await selectEdge(story, ids[0])
  await story.keyboard.press('Control+d')
  await edges(story).toHaveLength(4)
  const bends = (await boardState(story)).scene.edges.map((edge) => edge.from.nodeId === 'keeper' ? edge.bend : -edge.bend)
  expect(new Set(bends).size).toBe(4)
})

test('框选、Shift 加选、对齐参考线、方向键微移、复制粘贴、复制一份和撤销重做', async ({ page }) => {
  const story = await board(page, { nodes: [keeper, captain, harbor] })
  const area = await box(canvas(story))
  await drag(story, await toPage(story, { x: 120, y: 150 }), await toPage(story, { x: 840, y: 350 }))
  await expect(storyCard(story, '守灯人')).toHaveAttribute('aria-pressed', 'true')
  await expect(storyCard(story, '船长')).toHaveAttribute('aria-pressed', 'true')
  await expect(storyCard(story, '雾港')).toHaveAttribute('aria-pressed', 'false')
  await storyCard(story, '雾港').click({ modifiers: ['Shift'] })
  await expect(story.locator('.story-node-card[aria-pressed="true"]')).toHaveCount(3)
  await storyCard(story, '雾港').click({ modifiers: ['Shift'] })
  await expect(story.locator('.story-node-card[aria-pressed="true"]')).toHaveCount(2)

  // Dragging the harbor near the keeper's top edge shows a guide and snaps; Ctrl turns it off.
  await canvas(story).press('Escape')
  const from = await center(story, harbor)
  const offset = { x: 30, y: keeper.y - harbor.y + 5 }
  await story.mouse.move(from.x, from.y)
  await story.mouse.down()
  await story.mouse.move(from.x + offset.x, from.y + offset.y, { steps: 6 })
  await expect(story.locator('.story-guides line')).not.toHaveCount(0)
  await story.mouse.up()
  await expect.poll(async () => (await boardState(story)).scene.nodes[2].y).toBe(keeper.y)
  const snapped = (await boardState(story)).scene.nodes[2]
  const again = await center(story, snapped)
  await story.mouse.move(again.x, again.y)
  await story.mouse.down()
  await story.keyboard.down('Control')
  await story.mouse.move(again.x, again.y + 4, { steps: 4 })
  await expect(story.locator('.story-guides line')).toHaveCount(0)
  await story.mouse.up()
  await story.keyboard.up('Control')
  await expect.poll(async () => (await boardState(story)).scene.nodes[2].y).toBe(keeper.y + 4)

  // Arrow keys nudge by 1, Shift by 10.
  await storyCard(story, '守灯人').click()
  await story.keyboard.press('ArrowRight')
  await expect.poll(async () => (await boardState(story)).scene.nodes[0].x).toBe(keeper.x + 1)
  await story.keyboard.press('Shift+ArrowDown')
  await expect.poll(async () => (await boardState(story)).scene.nodes[0].y).toBe(keeper.y + 10)

  // Copy, paste and duplicate.
  await story.keyboard.press('Control+c')
  await story.keyboard.press('Control+v')
  await expect(storyCard(story, '守灯人')).toHaveCount(2)
  await story.keyboard.press('Control+d')
  await expect(storyCard(story, '守灯人')).toHaveCount(3)
  const copies = (await boardState(story)).scene.nodes.filter((node) => node.name === '守灯人')
  expect(new Set(copies.map(({ id }) => id)).size).toBe(3)
  await story.keyboard.press('Control+z')
  await expect(storyCard(story, '守灯人')).toHaveCount(2)
  await story.keyboard.press('Control+z')
  await expect(storyCard(story, '守灯人')).toHaveCount(1)
  await story.keyboard.press('Control+Shift+z')
  await expect(storyCard(story, '守灯人')).toHaveCount(2)
  void area
})

test('双击空白新建卡片，双击卡片直接改名，回车打开完整编辑面板，删除卡片需确认', async ({ page }) => {
  const story = await board(page, { nodes: [keeper] })
  await canvas(story).dblclick({ position: { x: 700, y: 450 } })
  await expect(inlineField(story)).toBeFocused()
  await inlineField(story).fill('灯塔')
  await inlineField(story).press('Enter')
  await expect(storyCard(story, '灯塔')).toBeVisible()
  const created = (await boardState(story)).scene.nodes[1]
  expect(created).toMatchObject({ kind: 'card', name: '灯塔', chapters: [expect.objectContaining({ chapterId: expect.any(String) })] })
  const at = await toPage(story, { x: created.x + created.width / 2, y: created.y + created.height / 2 })
  const area = await box(canvas(story))
  expect(Math.abs(at.x - area.x - 700)).toBeLessThan(2)
  // Escape cancels a new card.
  await canvas(story).dblclick({ position: { x: 300, y: 560 } })
  await inlineField(story).fill('不要')
  await inlineField(story).press('Escape')
  await expect(storyCard(story, '不要')).toHaveCount(0)

  await storyCard(story, '守灯人').dblclick()
  await expect(inlineField(story)).toHaveValue('守灯人')
  await inlineField(story).fill('老守灯人')
  await inlineField(story).press('Enter')
  await expect(storyCard(story, '老守灯人')).toBeVisible()
  await storyCard(story, '老守灯人').click()
  await story.keyboard.press('Enter')
  await expect(cardPanel(story).getByLabel('名称', { exact: true })).toHaveValue('老守灯人')
  await action(cardPanel(story), '关闭编辑面板').click()

  await story.keyboard.press('Delete')
  const confirm = story.getByRole('dialog', { name: '将卡片移入回收站？' })
  await expect(confirm).toBeVisible()
  await action(confirm, '移入回收站').click()
  await expect(storyCard(story, '老守灯人')).toHaveCount(0)
  // Text and frames go without asking and come back with undo.
  await canvas(story).press('t')
  await canvas(story).click({ position: { x: 300, y: 300 } })
  await inlineField(story, '纯文本').fill('便签')
  await inlineField(story, '纯文本').press('Enter')
  await story.locator('.story-node-text').click()
  await story.keyboard.press('Delete')
  await expect(story.locator('.story-node-text')).toHaveCount(0)
  await expect(story.getByRole('dialog')).toHaveCount(0)
  await story.keyboard.press('Control+z')
  await expect(story.locator('.story-node-text')).toHaveCount(1)
})

test('属性面板、菜单、关系名输入框和悬停详情都不压在被操作的对象上', async ({ page }) => {
  const left = card('left', '左侧', 30, 90, { body: '靠左的卡片会让面板翻到右边。' })
  const right = card('right', '右侧', 1080, 90)
  const close = card('close', '近邻', 260, 90)
  const story = await board(page, { nodes: [left, right, close], edges: [arrow('pair', 'left', 'close')] })
  const panel = props(story)
  for (const name of ['左侧', '右侧']) {
    await canvas(story).press('Escape')
    await storyCard(story, name).click()
    await expect(panel).toBeVisible()
    expect(intersects(await box(panel), await box(storyCard(story, name)))).toBe(false)
  }
  // The arrow between two close cards: its name field moves off both cards.
  await canvas(story).press('Escape')
  await story.mouse.dblclick(...Object.values(await edgeMiddle(story, 'pair')))
  const field = await box(inlineField(story, '关系名称'))
  for (const name of ['左侧', '近邻']) expect(intersects(field, await box(storyCard(story, name)))).toBe(false)
  await inlineField(story, '关系名称').press('Escape')
  await selectEdge(story, 'pair')
  await expect(panel).toBeVisible()
  // The arrow is selected now; the panel keeps clear of the drawn arrow.
  const edgeBox = await box(story.locator('[data-edge-id="pair"] .story-line'))
  expect(intersects(await box(panel), edgeBox)).toBe(false)
  // The menu keeps the selected card in view.
  await canvas(story).press('Escape')
  await storyCard(story, '左侧').click()
  await action(story, '菜单').click()
  const menu = story.getByRole('menu', { name: '菜单' })
  await expect(menu).toBeVisible()
  await expect.poll(async () => intersects(await box(menu), await box(storyCard(story, '左侧')))).toBe(false)
  await story.keyboard.press('Escape')
  // Hover details sit beside the card.
  await canvas(story).press('Escape')
  await storyCard(story, '左侧').hover()
  const peek = story.getByRole('tooltip')
  await expect(peek).toContainText('靠左的卡片')
  expect(intersects(await box(peek), await box(storyCard(story, '左侧')))).toBe(false)
  await expect(storyCard(story, '左侧')).not.toContainText('靠左的卡片')
})

test('缩放到 50% 时线宽、箭头和关系名仍然够大 @webkit', async ({ page }) => {
  const story = await board(page, {
    nodes: [keeper, captain], edges: [arrow('link', 'keeper', 'captain', { name: '师徒' })],
  }, { x: 100, y: 60, zoom: .5 })
  await expect(canvas(story)).toHaveAttribute('data-zoom', '0.5')
  const sizes = await story.locator('[data-edge-id="link"]').evaluate((group) => {
    const zoom = .5
    const line = group.querySelector('.story-line')
    const head = group.querySelector('.story-head').getBoundingClientRect()
    const label = group.querySelector('.story-edge-label')
    return {
      line: Number(line.getAttribute('stroke-width')) * zoom,
      head: Math.max(head.width, head.height),
      font: Number(label.getAttribute('font-size')) * zoom,
      label: label.getBoundingClientRect().height,
      hit: Number(group.querySelector('.story-hit').getAttribute('stroke-width')) * zoom,
    }
  })
  expect(sizes.line).toBeGreaterThanOrEqual(2.4)
  expect(sizes.head).toBeGreaterThanOrEqual(10)
  expect(sizes.font).toBeGreaterThanOrEqual(12)
  expect(sizes.label).toBeGreaterThanOrEqual(12)
  expect(sizes.hit).toBeGreaterThanOrEqual(14)
  // The wide hit area is clickable well beside the thin line.
  const middle = await edgeMiddle(story, 'link')
  await story.mouse.click(middle.x + 30, middle.y + 6)
  await expect(story.locator('[data-edge-id="link"]')).toHaveClass(/selected/)
})
