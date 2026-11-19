import { startWork } from './navigation-helpers.mjs'
import { expect, test } from './app-test.mjs'

test.use({ timezoneId: 'Asia/Shanghai' })

const now = new Date('2026-11-19T10:00:00+08:00')

/** Puts task rows straight into the library, in the shape the task page saves. */
async function seedTasks(page, rows) {
  await page.evaluate(async ({ rows, now }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('new-world-library')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction('tasks', 'readwrite')
    rows.forEach((row, index) => tx.objectStore('tasks').put({
      id: crypto.randomUUID(), description: '', notes: '', projectId: null, sectionId: null, parentId: null,
      priority: 4, labelIds: [], order: 1024 * (index + 1), expanded: true, planDate: null,
      completedAt: null, deletedAt: null, createdAt: now, updatedAt: now, revision: 1, ...row,
    }))
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    db.close()
  }, { rows, now: now.getTime() })
}

const card = (page) => page.getByRole('region', { name: '提醒与待办' })
const group = (page, name) => card(page).getByRole('list', { name })

test('主页列出逾期、今天和 7 天内的待办，最多 8 条，可勾选完成并撤销', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(now)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/')
  await expect(card(page).getByText('近期没有待办')).toBeVisible()

  await seedTasks(page, [
    { title: '上周的校对', planDate: '2026-11-17' },
    { title: '下午改第三章', planDate: '2026-11-19', planTime: '15:00', zone: 'Asia/Shanghai', reminderMinutes: 30 },
    { title: '截止今天的投稿', deadline: '2026-11-19' },
    ...Array.from({ length: 7 }, (_, index) => ({ title: `周末计划 ${index + 1}`, planDate: `2026-11-2${index}` })),
    { title: '明年的事', planDate: '2027-01-30' },
    { title: '已经完成', planDate: '2026-11-19', completedAt: now.getTime() },
    { title: '已删除', planDate: '2026-11-19', deletedAt: now.getTime(), deletionId: crypto.randomUUID() },
  ])
  await page.reload()

  await expect(group(page, '已逾期').getByRole('listitem')).toHaveCount(1)
  await expect(group(page, '已逾期')).toContainText('上周的校对')
  await expect(group(page, '已逾期')).toContainText('逾期')
  await expect(group(page, '今天').locator('.home-task-title')).toHaveText(['下午改第三章', '截止今天的投稿'])
  await expect(group(page, '今天').getByRole('listitem').first().locator('.home-task-reminder')).toHaveAttribute('aria-label', '有提醒')
  await expect(group(page, '接下来 7 天').getByRole('listitem')).toHaveCount(5)
  await expect(card(page)).not.toContainText('明年的事')
  await expect(card(page)).not.toContainText('已经完成')
  await expect(card(page)).not.toContainText('已删除')
  await expect(card(page).getByRole('link', { name: '查看全部（10）' })).toHaveAttribute('href', '#/notes/tasks/upcoming')

  // Wide windows put the card in a column of its own beside the stats.
  // Measured once the cards have finished rising in.
  await expect.poll(async () => {
    const [stats, tasks] = await Promise.all([page.locator('.writing-stats').boundingBox(), card(page).boundingBox()])
    return tasks.x > stats.x + stats.width && Math.abs(tasks.y - stats.y) < 2
  }).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('home-tasks-1920.png') })

  await card(page).getByRole('checkbox', { name: '完成「上周的校对」' }).click()
  await expect(group(page, '已逾期')).toHaveCount(0)
  const notice = page.getByRole('status').filter({ hasText: '已完成「上周的校对」' })
  await expect(notice).toBeVisible()
  await expect(card(page).getByRole('link', { name: '查看全部（9）' })).toBeVisible()
  await notice.getByRole('button', { name: '撤销' }).click()
  await expect(group(page, '已逾期')).toContainText('上周的校对')

  // A task without a work opens its details.
  await card(page).getByRole('button', { name: '查看待办「周末计划 1」' }).click()
  await expect(page.getByRole('textbox', { name: '标题' })).toHaveValue('周末计划 1')
})

