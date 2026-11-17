import { expect, test } from './app-test.mjs'
import { bookAction } from './fixtures.mjs'

const textArea = (page) => page.getByRole('textbox', { name: '章节正文' })
const total = (page) => page.locator('.stat-total .stat-value')
const streak = (page) => page.locator('.stat-streak .stat-value')
const tooltip = (page) => page.locator('.heat-tooltip')
const todayCell = (page) => page.locator('.heat-cell.today')

async function newNovel(page, name) {
  await page.getByRole('button', { name: '新建小说' }).click()
  await page.getByRole('textbox', { name: '作品名' }).fill(name)
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(textArea(page)).toBeVisible()
}

async function manualSave(page) {
  await page.getByRole('button', { name: '手动保存' }).click()
  await expect(page.locator('.save-status')).toHaveText('已保存')
}

async function goHome(page) {
  await page.getByRole('link', { name: '书库首页', exact: true }).click()
  await ready(page)
}

// The grid is only painted once the database has opened, so 371 cells means the schema is ready to seed.
// The panel then rises into place after a short delay; hovering before that lands on another day.
async function ready(page) {
  await expect(page.locator('.writing-stats')).toBeVisible()
  await expect(page.locator('.heatmap-grid .heat-cell')).toHaveCount(371)
  await page.locator('.writing-stats').evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)))
}

// Write past days straight into the global history store, then nudge the panel to re-read it.
async function seedDays(page, offsets) {
  const rows = await page.evaluate(async (entries) => {
    const key = (offset) => {
      const date = new Date()
      date.setDate(date.getDate() + offset)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('new-world-library')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction('writingDays', 'readwrite')
    const store = tx.objectStore('writingDays')
    const written = entries.map(([offset, words]) => {
      const date = key(offset)
      store.put({ date, words })
      return { date, words, offset }
    })
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    db.close()
    return written
  }, offsets)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  return rows
}

test('写作后首页显示总字数、连续天数与当日悬浮提示', async ({ page }) => {
  await page.goto('/#/original')
  await newNovel(page, '晨雾来信')
  await textArea(page).fill('第一封信从雾里来。')
  await manualSave(page)
  await goHome(page)
  await expect(total(page)).toHaveText('9')
  await expect(streak(page)).toHaveText('1')
  await expect(page.locator('.stats-hint')).toBeHidden()
  await expect(todayCell(page)).toHaveAttribute('data-words', '9')
  await expect(todayCell(page)).toHaveAttribute('data-level', '4')
  await todayCell(page).scrollIntoViewIfNeeded()
  await todayCell(page).hover()
  await expect(tooltip(page)).toBeVisible()
  await expect(tooltip(page)).toContainText('今天')
  await expect(tooltip(page)).toContainText('写了 9 字')
  await page.mouse.move(0, 0)
  await expect(tooltip(page)).toBeHidden()
  await page.reload()
  await ready(page)
  await expect(total(page)).toHaveText('9')
  await expect(todayCell(page)).toHaveAttribute('data-words', '9')
})

test('多日历史计算连续天数、峰值分级、过去日期提示与键盘导航', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  const seeded = await seedDays(page, [[0, 10], [-1, 20], [-2, 30], [-4, 40]])
  await expect(streak(page)).toHaveText('3')
  await expect(total(page)).toHaveText('0')
  await expect(page.locator('.stats-hint')).toBeHidden()
  await expect(page.locator(`.heat-cell[data-date="${seeded[0].date}"]`)).toHaveAttribute('data-level', '1')
  await expect(page.locator(`.heat-cell[data-date="${seeded[1].date}"]`)).toHaveAttribute('data-level', '2')
  await expect(page.locator(`.heat-cell[data-date="${seeded[2].date}"]`)).toHaveAttribute('data-level', '3')
  const peak = page.locator(`.heat-cell[data-date="${seeded[3].date}"]`)
  await expect(peak).toHaveAttribute('data-words', '40')
  await expect(peak).toHaveAttribute('data-level', '4')
  await peak.hover()
  await expect(tooltip(page)).toContainText('写了 40 字')
  await expect(tooltip(page)).not.toContainText('今天')

  await page.mouse.move(0, 0)
  await todayCell(page).focus()
  await expect(tooltip(page)).toContainText('今天')
  const before = await todayCell(page).getAttribute('data-week')
  await page.keyboard.press('ArrowLeft')
  const active = await page.evaluate(() => ({ week: document.activeElement.dataset.week, date: document.activeElement.dataset.date }))
  expect(active.week).toBe(String(Number(before) - 1))
  expect(active.date).not.toBe(seeded[0].date)
  await expect(tooltip(page)).toBeVisible()
})

