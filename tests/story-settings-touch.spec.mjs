import { devices } from '@playwright/test'
import { test, expect } from './app-test.mjs'
import { action, boardState, canvas, cardPanel, closeCard, fillNewCard, midpoint, newStoryWork, openStoryWindow, storyCard } from './story-settings-helpers.mjs'

test.use({
  contextOptions: async ({ browserName }, use) => {
    const phone = devices[browserName === 'webkit' ? 'iPhone 13' : 'Pixel 7']
    await use(phone)
  },
})
test.setTimeout(90_000)

async function startBoard(page) {
  await page.goto('/#/writing')
  await newStoryWork(page, '触屏故事设定')
  const story = await openStoryWindow(page)
  expect(await story.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true)
  const area = await canvas(story).boundingBox()
  return { story, area }
}

async function tapAt(page, { x, y }) { await page.touchscreen.tap(x, y) }

async function addByDoubleTap(story, area, name, point) {
  await tapAt(story, { x: area.x + point.x - 12, y: area.y + point.y - 8 })
  await expect(cardPanel(story)).toBeHidden()
  await tapAt(story, { x: area.x + point.x, y: area.y + point.y })
  await expect(cardPanel(story).getByLabel('名称', { exact: true })).toBeVisible()
  await fillNewCard(story, name)
  await closeCard(story)
}

// Playwright exposes native taps on both engines. Its public continuous touch API
// is Chromium-only. Feed WebKit the same pointer paths at the actual hit-tested
// element, then route motion and release to the canvas as pointer capture would.
async function touchPath(page, browserName) {
  const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined
  if (cdp) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
  let previous = []
  async function send(type, positions) {
    const points = positions.map((point, index) => ({ ...point, id: index + 1 }))
    if (cdp) await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
    else {
      const changed = type === 'touchStart' ? points.slice(previous.length) : type === 'touchEnd' ? previous : points
      const event = { touchStart: 'pointerdown', touchMove: 'pointermove', touchEnd: 'pointerup' }[type]
      await page.evaluate(({ event, changed }) => {
        const surface = document.querySelector('.story-canvas')
        const capture = surface.setPointerCapture
        // Synthetic pointer IDs are outside the OS pointer table.
        surface.setPointerCapture = () => {}
        try {
          for (const { x, y, id } of changed) {
            const target = event === 'pointerdown' ? document.elementFromPoint(x, y) : surface
            target.dispatchEvent(new PointerEvent(event, {
              bubbles: true, cancelable: true, pointerType: 'touch', pointerId: id + 100, isPrimary: id === 1,
              clientX: x, clientY: y, button: event === 'pointermove' ? -1 : 0, buttons: event === 'pointerup' ? 0 : 1,
            }))
          }
        } finally { surface.setPointerCapture = capture }
      }, { event, changed })
    }
    previous = points
  }
  return {
    start: (...points) => send('touchStart', points),
    move: (...points) => send('touchMove', points),
    end: () => send('touchEnd', []),
  }
}

async function expectTouchTarget(locator) {
  await expect.poll(() => locator.evaluate((item) => {
    const { x, y, width, height, right, bottom } = item.getBoundingClientRect()
    const board = item.closest('.story-canvas')?.getBoundingClientRect()
    const view = window.visualViewport
    const hits = [[.5, .5], [.045, .5], [.955, .5], [.5, .045], [.5, .955]]
    return {
      largeEnough: Math.round(width * 100) >= 4400 && Math.round(height * 100) >= 4400,
      inView: x >= (board?.left ?? 0) && y >= (board?.top ?? 0) &&
        right <= Math.min(board?.right ?? Infinity, view.width) && bottom <= Math.min(board?.bottom ?? Infinity, view.height),
      receivesTouch: hits.every(([u, v]) => item.contains(document.elementFromPoint(x + width * u, y + height * v))),
    }
  }), { message: `${locator} has a full, reachable 44 × 44 CSS-pixel touch area` })
    .toEqual({ largeEnough: true, inView: true, receivesTouch: true })
}

const links = (page) => expect.poll(async () => (await boardState(page)).scene.edges)
const hint = (page) => canvas(page).getByRole('status')

