import { expect, test } from './app-test.mjs'

async function seedHomeWorkspace(page) {
  await expect(page.locator('.heatmap-grid .heat-cell')).toHaveCount(371)
  await expect(page.locator('.recent-projects .recent-content')).not.toBeEmpty()
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('new-world-library')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

    const tx = db.transaction(['books', 'ideas', 'writingDays'], 'readwrite')
    const books = tx.objectStore('books')
    const ideas = tx.objectStore('ideas')
    const days = tx.objectStore('writingDays')
    const now = Date.now()

    books.put({ id: 'orig-1', library: 'original', title: '海港灯塔', format: 'draft', importedAt: now - 5000 })
    books.put({ id: 'orig-2', library: 'original', title: '冬夜电报', format: 'draft', importedAt: now - 4000 })
    books.put({ id: 'ref-1', library: 'reference', title: '雾海航行记', format: 'draft', importedAt: now - 3000 })
    books.put({ id: 'arch-1', library: 'original', title: '归档旧稿', format: 'draft', importedAt: now - 9000, archivedAt: now - 500 })

    localStorage.setItem('new-world:recent-works', JSON.stringify([
      { library: 'original', bookId: 'orig-1', openedAt: now }, { library: 'reference', bookId: 'ref-1', openedAt: now - 1000 },
    ]))
    ideas.put({ id: 'idea-1', text: '凌晨四点钟楼停摆时的港口声音', createdAt: now - 2000 })
    ideas.put({ id: 'idea-2', text: '船长日志里被撕掉的一页', createdAt: now - 1000 })

    const today = new Date()
    for (let offset = -120; offset <= 0; offset++) {
      if (offset < -6 && offset % 4 !== 0) continue
      const date = new Date(today)
      date.setDate(today.getDate() + offset)
      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      days.put({ date: iso, words: offset === 0 ? 2450 : 600 + (Math.abs(offset) % 5) * 420 })
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.recent-list strong')).toHaveText(['海港灯塔', '雾海航行记'])
  await expect(page.locator('.home > section')).toHaveCount(3)
  await expect(page.locator('.heatmap-grid .heat-cell')).toHaveCount(371)
}

function inspectHomeGeometry(page) {
  return page.evaluate(() => {
    const doc = document.documentElement
    const scrollContainer = document.querySelector('.page')
    const home = document.querySelector('.home')
    const head = document.querySelector('.stats-top')
    const intro = document.querySelector('.stats-heading')
    const entries = document.querySelector('.stats-numbers')
    const cards = [...document.querySelectorAll('.recent-link')]
    const stats = document.querySelector('.writing-stats')
    const heatWrap = document.querySelector('.heatmap-grid-wrap')
    const header = document.querySelector('.site-header')
    const footer = document.querySelector('.site-footer')
    const settings = document.querySelector('#settings')

    const rect = (el) => el.getBoundingClientRect()
    const overlaps = (a, b) => !(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1)

    const hRect = rect(header)
    const homeRect = rect(home)
    const fRect = rect(footer)
    const cRects = cards.map(rect)
    const sRect = rect(stats)
    const introRect = rect(intro)
    const entriesRect = rect(entries)
    const settingsRect = rect(settings)

    return {
      innerWidth,
      innerHeight,
      docScrollWidth: doc.scrollWidth,
      docScrollHeight: doc.scrollHeight,
      pageScrollHeight: scrollContainer.scrollHeight,
      pageClientHeight: scrollContainer.clientHeight,
      heatWrapScrollWidth: heatWrap.scrollWidth,
      heatWrapClientWidth: heatWrap.clientWidth,
      cardsSideBySide: cRects.length === 2 && Math.abs(cRects[0].y - cRects[1].y) <= 2 && cRects[1].x > cRects[0].right - 2,
      cardsStacked: cRects.length === 2 && cRects[1].y >= cRects[0].bottom - 1,
      cardsOverlap: cRects.length === 2 && overlaps(cRects[0], cRects[1]),
      cardsStatsOverlap: cRects.some((c) => overlaps(c, sRect)),
      headEntriesOverlap: overlaps(introRect, entriesRect),
      homeHeaderOverlap: overlaps(homeRect, hRect),
      homeFooterOverlap: overlaps(homeRect, fRect),
      homeFitsAboveFooter: homeRect.bottom <= fRect.top + 1,
      headHeight: rect(head).height,
      settingsInViewport: settingsRect.left >= 0 && settingsRect.right <= innerWidth + 1 && settingsRect.bottom <= innerHeight + 1,
    }
  })
}

test('标准桌面尺寸首页一屏完整呈现且无纵向或横向滚动条（Web 与模拟桌面窗口）', async ({ page }, testInfo) => {
  for (const [label, size, desktopClass] of [
    ['web-1280x720', { width: 1280, height: 720 }, false],
    ['desktop-1220x850', { width: 1220, height: 850 }, true],
    ['desktop-1280x720', { width: 1280, height: 720 }, true],
  ]) {
    await page.setViewportSize(size)
    await page.goto('/')
    if (desktopClass) await page.evaluate(() => document.documentElement.classList.add('desktop'))
    await seedHomeWorkspace(page)

    await expect.poll(async () => {
      const g = await inspectHomeGeometry(page)
      return {
        ok: g.docScrollWidth <= g.innerWidth
          && g.docScrollHeight <= g.innerHeight + 1
          && g.pageScrollHeight <= g.pageClientHeight + 1
          && g.heatWrapScrollWidth <= g.heatWrapClientWidth + 1
          && g.cardsSideBySide
          && !g.cardsOverlap
          && !g.cardsStatsOverlap
          && !g.headEntriesOverlap
          && !g.homeHeaderOverlap
          && !g.homeFooterOverlap
          && g.homeFitsAboveFooter
          && g.settingsInViewport,
      }
    }).toEqual({ ok: true })

    await page.screenshot({ path: testInfo.outputPath(`home-${label}.png`), animations: 'disabled' })
  }
})

test('深色、暖纸与米白主题在桌面一屏布局下保持完整展示与对比协调', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await page.evaluate(() => document.documentElement.classList.add('desktop'))
  await seedHomeWorkspace(page)

  for (const theme of ['white', 'dark', 'beige']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value
    }, theme)
    await expect.poll(async () => {
      const g = await inspectHomeGeometry(page)
      return g.docScrollHeight <= g.innerHeight + 1
        && g.pageScrollHeight <= g.pageClientHeight + 1
        && g.cardsSideBySide
        && g.homeFitsAboveFooter
    }).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`home-theme-${theme}-1280x720.png`), animations: 'disabled' })
  }
})

