import { devices } from '@playwright/test'
import { test, expect } from './app-test.mjs'
import {
  action, arrow, boardState, canvas, card, edgeGeometry, edgeMiddle, expectOnOutline, inlineField, intersects, liveView, newStoryWork,
  openStoryWindow, props, seedBoard, status, storyCard, toPage, tool, toolbar,
} from './story-settings-helpers.mjs'

// WebKit runs as an iPhone, Chromium as an Android phone.
test.use({
  contextOptions: async ({ browserName }, use) => {
    const phone = devices[browserName === 'webkit' ? 'iPhone 13' : 'Pixel 7']
    await use(phone)
  },
})
test.setTimeout(90_000)

async function startBoard(page, scene, view) {
  await page.goto('/#/writing')
  await newStoryWork(page, '触屏故事设定')
  const story = await openStoryWindow(page)
  expect(await story.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true)
  if (scene) await seedBoard(story, { tags: [], edges: [], ...scene }, view)
  const area = await canvas(story).boundingBox()
  return { story, area }
}

async function tapAt(page, { x, y }) { await page.touchscreen.tap(x, y) }
async function doubleTap(page, point) {
  await tapAt(page, point)
  await tapAt(page, point)
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
    /** One finger from a to b in a few steps. */
    async swipe(from, to, steps = 5) {
      await send('touchStart', [from])
      for (let i = 1; i <= steps; i++) await send('touchMove', [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }])
      // Rest before lifting, as a finger does; otherwise Chromium starts a fling and swallows the next tap's click.
      await page.waitForTimeout(80)
      await send('touchMove', [to])
      await send('touchEnd', [])
    },
  }
}

/** A control a finger can hit: at least 44 × 44 CSS pixels, inside the screen, and not covered. */
async function expectTouchTarget(locator) {
  await expect.poll(() => locator.evaluate((item) => {
    const { x, y, width, height, right, bottom } = item.getBoundingClientRect()
    const view = window.visualViewport
    const hits = [[.5, .5], [.06, .5], [.94, .5], [.5, .06], [.5, .94]]
    return {
      largeEnough: Math.round(width) >= 44 && Math.round(height) >= 44,
      inView: x >= 0 && y >= 0 && right <= view.width && bottom <= view.height,
      receivesTouch: hits.every(([u, v]) => item.contains(document.elementFromPoint(x + width * u, y + height * v))),
    }
  }), { message: `${locator} has a full, reachable 44 × 44 touch area` }).toEqual({ largeEnough: true, inView: true, receivesTouch: true })
}

/** A small handle whose invisible hit area reaches 18 px out in every direction. */
async function expectHandleReach(locator) {
  const reach = await locator.evaluate((item) => {
    const box = item.getBoundingClientRect()
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    return [[0, 0], [18, 0], [-18, 0], [0, 18], [0, -18]].every(([dx, dy]) => item.contains(document.elementFromPoint(x + dx, y + dy)))
  })
  expect(reach).toBe(true)
}

/** A spot on the bare board, clear of cards and floating controls, with room below and to the right. */
async function blankPoint(page) {
  const point = await page.evaluate(() => {
    const surface = document.querySelector('.story-canvas')
    const box = surface.getBoundingClientRect()
    for (let y = box.top + 80; y < box.bottom - 260; y += 20) for (let x = box.left + 40; x < box.right - 100; x += 20) {
      // Keep a finger's width from any card: touch input snaps to nearby buttons.
      const clear = [[0, 0], [-24, -24], [24, -24], [-24, 24], [24, 24], [-30, 20], [-40, 30], [60, 110]].every(([dx, dy]) => document.elementFromPoint(x + dx, y + dy) === surface)
      if (clear) return { x, y }
    }
  })
  if (!point) throw new Error('No blank spot on the board')
  return point
}

const middle = async (page, node) => toPage(page, { x: node.x + node.width / 2, y: node.y + node.height / 2 })
const links = (page) => expect.poll(async () => (await boardState(page)).scene.edges)

