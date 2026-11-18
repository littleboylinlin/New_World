import { expect, test } from './app-test.mjs'
import { databaseSnapshot } from './project-fixture.mjs'
import { createLegacyDatabase } from './legacy-database.mjs'
import { startWork } from './navigation-helpers.mjs'

const titles = ['雾港来信', '旅人手记', '北岸的钟楼', '群星入海', '午后的渡口', '林中电台', '月台故事', '旧城地图', '山谷回声', '白石桥']
const id = (index) => '10000000-0000-4000-8000-' + String(index).padStart(12, '0')
async function legacyProfile(page, count = 4) {
  await page.goto('/appearance.js')
  await page.evaluate(createLegacyDatabase, 9)
  await page.evaluate(async (books) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('new-world-library')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const tx = db.transaction(['books', 'ideas', 'tasks', 'writingDays'], 'readwrite')
    const now = Date.now()
    for (const [index, book] of books.entries()) tx.objectStore('books').put({ ...book, format: 'draft', importedAt: now - index * 86400000 })
    for (const [index, text] of ['潮水退去以后，钟楼下露出了另一条街。', '给旅人留一封没有署名的信。'].entries()) {
      tx.objectStore('ideas').put({ id: crypto.randomUUID(), text, createdAt: now - index * 3600000 })
    }
    tx.objectStore('tasks').put({
      id: crypto.randomUUID(), title: '核对雾港的潮汐表', description: '', notes: '', projectId: null, sectionId: null, parentId: null,
      priority: 2, labelIds: [], order: 1024, expanded: true, planDate: null, completedAt: null, deletedAt: null,
      createdAt: now, updatedAt: now, revision: 0,
    })
    for (let n = 0; n < 100; n++) {
      if (n > 3 && n % 3 === 0) continue
      const date = new Date(now)
      date.setDate(date.getDate() - n)
      tx.objectStore('writingDays').put({ date: date.toLocaleDateString('sv-SE'), words: 220 + (n % 6) * 250 })
    }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    db.close()
    localStorage.setItem('new-world:recent-works', JSON.stringify(books.slice(0, 3).map(({ library, id }) => ({ library, bookId: id }))))
  }, titles.slice(0, count).map((title, i) => ({ title, id: id(i), library: i % 2 ? 'reference' : 'original' })))
  const before = await page.evaluate(databaseSnapshot)
  await page.goto('/#/')
  await expect(page.locator('.recent-list li')).toHaveCount(3)
  return before
}

test('从旧书库启动，浏览两类作品、灵感与任务保留全部记录，详情和旧路由可用', async ({ page }) => {
  const before = await legacyProfile(page)
  await expect(page.locator('.recent-list time')).toHaveCount(0)
  for (const [path, filter, names] of [['original', 'original', [titles[0], titles[2]]], ['reference', 'reference', [titles[1], titles[3]]]]) {
    await page.goto('/#/' + path)
    await expect(page).toHaveURL(/#\/writing$/)
    await expect(page.locator('[data-filter="' + filter + '"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.book-name')).toHaveText(names)
    await page.locator('.book-link').first().click()
    await expect(page).toHaveURL(new RegExp('#/' + path + '/' + id(path === 'original' ? 0 : 1) + '$'))
    await expect(page.locator('.reader-page h1')).toHaveText(names[0])
  }
  await page.goto('/#/ideas')
  await expect(page).toHaveURL(/#\/notes\/ideas$/)
  await expect(page.locator('.idea-text')).toHaveCount(2)
  await page.goto('/#/tasks')
  await expect(page).toHaveURL(/#\/notes\/tasks$/)
  await expect(page.locator('.task-title')).toHaveText('核对雾港的潮汐表')
  expect(await page.evaluate(databaseSnapshot)).toEqual(before)
})

test('侧栏按顺序接受键盘焦点，标记当前页，记住宽度，在作品内暂时收起', async ({ page }) => {
  await legacyProfile(page)
  const links = page.locator('#app-nav a')
  await expect(links.locator('.sidebar-label')).toHaveText(['主页', '写作', '灵感与任务', '归档', '回收站', '设置'])
  for (let i = 0; i < 6; i++) {
    if (i === 0) await page.locator('#sidebar-toggle').focus()
    else await links.nth(i - 1).focus()
    await page.keyboard.press('Tab')
    await expect(links.nth(i)).toBeFocused()
    expect(await links.nth(i).evaluate((n) => getComputedStyle(n).outlineStyle)).toBe('solid')
    await page.keyboard.press('Enter')
    await expect(links.nth(i)).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('#app-nav a[aria-current]')).toHaveCount(1)
  }
  const toggle = page.locator('#sidebar-toggle')
  await toggle.click()
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#trash-link')).toHaveAttribute('title', '回收站')
  for (const preference of ['false', 'true']) {
    await page.locator('#home-link').click()
    if (preference === 'true') await toggle.click()
    await page.locator('.recent-link').first().click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('#writing-link')).toHaveAttribute('aria-current', 'page')
    await page.locator('#home-link').click()
    await expect(toggle).toHaveAttribute('aria-expanded', preference)
  }
})

test('手机抽屉由左上角打开，点击外部、Esc 或选择入口后关闭', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let releaseLanguage
  const hold = new Promise((resolve) => { releaseLanguage = resolve })
  const pack = '**/New-World-lang-zh-CN.json*'
  await page.route(pack, async (route) => { await hold; await route.continue() })
  const loading = page.waitForRequest(pack)
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await loading
  try {
    await expect(page.locator('#drawer-toggle')).toBeDisabled()
    await expect(page.locator('#sidebar-toggle')).toBeDisabled()
  } finally { releaseLanguage() }
  const menu = page.getByRole('button', { name: '打开导航' })
  await expect(menu).toBeEnabled()
  for (const action of ['outside', 'escape', 'writing']) {
    await menu.click()
    await expect(page.locator('#home-link')).toBeFocused()
    if (action === 'outside') await page.mouse.click(370, 140)
    if (action === 'escape') await page.keyboard.press('Escape')
    if (action === 'writing') await page.locator('#writing-link').click()
    await expect(page.locator('#app-sidebar')).toBeHidden()
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
  }
  await expect(page.getByRole('heading', { name: '写作', exact: true })).toBeVisible()
})