test('点关联作品的待办直接打开那一章', async ({ page }) => {
  await page.clock.setFixedTime(now)
  await page.goto('/#/writing')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill('雾港')
  await page.getByRole('button', { name: '创建小说' }).click()
  const text = page.getByRole('textbox', { name: '章节正文' })
  await expect(text).toBeVisible()
  await page.getByRole('button', { name: '新建章节' }).click()
  await page.getByRole('textbox', { name: '章节名' }).fill('潮汐表')
  await page.getByRole('button', { name: '创建章节' }).click()
  await expect(page.locator('.chapter-jump')).toHaveCount(2)
  await page.locator('.chapter-jump').first().click()
  const [, , bookId, editionId] = new URL(page.url()).hash.split('/')
  const chapters = await page.evaluate(async ({ bookId, editionId }) => {
    const db = await new Promise((resolve) => { const request = indexedDB.open('new-world-library'); request.onsuccess = () => resolve(request.result) })
    const edition = await new Promise((resolve) => {
      const request = db.transaction('editions').objectStore('editions').getAll()
      request.onsuccess = () => resolve(request.result.find((row) => row.bookId === bookId && row.id === editionId))
    })
    db.close()
    return edition.chapters
  }, { bookId, editionId })
  expect(chapters).toHaveLength(2)
  await seedTasks(page, [{
    title: '补写第二章结尾', planDate: '2026-11-19',
    link: { library: 'original', bookId, title: '雾港', editionId, chapterId: chapters[1].id },
  }])

  await page.goto('/#/')
  const row = card(page).getByRole('button', { name: '打开「补写第二章结尾」关联的作品《雾港》' })
  await expect(row).toContainText(`雾港 · ${chapters[1].title}`)
  await row.click()
  await expect(page).toHaveURL(new RegExp(`#/original/${bookId}/${editionId}$`))
  await expect(page.locator('.chapter-jump[aria-current="true"]')).toContainText(chapters[1].title)
})