test('空库显示引导提示，格子总数固定且没有高等级色块', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await expect(page.locator('.stats-hint')).toBeVisible()
  await expect(page.locator('.stats-hint')).toContainText('开始写作后')
  await expect(total(page)).toHaveText('0')
  await expect(streak(page)).toHaveText('0')
  await expect(todayCell(page)).toHaveAttribute('data-level', '0')
  await expect(page.locator('.heatmap-grid .heat-cell[data-level="4"]')).toHaveCount(0)
  const dow = await page.evaluate(() => (new Date().getDay() + 6) % 7)
  const future = page.locator('.heatmap-grid .heat-cell.future')
  await expect(future).toHaveCount(6 - dow)
  if (dow < 6) await expect(future.first()).toHaveAttribute('aria-hidden', 'true')
  await todayCell(page).hover()
  await expect(tooltip(page)).toContainText('没有写作')
  if (dow < 6) {
    await future.first().hover()
    await expect(tooltip(page)).toBeHidden()
  }
})

test('删除作品后总字数归零，但全局写作历史保留', async ({ page }) => {
  await page.goto('/#/original')
  await newNovel(page, '短暂的手稿')
  await textArea(page).fill('留下痕迹。')
  await manualSave(page)
  await goHome(page)
  await expect(total(page)).toHaveText('5')
  await expect(streak(page)).toHaveText('1')

  await page.goto('/#/original')
  await bookAction(page, '删除', '短暂的手稿')
  await page.getByRole('dialog', { name: '删除作品？' }).getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByText('还没有原创作品')).toBeVisible()

  await page.goto('/')
  await ready(page)
  await expect(total(page)).toHaveText('0')
  await expect(streak(page)).toHaveText('1')
  await expect(todayCell(page)).toHaveAttribute('data-words', '5')
})

test('v3 老库升级后总字数保留并新增 writingDays 与 ideas 存储', async ({ page }) => {
  await page.route('**/fixture-v3', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>V3 fixture</title>' }))
  await page.goto('/fixture-v3')
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('new-world-library', 3)
      request.onupgradeneeded = () => {
        const database = request.result
        const books = database.createObjectStore('books', { keyPath: ['library', 'id'] })
        books.createIndex('byLibrary', 'library')
        books.createIndex('byLibraryDigest', ['library', 'digest'], { unique: true })
        database.createObjectStore('files', { keyPath: ['library', 'id'] })
        const editions = database.createObjectStore('editions', { keyPath: ['library', 'bookId', 'id'] })
        editions.createIndex('byBook', ['library', 'bookId'])
        editions.createIndex('byName', ['library', 'bookId', 'name'], { unique: true })
        const chapters = database.createObjectStore('chapters', { keyPath: ['library', 'bookId', 'editionId', 'id'] })
        chapters.createIndex('byBook', ['library', 'bookId'])
        chapters.createIndex('byEdition', ['library', 'bookId', 'editionId'])
        database.createObjectStore('trash', { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction('chapters', 'readwrite')
    tx.objectStore('chapters').put({
      library: 'original', bookId: 'b1', editionId: 'e1', id: 'c1', revision: 1,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '旧库带来的文字。' }] }] },
    })
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    db.close()
  })
  await page.goto('/')
  await ready(page)
  await expect(total(page)).toHaveText('8')
  const stores = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('new-world-library')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const names = Array.from(db.objectStoreNames)
    db.close()
    return names
  })
  expect(stores).toContain('writingDays')
  expect(stores).toContain('ideas')
})