test('英文桌面首页在标准窗口下同样保持单屏与无挤压', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ locale: 'en-US' })
  await context.route('https://api.github.com/repos/littleboylinlin/New_World/releases/latest', (route) => (
    route.fulfill({ status: 404, json: { message: 'Not Found' }, headers: { 'access-control-allow-origin': '*' } })
  ))
  const page = await context.newPage()
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Writing stats' })).toBeVisible()
  await page.evaluate(() => document.documentElement.classList.add('desktop'))
  await seedHomeWorkspace(page)

  await expect.poll(async () => {
    const g = await inspectHomeGeometry(page)
    return g.docScrollWidth <= g.innerWidth
      && g.docScrollHeight <= g.innerHeight + 1
      && g.pageScrollHeight <= g.pageClientHeight + 1
      && g.cardsSideBySide
      && !g.headEntriesOverlap
      && g.homeFitsAboveFooter
  }).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('home-english-1280x720.png'), animations: 'disabled' })
  await context.close()
})

test('窄桌面与移动端视口自然堆叠，零横向溢出且元素不遮挡', async ({ page }, testInfo) => {
  await page.goto('/')
  await seedHomeWorkspace(page)

  for (const [label, size] of [
    ['desktop-min-480x420', { width: 480, height: 420 }],
    ['mobile-390x844', { width: 390, height: 844 }],
    ['narrow-320x420', { width: 320, height: 420 }],
  ]) {
    await page.setViewportSize(size)
    await expect.poll(async () => {
      const g = await inspectHomeGeometry(page)
      return g.docScrollWidth <= g.innerWidth
        && g.cardsStacked
        && !g.cardsOverlap
        && !g.cardsStatsOverlap
        && !g.headEntriesOverlap
    }).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`home-${label}.png`), animations: 'disabled' })
  }
})
