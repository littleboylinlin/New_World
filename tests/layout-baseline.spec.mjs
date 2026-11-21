import { expect, test } from './app-test.mjs'

async function seedCoverSample(page) {
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('new-world-library')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const tx = db.transaction(['books'], 'readwrite')
    const now = Date.now()
    tx.objectStore('books').put({ id: 'baseline-book-1', library: 'original', title: '基准线样本', format: 'draft', importedAt: now })
    localStorage.setItem('new-world:recent-works', JSON.stringify([
      { library: 'original', bookId: 'baseline-book-1', openedAt: now },
    ]))
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  })
}

test('各主页面共享对齐基准线变量，页头位置、左右留白与封面比例保持一致', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/#/')
  await expect(page.locator('.heatmap-grid .heat-cell')).toHaveCount(371)
  await seedCoverSample(page)
  await page.reload()
  await page.locator('.recent-projects').getByRole('button', { name: '封面' }).click()
  await expect(page.locator('.recent-covers .book-cover').first()).toBeVisible()

  const homeMetrics = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement)
    const pageRect = document.querySelector('.page').getBoundingClientRect()
    const homeRect = document.querySelector('.home-main').getBoundingClientRect()
    const cover = document.querySelector('.recent-covers .book-cover')
    const coverRect = cover.getBoundingClientRect()
    return {
      topbarHeight: rootStyle.getPropertyValue('--topbar-height').trim(),
      editorTopbarHeight: rootStyle.getPropertyValue('--editor-topbar-height').trim(),
      pageGutter: rootStyle.getPropertyValue('--page-gutter').trim(),
      pagePaddingTop: rootStyle.getPropertyValue('--page-padding-top').trim(),
      pageHeaderHeight: rootStyle.getPropertyValue('--page-header-height').trim(),
      coverRatioToken: rootStyle.getPropertyValue('--cover-ratio').trim(),
      homeGutterLeft: Math.round(homeRect.left - pageRect.left),
      homeCoverRatio: coverRect.width / coverRect.height,
    }
  })

  expect(homeMetrics.topbarHeight).toBe('46px')
  expect(homeMetrics.editorTopbarHeight).toBe('52px')
  expect(homeMetrics.pageGutter).toBe('32px')
  expect(homeMetrics.pagePaddingTop).toBe('24px')
  expect(homeMetrics.pageHeaderHeight).toBe('77px')
  expect(homeMetrics.coverRatioToken).toContain('3')
  expect(homeMetrics.homeGutterLeft).toBe(32)
  expect(Math.abs(homeMetrics.homeCoverRatio - 0.75)).toBeLessThan(0.02)

  const pages = [
    { url: '/#/writing', heading: '.page-heading', title: '.page-heading h1', container: '.main-content', checkCover: true },
    { url: '/#/notes/tasks', heading: '.page-heading', title: '.page-heading h1', container: '.main-content' },
    { url: '/#/notes/ideas', heading: '.page-heading', title: '.page-heading h1', container: '.main-content' },
    { url: '/#/archive', heading: '.page-heading', title: '.page-heading h1', container: '.main-content' },
    { url: '/#/trash', heading: '.page-heading', title: '.page-heading h1', container: '.main-content' },
    { url: '/#/settings', heading: '.settings-panel:not([hidden]) .settings-panel-header', title: '.settings-panel:not([hidden]) .settings-panel-header :is(h1, h2)', container: '.settings-content', paddingGutter: true },
  ]

  const snapshots = []
  for (const spec of pages) {
    await page.goto(spec.url)
    await expect(page.locator(spec.heading)).toBeVisible()
    if (spec.checkCover) await expect(page.locator('.book-card .book-cover').first()).toBeVisible()
    const metrics = await page.evaluate((s) => {
      const heading = document.querySelector(s.heading)
      const title = document.querySelector(s.title)
      const container = document.querySelector(s.container)
      const pageRect = document.querySelector('.page').getBoundingClientRect()
      const hRect = heading.getBoundingClientRect()
      const tRect = title.getBoundingClientRect()
      const cRectBox = container.getBoundingClientRect()
      const cover = s.checkCover ? document.querySelector('.book-card .book-cover') : null
      const cRect = cover ? cover.getBoundingClientRect() : null
      return {
        url: s.url,
        headingTop: Math.round(hRect.top),
        headingBottom: Math.round(hRect.bottom),
        headingHeight: Math.round(hRect.height),
        titleTop: Math.round(tRect.top),
        gutterLeft: s.paddingGutter ? parseFloat(getComputedStyle(container).paddingLeft) : Math.round(cRectBox.left - pageRect.left),
        coverRatio: cRect ? cRect.width / cRect.height : null,
      }
    }, spec)
    snapshots.push(metrics)
  }

  const base = snapshots[0]
  for (const snap of snapshots) {
    expect(Math.abs(snap.headingTop - base.headingTop), `${snap.url} headingTop`).toBeLessThanOrEqual(1)
    expect(Math.abs(snap.headingBottom - base.headingBottom), `${snap.url} headingBottom`).toBeLessThanOrEqual(1)
    expect(Math.abs(snap.headingHeight - base.headingHeight), `${snap.url} headingHeight`).toBeLessThanOrEqual(1)
    expect(Math.abs(snap.titleTop - base.titleTop), `${snap.url} titleTop`).toBeLessThanOrEqual(1)
    expect(snap.gutterLeft, `${snap.url} gutterLeft`).toBe(32)
  }
  expect(Math.abs(base.coverRatio - homeMetrics.homeCoverRatio)).toBeLessThan(0.02)
})

test('三种主题下卡片、热力图格子与封面都有清晰层次，暗色不糊成一片', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/#/')
  await expect(page.locator('.heatmap-grid .heat-cell')).toHaveCount(371)
  await seedCoverSample(page)
  await page.reload()
  await page.locator('.recent-projects').getByRole('button', { name: '封面' }).click()
  await expect(page.locator('.recent-covers .book-cover').first()).toBeVisible()

  for (const theme of ['white', 'dark', 'beige']) {
    await page.evaluate((nextTheme) => {
      localStorage.setItem('new-world:appearance', JSON.stringify({ theme: nextTheme }))
    }, theme)
    await page.reload()
    await expect(page.locator('.recent-covers .book-cover').first()).toBeVisible()

    const colors = await page.evaluate(() => {
      const htmlBg = getComputedStyle(document.documentElement).backgroundColor
      const statsBg = getComputedStyle(document.querySelector('.writing-stats')).backgroundColor
      const cellBg = getComputedStyle(document.querySelector('.heat-cell')).backgroundColor
      const cellBorder = getComputedStyle(document.querySelector('.heat-cell')).borderTopWidth
      const coverShadow = getComputedStyle(document.querySelector('.recent-covers .book-cover')).boxShadow
      return { htmlBg, statsBg, cellBg, cellBorder, coverShadow }
    })

    expect(colors.statsBg, `${theme}: stats card differs from canvas`).not.toBe(colors.htmlBg)
    expect(colors.cellBg, `${theme}: heat cell differs from stats card`).not.toBe(colors.statsBg)
    expect(parseFloat(colors.cellBorder), `${theme}: heat cell has crisp border`).toBeGreaterThan(0)
    expect(colors.coverShadow, `${theme}: cover has ring/shadow boundary`).not.toBe('none')
  }
})