test('最近项目可切换列表与封面，选择保存在本机', async ({ page }) => {
  await page.goto('/#/writing')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill('灯塔')
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(page.getByRole('textbox', { name: '章节正文' })).toBeVisible()
  await page.goto('/#/')
  const recent = page.locator('.recent-projects')
  const styles = recent.getByRole('group', { name: '最近项目显示方式' })
  await expect(styles.getByRole('button', { name: '列表' })).toHaveAttribute('aria-pressed', 'true')
  await expect(recent.locator('.book-cover')).toHaveCount(0)

  await styles.getByRole('button', { name: '封面' }).click()
  await expect(styles.getByRole('button', { name: '封面' })).toHaveAttribute('aria-pressed', 'true')
  await expect(recent.locator('.recent-covers .book-cover')).toHaveCount(1)
  await expect(recent.getByRole('link', { name: '灯塔' })).toHaveAttribute('href', /#\/original\//)
  await page.reload()
  await expect(recent.locator('.recent-covers .book-cover')).toHaveCount(1)
  await styles.getByRole('button', { name: '列表' }).click()
  await expect(recent.locator('.book-cover')).toHaveCount(0)
  await expect(recent.locator('.recent-link strong')).toHaveText('灯塔')
})

test('靠近窗口底部的作品菜单向上弹出，放不下时内部滚动，页面不滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 560 })
  await page.goto('/#/writing')
  for (const title of ['一', '二', '三', '四', '五', '六']) {
    await startWork(page)
    await page.getByRole('textbox', { name: '作品名' }).fill(`卷${title}`)
    await page.getByRole('button', { name: '创建小说' }).click()
    await expect(page.getByRole('textbox', { name: '章节正文' })).toBeVisible()
    await page.goto('/#/writing')
  }
  const toggle = page.getByRole('button', { name: '「卷一」的操作' })
  await toggle.scrollIntoViewIfNeeded()
  const scroller = () => page.evaluate(() => [document.scrollingElement.scrollTop, document.querySelector('.page').scrollTop, document.documentElement.scrollHeight])
  const before = await scroller()
  await toggle.click()
  const menu = page.getByRole('menu', { name: '「卷一」的操作' })
  await expect(menu).toBeVisible()
  const geometry = () => page.evaluate(() => {
    const arrow = document.querySelector('[aria-label="「卷一」的操作"][aria-expanded]').getBoundingClientRect()
    const list = document.querySelector('[role="menu"]')
    const box = list.getBoundingClientRect()
    return { arrowTop: arrow.top, arrowBottom: arrow.bottom, top: box.top, bottom: box.bottom, inner: innerHeight, scrolls: list.scrollHeight > list.clientHeight }
  })
  let box = await geometry()
  expect(box.top).toBeGreaterThanOrEqual(0)
  expect(box.bottom).toBeLessThanOrEqual(box.inner)
  if (box.arrowBottom > box.inner / 2) expect(box.bottom).toBeLessThanOrEqual(box.arrowTop)
  expect(await scroller()).toEqual(before)
  await page.keyboard.press('Escape')

  // Too short for the list on either side: it takes the larger side and scrolls inside.
  await page.setViewportSize({ width: 1100, height: 300 })
  await toggle.scrollIntoViewIfNeeded()
  const short = await scroller()
  await toggle.click()
  await expect(menu).toBeVisible()
  box = await geometry()
  expect(box.top).toBeGreaterThanOrEqual(0)
  expect(box.bottom).toBeLessThanOrEqual(box.inner)
  expect(box.scrolls).toBe(true)
  await menu.getByRole('menuitem', { name: '删除' }).focus()
  expect(await scroller()).toEqual(short)
})

test('平滑打字开关默认开启，关闭后正文与输入框都用系统光标并立即生效', async ({ page }) => {
  await page.goto('/#/writing')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill('潮声')
  await page.getByRole('button', { name: '创建小说' }).click()
  const text = page.getByRole('textbox', { name: '章节正文' })
  await text.click()
  await page.keyboard.type('涨潮')
  await expect(page.locator('.writing-caret')).toBeVisible()
  await expect.poll(() => text.evaluate((node) => getComputedStyle(node).caretColor)).toBe('rgba(0, 0, 0, 0)')

  await page.goto('/#/settings/appearance')
  const toggle = page.getByRole('checkbox', { name: '平滑光标与打字' })
  await expect(toggle).toBeChecked()
  await toggle.uncheck()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('new-world:appearance')).smoothTyping)).toBe(false)
  await expect(page.locator('html')).toHaveAttribute('data-smooth-typing', 'off')

  // Text fields hand the caret back to the system at once.
  await page.goto('/#/notes/ideas')
  const idea = page.getByRole('textbox').first()
  await idea.click()
  await expect(idea).not.toHaveAttribute('data-typing-caret')
  await expect(page.locator('.typing-overlay')).toHaveCount(0)

  await page.goto('/#/writing')
  await page.getByRole('link', { name: '查看 潮声', exact: true }).click()
  await text.click()
  await page.keyboard.type('退潮')
  await expect(page.locator('.writing-caret')).toBeHidden()
  await expect.poll(() => text.evaluate((node) => getComputedStyle(node).caretColor)).not.toBe('rgba(0, 0, 0, 0)')

  await page.reload()
  await page.goto('/#/settings/appearance')
  await expect(page.getByRole('checkbox', { name: '平滑光标与打字' })).not.toBeChecked()
  await page.getByRole('checkbox', { name: '平滑光标与打字' }).check()
  await page.goto('/#/notes/ideas')
  await page.getByRole('textbox').first().click()
  await expect(page.getByRole('textbox').first()).toHaveAttribute('data-typing-caret', '')
})