test('手机用连线模式、卡片菜单和连接点建关系，浮动工具条可直接改名 @webkit', async ({ page, browserName }) => {
  const { story, area } = await startBoard(page)
  const finger = await touchPath(story, browserName)
  await addByDoubleTap(story, area, '守灯人', { x: 88, y: 96 })
  await addByDoubleTap(story, area, '船长', { x: 88, y: 332 })
  const source = storyCard(story, '守灯人')
  const target = storyCard(story, '船长')
  const connect = action(story, '连线')
  await expectTouchTarget(action(story, '新建卡片'))
  await expectTouchTarget(connect)

  await connect.tap()
  await expect(hint(story)).toHaveText('点选起点卡片')
  await source.tap()
  await expect(hint(story)).toContainText('点选终点')
  await source.tap()
  await expect(hint(story)).toContainText('不能连接到起点本身')
  await links(story).toHaveLength(0)
  await target.tap()
  await links(story).toHaveLength(1)
  await expect(connect).toHaveAttribute('aria-pressed', 'false')
  await expect(hint(story)).toHaveText('已建立关系')
  await expect(cardPanel(story)).toBeHidden()
  const state = await boardState(story)
  const [a, b] = state.scene.nodes
  const edge = state.scene.edges[0]
  expect(edge).toMatchObject({ from: { nodeId: a.id, side: 'bottom' }, to: { nodeId: b.id, side: 'top' } })

  const tools = story.getByRole('group', { name: '关系操作' })
  await tapAt(story, { x: area.x + 25, y: area.y + 220 })
  await expect(tools).toBeHidden()
  const hit = await story.locator('.story-hit').evaluate((line) => {
    const box = line.getBoundingClientRect()
    return { x: box.x + box.width / 2 + 11, y: box.y + box.height / 2 }
  })
  await tapAt(story, hit)
  const rename = action(tools, '改名')
  const direction = tools.getByRole('combobox', { name: '箭头方向' })
  const style = tools.getByRole('combobox', { name: '线条样式' })
  await expectTouchTarget(rename)
  await expectTouchTarget(direction)
  await expectTouchTarget(style)
  await expectTouchTarget(action(tools, '删除关系'))
  await rename.tap()
  await canvas(story).getByRole('textbox', { name: '关系名称' }).fill('师徒')
  const save = action(canvas(story), '保存')
  await expectTouchTarget(save)
  await save.tap()
  await expect(story.locator('.story-edge-label')).toHaveText('师徒')
  await direction.selectOption('both')
  await links(story).toMatchObject([{ direction: 'both' }])
  await style.selectOption('dash')
  await links(story).toMatchObject([{ name: '师徒', direction: 'both', stroke: 'dash' }])

  await connect.tap()
  await story.keyboard.press('Escape')
  await expect(connect).toHaveAttribute('aria-pressed', 'false')
  await connect.tap()
  await connect.tap()
  await expect(connect).toHaveAttribute('aria-pressed', 'false')

  // The card menu can link to the padded hit area of an existing line.
  await target.tap()
  const more = action(story, '卡片操作')
  await expectTouchTarget(more)
  await more.tap()
  const connectTo = action(canvas(story), '连到…')
  await expectTouchTarget(connectTo)
  await connectTo.tap()
  await expect(hint(story)).toContainText('点选终点')
  expect(await story.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-edge-id]')?.getAttribute('data-edge-id'), hit)).toBe(edge.id)
  await tapAt(story, hit)
  await expect(hint(story)).toHaveText('已建立关系')
  await links(story).toMatchObject([{ id: edge.id }, { from: { nodeId: b.id }, to: { edgeId: edge.id } }])

  // Start well outside the visual dot. The bigger target must still start a line.
  await source.tap()
  const ports = source.locator('[data-port]')
  await expect(ports).toHaveCount(4)
  for (const port of await ports.all()) await expectTouchTarget(port)
  const port = await midpoint(source.locator('[data-port="bottom"]'))
  await finger.start({ x: port.x + 15, y: port.y + 5 })
  await expect(canvas(story)).toHaveAttribute('data-gesture', 'edge')
  await finger.move(await midpoint(target))
  await expect(hint(story)).toHaveText('松手连接到这里')
  await expect(target).toHaveClass(/story-link-target/)
  await finger.end()
  await links(story).toHaveLength(3)
  const linked = await boardState(story)
  expect(linked.scene.edges[2]).toMatchObject({ from: { nodeId: a.id, side: 'bottom' }, to: { nodeId: b.id } })
  expect(linked.scene.nodes).toEqual(state.scene.nodes)
  expect(linked.view).toEqual(state.view)

  await action(tools, '删除关系').tap()
  await links(story).toHaveLength(2)
  await expect(story.locator('dialog[open]')).toHaveCount(0)
})