test('手机工具岛一排放在底部，双击空白建卡、双击卡片改名，属性面板不压住卡片 @webkit', async ({ page }) => {
  const near = card('near', '灯塔', 40, 400, { body: '只在夜里亮。', aliases: ['北灯'] })
  const { story } = await startBoard(page, { nodes: [near] })
  const bar = toolbar(story)
  const layout = await bar.evaluate((element) => {
    const items = [...element.querySelectorAll('button')].map((item) => item.getBoundingClientRect())
    const box = element.getBoundingClientRect()
    return {
      count: items.length, rows: new Set(items.map((item) => Math.round(item.top))).size, scroll: element.scrollWidth - element.clientWidth,
      inside: box.left >= 0 && box.right <= innerWidth, fromBottom: innerHeight - box.bottom, top: box.top,
    }
  })
  expect(layout).toMatchObject({ count: 8, rows: 1, scroll: 0, inside: true })
  expect(layout.fromBottom).toBeLessThan(40)
  expect(layout.top).toBeGreaterThan(innerHeight(story) / 2)
  for (const name of ['选择', '平移', '卡片', '箭头', '文字', '分组框', '图片', '橡皮擦']) await expectTouchTarget(tool(story, name))
  await expect(props(story)).toBeHidden()

  // Double-tap the background for a card; double-tap a card to rename it.
  const area = await canvas(story).boundingBox()
  await doubleTap(story, { x: area.x + 200, y: area.y + 220 })
  await inlineField(story).fill('守灯人')
  await inlineField(story).press('Enter')
  await expect(storyCard(story, '守灯人')).toBeVisible()
  await expect.poll(async () => (await boardState(story)).scene.nodes).toHaveLength(2)
  await canvas(story).press('Escape')
  await doubleTap(story, await middle(story, near))
  await expect(inlineField(story)).toHaveValue('灯塔')
  await inlineField(story).fill('旧灯塔')
  await inlineField(story).press('Enter')
  await expect(storyCard(story, '旧灯塔')).toBeVisible()

  // The card near the bottom is selected: the sheet takes the other side or the board moves, never covering it.
  await canvas(story).press('Escape')
  await tapAt(story, await middle(story, near))
  const sheet = props(story)
  await expect(sheet).toBeVisible()
  await expect(sheet).toContainText('只在夜里亮。')
  await expect(sheet).toContainText('北灯')
  await expect.poll(async () => intersects(await sheet.boundingBox(), await storyCard(story, '旧灯塔').boundingBox())).toBe(false)
  await expectTouchTarget(action(sheet, '编辑卡片'))
  await expectTouchTarget(action(sheet, '删除'))
  // The card shows its name only; the details stay in the sheet.
  await expect(storyCard(story, '旧灯塔')).not.toContainText('只在夜里亮')
})

function innerHeight(page) { return page.viewportSize().height }

test('手机手势：单指在空白处框选或平移，双指缩放，单指拖动卡片，互不干扰 @webkit', async ({ page, browserName }) => {
  const a = card('a', '主角', 60, 140)
  const b = card('b', '向导', 60, 420)
  const { story } = await startBoard(page, { nodes: [a, b] })
  const finger = await touchPath(story, browserName)
  const initial = await boardState(story)

  // One finger on the background with the select tool draws a marquee.
  await finger.swipe(await toPage(story, { x: 30, y: 110 }), await toPage(story, { x: 300, y: 300 }))
  await expect(storyCard(story, '主角')).toHaveAttribute('aria-pressed', 'true')
  await expect(storyCard(story, '向导')).toHaveAttribute('aria-pressed', 'false')
  expect(await boardState(story)).toEqual(initial)

  // With the hand tool, the same swipe pans and keeps the selection.
  await tool(story, '平移').tap()
  await expect(tool(story, '平移')).toHaveAttribute('aria-pressed', 'true')
  const before = await liveView(story)
  await finger.swipe(await toPage(story, { x: 320, y: 360 }), await toPage(story, { x: 350, y: 400 }))
  await expect.poll(async () => { const { x, y } = (await boardState(story)).view; return { x: x - before.x, y: y - before.y } }).toEqual({ x: 30, y: 40 })
  expect((await boardState(story)).scene).toEqual(initial.scene)
  await expect(storyCard(story, '主角')).toHaveAttribute('aria-pressed', 'true')

  // One finger on a card moves the card, not the board.
  await tool(story, '选择').tap()
  await canvas(story).press('Escape')
  const panned = await boardState(story)
  await finger.swipe(await middle(story, b), { ...(await middle(story, b)), x: (await middle(story, b)).x + 40 })
  await expect.poll(async () => (await boardState(story)).scene.nodes[1].x).toBe(b.x + 40)
  expect((await boardState(story)).view).toEqual(panned.view)

  // Two fingers zoom and pan; the card under the first finger stays put.
  const moved = await boardState(story)
  const start = await middle(story, moved.scene.nodes[0])
  await finger.start(start)
  await finger.start(start, { x: start.x + 60, y: start.y + 60 })
  await finger.move({ x: start.x - 30, y: start.y - 20 }, { x: start.x + 110, y: start.y + 120 })
  await finger.end()
  await expect.poll(async () => (await boardState(story)).view.zoom).toBeGreaterThan(1.3)
  expect((await boardState(story)).scene).toEqual(moved.scene)
  await expect(canvas(story).locator('.story-marquee')).toBeHidden()

  // A second finger that joins a marquee cancels it, so pinching never leaves a stray selection.
  await canvas(story).press('Escape')
  const blank = await blankPoint(story)
  await finger.start(blank)
  await finger.move({ x: blank.x - 20, y: blank.y + 30 })
  await finger.start({ x: blank.x - 20, y: blank.y + 30 }, { x: blank.x + 40, y: blank.y + 90 })
  await finger.move({ x: blank.x - 30, y: blank.y + 20 }, { x: blank.x + 60, y: blank.y + 110 })
  await finger.end()
  await expect(story.locator('.story-node[aria-pressed="true"]')).toHaveCount(0)
  expect((await boardState(story)).scene).toEqual(moved.scene)
})

