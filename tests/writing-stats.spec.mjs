import { expect, test } from './app-test.mjs'

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
  await expect(page.locator('.writing-stats')).toBeVisible()
  await expect(page.locator('.heatmap-grid .heat-cell')).toHaveCount(371)
}

// The grid is only painted once the database has opened, so 371 cells means the schema is ready to seed.
async function ready(page) {
  await expect(page.locator('.writing-stats')).toBeVisible()
  await expect(page.locator('.heatmap-grid .heat-cell')).toHaveCount(371)
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
      const request = indexedDB.open('new-world-library', 4)
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
  // Today sits at the scrolled right edge; settle the auto-scroll so hovering does not re-trigger hide-on-scroll.
  await todayCell(page).scrollIntoViewIfNeeded()
  await page.waitForTimeout(150)
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

  // Let any scroll/pointer event from the hover settle so it cannot hide a later focus tooltip.
  await page.mouse.move(0, 0)
  await page.waitForTimeout(150)
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
  await expect(page.locator('.heatmap-grid .heat-cell.future').first()).toHaveAttribute('aria-hidden', 'true')
  await todayCell(page).hover()
  await expect(tooltip(page)).toContainText('没有写作')
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
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog', { name: '删除作品？' }).getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByText('还没有原创作品')).toBeVisible()

  await page.goto('/')
  await ready(page)
  await expect(total(page)).toHaveText('0')
  await expect(streak(page)).toHaveText('1')
  await expect(todayCell(page)).toHaveAttribute('data-words', '5')
})

test('v3 老库升级到 v4 后总字数保留并新增 writingDays 存储', async ({ page }) => {
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
      const request = indexedDB.open('new-world-library', 4)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const names = Array.from(db.objectStoreNames)
    db.close()
    return names
  })
  expect(stores).toContain('writingDays')
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