test('手机单指移动卡片和平移画布，双指接管手势，拉线抵达边缘时滚动画布 @webkit', async ({ page, browserName }) => {
  const { story, area } = await startBoard(page)
  const finger = await touchPath(story, browserName)
  const create = action(story, '新建卡片')
  await expectTouchTarget(create)
  await create.tap()
  await fillNewCard(story, '旅客')
  await closeCard(story)
  const card = storyCard(story, '旅客')
  const initial = await boardState(story)
  const middle = await midpoint(card)
  await finger.start(middle)
  await finger.move({ x: middle.x + 31, y: middle.y + 25 })
  await finger.end()
  await expect.poll(async () => (await boardState(story)).scene.nodes[0].x).toBe(initial.scene.nodes[0].x + 31)
  const moved = await boardState(story)
  expect(moved).toMatchObject({ view: initial.view, scene: { edges: [], nodes: [{ y: initial.scene.nodes[0].y + 25 }] } })
  await expect(action(canvas(story), '连到…')).toBeHidden()

  const blank = { x: area.x + 37, y: area.y + 210 }
  await finger.start(blank)
  await finger.move({ x: blank.x + 18, y: blank.y + 27 })
  await finger.end()
  await expect.poll(async () => (await boardState(story)).view).toMatchObject({ x: moved.view.x + 18, y: moved.view.y + 27, zoom: 1 })
  const panned = await boardState(story)
  expect(panned.scene).toEqual(moved.scene)

  const center = await midpoint(card)
  await finger.start(center)
  const first = { x: center.x - 12, y: center.y }
  const second = { x: first.x + 78, y: first.y + 58 }
  await finger.move(first)
  await finger.start(first, second)
  await finger.move({ x: first.x - 44, y: first.y + 21 }, { x: second.x + 17, y: second.y + 43 })
  await finger.end()
  await expect.poll(async () => (await boardState(story)).view.zoom).toBeGreaterThan(1.4)
  const pinched = await boardState(story)
  expect(pinched.view.x).not.toBe(panned.view.x)
  expect(pinched.view.y).not.toBe(panned.view.y)
  expect(pinched.scene).toEqual(moved.scene)
  await expect(action(canvas(story), '连到…')).toBeHidden()

  // Verify all four targets after scaling the world below 1×. The user can
  // still grab the same area, and can hold the pointer at the viewport edge.
  const minus = action(story, '缩小')
  await expectTouchTarget(minus)
  for (let i = 0; i < 5; i++) await minus.tap()
  await expect.poll(async () => (await boardState(story)).view.zoom).toBeLessThan(.8)
  for (const port of await card.locator('[data-port]').all()) await expectTouchTarget(port)
  const beforeEdge = await boardState(story)
  const screenX = () => story.locator('.story-world').evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m41)
  expect(await screenX()).toBeCloseTo(beforeEdge.view.x)
  const handle = await midpoint(card.locator('[data-port="right"]'))
  await finger.start(handle)
  await finger.move({ x: area.x + area.width - 8, y: area.y + area.height * .45 })
  await expect.poll(screenX).toBeLessThan(beforeEdge.view.x - 20)
  await finger.end()
  await links(story).toHaveLength(1)
  const afterEdge = await boardState(story)
  expect(afterEdge.view.x).toBeLessThan(beforeEdge.view.x - 20)
  expect(afterEdge.scene.nodes[0]).toEqual(moved.scene.nodes[0])
  expect(afterEdge.scene.nodes[1].kind).toBe('text')
  expect(afterEdge.scene.edges[0]).toMatchObject({ from: { nodeId: moved.scene.nodes[0].id, side: 'right' }, to: { nodeId: afterEdge.scene.nodes[1].id } })
})

test('手机长按菜单可连线，框不可连接，减少动态效果时仍提示成功 @webkit', async ({ page, browserName }) => {
  const { story, area } = await startBoard(page)
  await story.emulateMedia({ reducedMotion: 'reduce' })
  const finger = await touchPath(story, browserName)
  await addByDoubleTap(story, area, '主角', { x: 83, y: 76 })
  await addByDoubleTap(story, area, '向导', { x: 83, y: 313 })
  const source = storyCard(story, '主角')
  const target = storyCard(story, '向导')
  await source.tap()
  await action(story, '分组框').tap()
  await closeCard(story)
  const frame = story.locator('.story-group-title')
  const before = await boardState(story)
  await finger.start(await midpoint(source))
  const menuItem = action(story, '连到…')
  await expect(menuItem).toBeVisible()
  await finger.end()
  await expectTouchTarget(menuItem)
  await menuItem.tap()
  await tapAt(story, await midpoint(frame))
  await expect(hint(story)).toContainText('分组框不能作为连线端点')
  await links(story).toHaveLength(0)
  // In link mode, dragging the source body also works and leaves the card still.
  await finger.start(await midpoint(source))
  await finger.move(await midpoint(target))
  await expect(target).toHaveClass(/story-link-target/)
  await finger.end()
  await expect(hint(story)).toHaveText('已建立关系')
  await expect(story.locator('.story-line')).toHaveCSS('animation-name', 'none')
  await links(story).toHaveLength(1)
  expect((await boardState(story)).scene.nodes).toEqual(before.scene.nodes)
})
