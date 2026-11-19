import { expect, test } from './app-test.mjs'
import { openSidePanel } from './editor-helpers.mjs'
import { paragraph, seedChapters } from './split-helpers.mjs'

// The web version has no web panes: nothing offers one, and web addresses in ideas open in a new tab.

test('网页版没有网页块入口；灵感里的网址是链接，在浏览器新标签页打开 @webkit', async ({ page, context }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const url = await seedChapters(page, [['第一章', [paragraph('灯塔。')]]], '链接样书')
  const link = new URL('/#/writing', url).href
  await page.evaluate(async (link) => {
    const db = await new Promise((resolve) => { const request = indexedDB.open('new-world-library'); request.onsuccess = () => resolve(request.result) })
    const bookId = location.hash.split('/')[2]
    const transaction = db.transaction('ideas', 'readwrite')
    transaction.objectStore('ideas').put({ id: crypto.randomUUID(), text: `雾港的资料，见 ${link} 。`, createdAt: Date.now(), library: 'original', bookId })
    await new Promise((resolve) => { transaction.oncomplete = resolve })
    db.close()
  }, link)
  await page.reload()
  await openSidePanel(page, '灵感')
  await expect(page.getByRole('tab', { name: /^网页/ })).toHaveCount(0)
  await page.locator('.more-toggle').click()
  await expect(page.getByRole('menuitem', { name: '打开网页' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const anchor = page.locator('.ideas-panel .idea-text').getByRole('link', { name: link })
  await expect(anchor).toHaveAttribute('target', '_blank')
  await expect(anchor).toHaveAttribute('rel', /noopener/)
  await expect(page.locator('.ideas-panel .idea-text')).toHaveText(`雾港的资料，见 ${link} 。`)
  const [opened] = await Promise.all([context.waitForEvent('page'), anchor.click()])
  await opened.waitForLoadState()
  expect(opened.url()).toBe(link)
  expect(page.url()).toBe(url)

  // The ideas page shows the same link.
  await page.goto(new URL('/#/notes/ideas', url).href)
  await expect(page.locator('.idea-text').getByRole('link', { name: link })).toHaveAttribute('target', '_blank')
})