test('英文界面显示英文统计文案与提示', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('new-world:language', 'en'))
  await page.goto('/')
  await ready(page)
  await expect(page.locator('.writing-stats')).toHaveAttribute('aria-label', 'Writing stats')
  await expect(page.locator('.stat-streak .stat-label')).toHaveText('Day streak')
  await expect(page.locator('.stat-total .stat-label')).toHaveText('Total words')
  await expect(page.locator('.stats-hint')).toContainText('Start writing')
  await todayCell(page).hover()
  await expect(tooltip(page)).toContainText('Today · No writing')
})

test('英文正文按词计数，复用编辑器口径', async ({ page }) => {
  await page.goto('/#/original')
  await newNovel(page, 'English Draft')
  await textArea(page).fill('The quick brown fox jumps')
  await manualSave(page)
  await goHome(page)
  await expect(total(page)).toHaveText('5')
  await expect(todayCell(page)).toHaveAttribute('data-words', '5')
})

// Flush actual queued scroll/layout events, without sleeping past the hover/scroll race.
const layoutFrame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

async function expectTipInFront(page) {
  await expect(tooltip(page)).toBeVisible()
  await expect.poll(() => tooltip(page).evaluate((node) => {
    const rect = node.getBoundingClientRect()
    // Hit testing ignores pointer-events:none. Temporarily include the tooltip to test actual clipping/stacking.
    node.style.pointerEvents = 'auto'
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    node.style.pointerEvents = ''
    const view = visualViewport
    return rect.left >= (view?.offsetLeft ?? 0) && rect.top >= (view?.offsetTop ?? 0)
      && rect.right <= (view ? view.offsetLeft + view.width : innerWidth)
      && rect.bottom <= (view ? view.offsetTop + view.height : innerHeight) && hit === node
  })).toBe(true)
}

test('横向滚动后静止指针下的新日期仍显示提示，移入间隙或移出时隐藏', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await ready(page)
  const cell = page.locator('.heatmap-grid .heat-cell[data-week="51"][data-row="0"]')
  await cell.hover()
  await expect(tooltip(page)).toHaveText(await cell.getAttribute('aria-label'))
  const point = await cell.evaluate((node) => {
    const r = node.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  const before = await cell.getAttribute('data-date')
  await page.locator('.heatmap-grid-wrap').evaluate(async (node) => {
    const scrolled = new Promise((resolve) => node.addEventListener('scroll', resolve, { once: true }))
    node.scrollLeft -= 16
    await scrolled
  })
  await layoutFrame(page)
  const underPointer = await page.evaluate(({ x, y }) => {
    const node = document.elementFromPoint(x, y)?.closest('.heat-cell[data-date]')
    return { date: node?.dataset.date, label: node?.getAttribute('aria-label') }
  }, point)
  expect(underPointer.date).toBeTruthy()
  expect(underPointer.date).not.toBe(before)
  await expect(tooltip(page)).toHaveText(underPointer.label)
  await expectTipInFront(page)
  await page.mouse.move(point.x + 8, point.y)
  await expect(tooltip(page)).toBeHidden()
  await cell.hover()
  await page.mouse.move(0, 0)
  await expect(tooltip(page)).toBeHidden()
})

test('键盘聚焦引发自动滚动后提示保留，窗口刷新保留焦点并更新字数', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await ready(page)
  await page.mouse.move(0, 0)
  const oldest = page.locator('.heatmap-grid .heat-cell[data-date]').first()
  await oldest.focus()
  await layoutFrame(page)
  await expect(oldest).toBeFocused()
  await expect(tooltip(page)).toHaveText(await oldest.getAttribute('aria-label'))
  await page.keyboard.press('ArrowRight')
  const focused = page.locator('.heatmap-grid .heat-cell:focus')
  await expect(focused).toHaveAttribute('data-week', '1')
  await expect(tooltip(page)).toHaveText(await focused.getAttribute('aria-label'))
  await todayCell(page).focus()
  await layoutFrame(page)
  await seedDays(page, [[0, 12345]])
  await expect(todayCell(page)).toHaveAttribute('data-words', '12345')
  await expect(todayCell(page)).toBeFocused()
  await expect(tooltip(page)).toHaveText('今天 · 写了 12,345 字')
  // A real library update also refreshes the panel; opening its dialog must not leave the tooltip on top.
  await page.keyboard.press('Control+Alt+KeyN')
  const dialog = page.getByRole('dialog', { name: '记灵感', exact: true })
  await expect(dialog).toBeVisible()
  await expect(tooltip(page)).toBeHidden()
  await dialog.getByRole('textbox', { name: '灵感', exact: true }).fill('刷新统计时保留日期焦点')
  await dialog.getByRole('textbox', { name: '灵感', exact: true }).press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(todayCell(page)).toBeFocused()
  await expect(tooltip(page)).toHaveText('今天 · 写了 12,345 字')
  await page.locator('.heatmap-grid-wrap').evaluate((node) => { node.scrollLeft = 0 })
  await layoutFrame(page)
  await expect(tooltip(page)).toBeHidden()
  await page.getByRole('link', { name: '设置', exact: true }).focus()
  await expect(tooltip(page)).toBeHidden()
})