test('最近项目保留八部和真实时间，写作搜索、排序与类型筛选适用于合并书架', async ({ page }) => {
  await legacyProfile(page, titles.length)
  for (let i = 0; i < titles.length; i++) {
    await page.goto('/#/' + (i % 2 ? 'reference' : 'original') + '/' + id(i))
    await expect(page.locator('.reader-page h1')).toHaveText(titles[i])
  }
  await page.locator('#home-link').click()
  await expect(page.locator('.recent-link strong')).toHaveText(titles.slice(-8).reverse())
  await expect(page.locator('.recent-link time')).toHaveCount(8)
  const stamps = await page.locator('.recent-link time').evaluateAll((nodes) => nodes.map((n) => n.dateTime))
  expect(stamps).toEqual([...stamps].sort().reverse())
  await page.locator('.recent-link').first().click()
  await expect(page).toHaveURL(new RegExp('#/reference/' + id(9) + '$'))
  await page.locator('#writing-link').click()
  const names = page.locator('.book-name')
  await expect(names).toHaveText(titles)
  await page.getByLabel('作品排序').selectOption('opened')
  await expect(names).toHaveText([...titles].reverse())
  await page.getByLabel('作品排序').selectOption('title')
  const sorted = await page.evaluate((names) => names.sort((a, b) => a.localeCompare(b, 'zh-CN')), titles)
  await expect(names).toHaveText(sorted)
  await page.getByRole('button', { name: '续写·仿写', exact: true }).click()
  await page.reload()
  await expect(page.getByLabel('作品排序')).toHaveValue('title')
  await expect(page.locator('[data-filter="reference"]')).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('searchbox').fill('群星')
  await expect(names).toHaveText(['群星入海'])
  await expect(page.locator('.book-card .work-type')).toHaveText('续写·仿写')
  await startWork(page, 'original')
  await expect(page.getByRole('dialog', { name: '新建小说' })).toBeVisible()
})

test('两边独立保留查询、任务筛选和视图，转换后直接定位到新任务', async ({ page }) => {
  await legacyProfile(page)
  await page.locator('#notes-link').click()
  await page.getByLabel('搜索灵感正文').fill('旅人')
  await expect(page.locator('.idea-row')).toHaveCount(1)
  await page.getByRole('link', { name: '任务', exact: true }).click()
  const allTasks = page.locator('.task-nav a[href="#/notes/tasks/all"]')
  await allTasks.click()
  await expect(allTasks).toHaveAttribute('aria-current', 'page')
  const query = page.locator('.task-toolbar input[type=search]')
  await query.fill('雾港')
  await expect(query).toHaveValue('雾港')
  await page.getByLabel('任务视图', { exact: true }).selectOption('table')
  await expect(page.getByRole('table')).toBeVisible()
  await page.getByRole('link', { name: '灵感', exact: true }).click()
  await expect(page.getByLabel('搜索灵感正文')).toHaveValue('旅人')
  await page.getByRole('link', { name: '任务', exact: true }).click()
  await expect(page).toHaveURL(/#\/notes\/tasks\/all$/)
  await expect(query).toHaveValue('雾港')
  await expect(page.getByRole('table')).toContainText('核对雾港的潮汐表')
  await page.goto('/#/notes')
  await expect(page.locator('.segment[aria-current]')).toHaveText('任务')
  await page.getByRole('link', { name: '灵感', exact: true }).click()
  await page.locator('.idea-row').last().locator('.book-menu-toggle').click()
  await page.getByRole('menuitem', { name: '将灵感转换为任务' }).click()
  const dialog = page.getByRole('dialog', { name: '添加任务' })
  const title = await dialog.getByLabel('任务标题', { exact: true }).inputValue()
  await dialog.getByRole('button', { name: '保存任务' }).click()
  await expect(page).toHaveURL(/#\/notes\/tasks\/item\/[a-f0-9-]{36}$/)
  await expect(page.locator('.task-title')).toHaveText(title)
})

for (const theme of ['white', 'dark']) test('导航截图 · ' + theme, async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await legacyProfile(page)
  await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme)
  for (let i = 0; i < 3; i++) {
    await page.goto('/#/' + (i % 2 ? 'reference' : 'original') + '/' + id(i))
    await expect(page.locator('.reader-page h1')).toHaveText(titles[i])
  }
  for (const [view, route, ready] of [
    ['home', '#/', '.recent-list time'], ['writing', '#/writing', '.book-link'],
    ['notes', '#/notes/ideas', '.idea-row'], ['tasks', '#/notes/tasks', '.task-row'],
  ]) {
    await page.goto('/' + route)
    await expect(page.locator(ready).first()).toBeVisible()
    await page.screenshot({ path: info.outputPath(view + '-' + theme + '.png') })
  }
  await page.goto('/#/writing')
  await page.locator('#sidebar-toggle').click()
  await expect(page.locator('.book-link').first()).toBeVisible()
  await page.screenshot({ path: info.outputPath('collapsed-' + theme + '.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('#drawer-toggle').click()
  await expect(page.locator('#settings')).toBeVisible()
  await page.screenshot({ path: info.outputPath('drawer-' + theme + '.png') })
})