test('手机箭头：从卡片拖到另一张卡时高亮并建立关系，拖端点改连，重复关系提示，拖到边缘自动滚动 @webkit', async ({ page, browserName }) => {
  const a = card('a', '守灯人', 40, 120)
  const b = card('b', '船长', 120, 420)
  const c = card('c', '雾港', 140, 700)
  const { story, area } = await startBoard(page, { nodes: [a, b, c] })
  const finger = await touchPath(story, browserName)
  await tool(story, '箭头').tap()
  const from = await middle(story, a)
  const to = await middle(story, b)
  await finger.start(from)
  await finger.move({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 })
  await finger.move(to)
  await expect(storyCard(story, '船长')).toHaveClass(/story-bind-target/)
  await finger.end()
  await links(story).toEqual([expect.objectContaining({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })])
  await expect(tool(story, '选择')).toHaveAttribute('aria-pressed', 'true')
  const [edge] = (await boardState(story)).scene.edges
  const drawn = await edgeGeometry(story, edge.id)
  expectOnOutline(a, drawn.from)
  expectOnOutline(b, drawn.to)

  // Tap the arrow, then drag its end handle onto another card.
  await tapAt(story, await edgeMiddle(story, edge.id))
  await expect(story.locator(`[data-edge-id="${edge.id}"]`)).toHaveClass(/selected/)
  const handle = story.locator('[data-end="to"]')
  await expectHandleReach(handle)
  const grab = await handle.boundingBox()
  await finger.swipe({ x: grab.x + grab.width / 2 + 12, y: grab.y + grab.height / 2 }, await middle(story, c))
  await links(story).toEqual([expect.objectContaining({ id: edge.id, to: { nodeId: 'c' } })])

  // The same relation again is refused, with a button to add it anyway.
  await tool(story, '箭头').tap()
  await expect(tool(story, '箭头')).toHaveAttribute('aria-pressed', 'true')
  await finger.swipe(await middle(story, a), await middle(story, c))
  await expect(status(story)).toContainText('已经有这个关系了')
  await links(story).toHaveLength(1)
  const again = action(status(story), '仍然新建')
  await expectTouchTarget(again)
  await again.tap()
  await links(story).toHaveLength(2)
  const [first, second] = (await boardState(story)).scene.edges
  const gap = (await edgeGeometry(story, first.id)).mid
  const other = (await edgeGeometry(story, second.id)).mid
  expect(Math.hypot(gap.x - other.x, gap.y - other.y)).toBeGreaterThan(30)

  // Holding an arrow at the screen's edge scrolls the board smoothly, however long it is held.
  await tool(story, '箭头').tap()
  await expect(tool(story, '箭头')).toHaveAttribute('aria-pressed', 'true')
  await story.evaluate(() => {
    let last = performance.now()
    window.storyFrames = []
    const tick = (now) => { window.storyFrames.push(now - last); last = now; if (window.storyFrames.length < 600) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
  const before = await liveView(story)
  await finger.start(await middle(story, b))
  await finger.move({ x: area.x + area.width - 4, y: area.y + area.height * .4 })
  await expect.poll(async () => (await liveView(story)).x).toBeLessThan(before.x - 20)
  await story.waitForTimeout(1500)
  await finger.end()
  await links(story).toHaveLength(3)
  expect(await story.evaluate(() => Math.max(...window.storyFrames))).toBeLessThan(250)
})

test('手机缩放到 50% 时线宽、箭头、关系名够大，线的可点区域更宽 @webkit', async ({ page }) => {
  const a = card('a', '守灯人', 40, 100)
  const b = card('b', '船长', 380, 600)
  const { story } = await startBoard(page, { nodes: [a, b], edges: [arrow('link', 'a', 'b', { name: '师徒' })] }, { x: 20, y: 40, zoom: .5 })
  const sizes = await story.locator('[data-edge-id="link"]').evaluate((group) => {
    const zoom = .5
    const head = group.querySelector('.story-head').getBoundingClientRect()
    const label = group.querySelector('.story-edge-label')
    return {
      line: Number(group.querySelector('.story-line').getAttribute('stroke-width')) * zoom,
      head: Math.max(head.width, head.height),
      font: Number(label.getAttribute('font-size')) * zoom,
      hit: Number(group.querySelector('.story-hit').getAttribute('stroke-width')) * zoom,
    }
  })
  expect(sizes.line).toBeGreaterThanOrEqual(2.4)
  expect(sizes.head).toBeGreaterThanOrEqual(10)
  expect(sizes.font).toBeGreaterThanOrEqual(12)
  expect(sizes.hit).toBeGreaterThanOrEqual(28)
  // Tap 12 px beside the line, away from its name.
  const line = await edgeGeometry(story, 'link')
  const along = await toPage(story, { x: line.from.x + (line.to.x - line.from.x) * .3, y: line.from.y + (line.to.y - line.from.y) * .3 })
  const length = Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y)
  await tapAt(story, { x: along.x - (line.to.y - line.from.y) / length * 12, y: along.y + (line.to.x - line.from.x) / length * 12 })
  await expect(story.locator('[data-edge-id="link"]')).toHaveClass(/selected/)
})