test('静止悬停时刷新数据更新提示并保留横向位置，离开首页清理提示', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await ready(page)
  const cell = page.locator('.heatmap-grid .heat-cell[data-week="10"][data-row="0"]')
  await cell.hover()
  const wrap = page.locator('.heatmap-grid-wrap')
  const left = await wrap.evaluate((node) => node.scrollLeft)
  await seedDays(page, [[0, 500]])
  await expect(todayCell(page)).toHaveAttribute('data-words', '500')
  expect(await wrap.evaluate((node) => node.scrollLeft)).toBe(left)
  await expect(tooltip(page)).toHaveText(await cell.getAttribute('aria-label'))
  await page.getByRole('link', { name: '进入原创库', exact: true }).click()
  await expect(tooltip(page)).toHaveCount(0)
  await expect(page.locator('.heat-tooltip:popover-open')).toHaveCount(0)
})

test('桌面滚动容器顶部的日期提示不会被标题栏裁切', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 900, height: 220 })
  await page.goto('/')
  await ready(page)
  await page.locator('html').evaluate((node) => node.classList.add('desktop'))
  const cell = page.locator('.heatmap-grid .heat-cell[data-week="51"][data-row="0"]')
  await cell.hover()
  await page.locator('.page').evaluate((node) => {
    const cell = document.querySelector('.heatmap-grid .heat-cell[data-week="51"][data-row="0"]')
    node.scrollTop += cell.getBoundingClientRect().top - node.getBoundingClientRect().top - 12
  })
  await cell.hover()
  await expect(tooltip(page)).toHaveText(await cell.getAttribute('aria-label'))
  await expectTipInFront(page)
  await page.screenshot({ path: info.outputPath('home-heatmap-desktop-top.png'), animations: 'disabled' })
})

test('首尾日期在缩放和窄视口中完整可见，视口变化后聚焦提示重新定位', async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('new-world:language', 'en'))
  await page.goto('/')
  await ready(page)
  const session = await page.context().newCDPSession(page)
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 420 })
    for (const cell of [page.locator('.heatmap-grid .heat-cell[data-date]').first(), todayCell(page)]) {
      await cell.focus()
      await layoutFrame(page)
      await expect(tooltip(page)).toHaveText(await cell.getAttribute('aria-label'))
      await expectTipInFront(page)
    }
    // Zoom changes the CSS viewport and pixel density, without changing the app's layout styles.
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: Math.floor(width / 1.5), height: 420, deviceScaleFactor: 1.5, mobile: false,
    })
    await todayCell(page).scrollIntoViewIfNeeded()
    await layoutFrame(page)
    await expectTipInFront(page)
    await page.screenshot({ path: info.outputPath(`home-heatmap-zoom-${width}.png`), animations: 'disabled' })
    await session.send('Emulation.clearDeviceMetricsOverride')
  }
})

test.describe('手机视口', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 })

  test('首页热力图无横向溢出，内部可横向滚动且点按显示提示', async ({ page }) => {
    await page.goto('/')
    await ready(page)
    await seedDays(page, [[0, 120], [-1, 80], [-2, 60]])
    await expect(streak(page)).toHaveText('3')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const wrap = page.locator('.heatmap-grid-wrap')
    expect(await wrap.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
    await todayCell(page).tap()
    await expect(tooltip(page)).toBeVisible()
    await expect(tooltip(page)).toContainText('写了 120 字')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})
