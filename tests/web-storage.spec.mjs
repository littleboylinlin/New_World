import { startWork } from './navigation-helpers.mjs'
import { test as base } from '@playwright/test'
import { expect, test, withoutRelease } from './app-test.mjs'
import { saveNow } from './editor-helpers.mjs'

const day = 24 * 60 * 60 * 1000

async function newNovel(page, title, text) {
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill(title)
  await page.getByRole('button', { name: '创建小说' }).click()
  const editor = page.getByRole('textbox', { name: '章节正文' })
  await editor.fill(text)
  await saveNow(page)
  await expect(page.locator('.save-status')).toHaveText('已保存')
  return editor
}

// Stands in for the folder picker with a directory in the origin's private file system.
async function pickerInOpfs(context) {
  await context.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true })
  })
}

const bookCount = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('new-world-library')
  request.onsuccess = () => {
    const count = request.result.transaction('books').objectStore('books').count()
    count.onsuccess = () => { request.result.close(); resolve(count.result) }
  }
  request.onerror = () => reject(request.error)
}))

const folderFiles = (page) => page.evaluate(async () => {
  const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true })
  const files = {}
  for await (const entry of folder.values()) files[entry.name] = new TextDecoder().decode(await (await entry.getFile()).arrayBuffer())
  return files
})

test.describe('持久化存储', () => {
  test('启动时申请持久化，设置里显示结果并可再次申请', async ({ page, context }) => {
    await context.addInitScript(() => {
      window.persistCalls = 0
      let granted = sessionStorage.getItem('granted') === '1'
      StorageManager.prototype.persisted = async () => granted
      StorageManager.prototype.persist = async () => {
        window.persistCalls++
        granted = window.allowPersist === true
        if (granted) sessionStorage.setItem('granted', '1')
        return granted
      }
    })
    await page.goto('/')
    await expect.poll(() => page.evaluate(() => window.persistCalls)).toBe(1)
    await page.goto('/#/settings/storage')
    const value = page.locator('.web-storage-row').first().locator('.web-storage-value')
    await expect(value).toContainText('未获得')
    await page.evaluate(() => { window.allowPersist = true })
    await page.getByRole('button', { name: '申请持久化' }).click()
    await expect(value).toContainText('已获得')
    await expect(page.getByRole('button', { name: '申请持久化' })).toBeHidden()
    expect(await page.evaluate(() => window.persistCalls)).toBe(2)
  })
})

test.describe('保存到本地文件夹', () => {
  test('作品以 .newworld 写入所选文件夹，自动保存后更新，清空浏览器数据后可从文件夹读回', async ({ page, context }) => {
    await pickerInOpfs(context)
    await context.route('**/blank.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>blank</title>' }))
    const editor = await newNovel(page, '雾港', '雾从海面漫上来的时候。')
    await page.goto('/#/settings/storage')
    await page.getByRole('button', { name: '选择文件夹' }).click()
    const status = page.locator('.web-storage-folder .web-storage-value')
    await expect(status).toContainText('正在保存到「picked」，最近写入')
    let files = await folderFiles(page)
    const names = Object.keys(files)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^雾港 \([0-9a-z-]{8}\)\.newworld$/)
    expect(files[names[0]]).toContain('雾从海面漫上来的时候。')

    await page.goBack()
    await expect(editor).toBeVisible()
    await editor.fill('林栖正把最后一盏灯点亮。')
    await expect(page.locator('.save-status')).toHaveText('已保存')
    await expect.poll(async () => (await folderFiles(page))[names[0]]).toContain('林栖正把最后一盏灯点亮。')

    // Clearing site data takes the library and the remembered folder, but not the folder itself.
    await page.goto('/blank.html')
    await page.evaluate(() => Promise.all(['new-world-library', 'new-world-folder'].map((name) => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = resolve
      request.onerror = () => reject(request.error)
    }))))
    await page.goto('/#/original')
    await expect(page.getByText('雾港')).toHaveCount(0)
    await page.goto('/#/settings/storage')
    await expect(status).toHaveText('还没有选择文件夹')
    await page.getByRole('button', { name: '选择文件夹' }).click()
    await expect(status).toHaveText('已从文件夹读回 1 部作品')
    await page.goto('/#/original')
    await page.getByRole('link', { name: /雾港/ }).first().click()
    await expect(page.getByRole('textbox', { name: '章节正文' })).toHaveText('林栖正把最后一盏灯点亮。')
  })

  test('重新选择同一文件夹不会重复导入，停止后不再写入', async ({ page, context }) => {
    await pickerInOpfs(context)
    const editor = await newNovel(page, '回信', '第一封信。')
    await page.goto('/#/settings/storage')
    await page.getByRole('button', { name: '选择文件夹' }).click()
    const status = page.locator('.web-storage-folder .web-storage-value')
    await expect(status).toContainText('最近写入')
    await page.getByRole('button', { name: '更换文件夹' }).click()
    await expect(status).toContainText('最近写入')
    await page.getByRole('button', { name: '停止保存到文件夹' }).click()
    await expect(status).toHaveText('还没有选择文件夹')
    const before = await folderFiles(page)
    await page.goto('/#/original')
    await page.getByRole('link', { name: /回信/ }).first().click()
    await editor.fill('不该写进文件夹的段落。')
    await expect(page.locator('.save-status')).toHaveText('已保存')
    await page.waitForTimeout(1600)
    expect(await folderFiles(page)).toEqual(before)
    expect(await bookCount(page)).toBe(1)
  })

  test('不支持文件夹写入的浏览器保留浏览器存储并说明原因', async ({ page, context }) => {
    await context.addInitScript(() => { delete window.showDirectoryPicker })
    await page.goto('/#/settings/storage')
    await expect(page.locator('.web-storage-folder')).toContainText('当前浏览器不支持直接写入本地文件夹')
    await expect(page.getByRole('button', { name: '选择文件夹' })).toHaveCount(0)
  })
})

test.describe('备份提醒', () => {
  const reminder = (page) => page.locator('.corner-tip[data-tip="backup"]')
  const lastBackup = (context, daysAgo) => context.addInitScript((age) => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('new-world:last-export', String(Date.now() - age))
  }, daysAgo * day)

  test('超过 7 天没有导出时提示一次，一键下载 .newworld 后不再提示', async ({ page, context }) => {
    await lastBackup(context, 9)
    await newNovel(page, '提醒测试', '需要备份的段落。')
    await page.reload()
    await expect(reminder(page)).toContainText('已经 9 天没有导出备份')
    const [download] = await Promise.all([page.waitForEvent('download'), reminder(page).getByRole('button', { name: '导出备份' }).click()])
    expect(download.suggestedFilename()).toBe('提醒测试.newworld')
    await expect(reminder(page)).toHaveCount(0)
    const recorded = Number(await page.evaluate(() => localStorage.getItem('new-world:last-export')))
    expect(Date.now() - recorded).toBeLessThan(60_000)
    await page.reload()
    await page.waitForTimeout(300)
    await expect(reminder(page)).toHaveCount(0)
  })

  test('7 天内或书库为空时不提示', async ({ page, context }) => {
    await lastBackup(context, 3)
    await newNovel(page, '刚备份过', '内容。')
    await page.reload()
    await page.waitForTimeout(300)
    await expect(reminder(page)).toHaveCount(0)

    const fresh = await page.context().browser().newContext()
    await withoutRelease(fresh)
    await lastBackup(fresh, 30)
    const empty = await fresh.newPage()
    await empty.goto('/')
    await empty.waitForTimeout(500)
    await expect(reminder(empty)).toHaveCount(0)
    await fresh.close()
  })

  test('关闭后暂不提示；选择不再提醒后关闭，设置里可以重新打开', async ({ page, context }) => {
    await lastBackup(context, 8)
    await newNovel(page, '关闭提醒', '内容。')
    await page.reload()
    await reminder(page).getByRole('button', { name: '关闭提示' }).click()
    await expect(reminder(page)).toHaveCount(0)
    await page.reload()
    await page.waitForTimeout(300)
    await expect(reminder(page)).toHaveCount(0)

    await page.evaluate(() => localStorage.removeItem('new-world:backup-reminder:dismissed'))
    await page.reload()
    await reminder(page).getByRole('button', { name: '不再提醒' }).click()
    await expect(reminder(page)).toHaveCount(0)
    await page.goto('/#/settings/backup')
    const toggle = page.getByRole('checkbox', { name: '超过 7 天没有导出备份时提醒我' })
    await expect(toggle).not.toBeChecked()
    await page.goto('/')
    await page.waitForTimeout(300)
    await expect(reminder(page)).toHaveCount(0)
    await page.goto('/#/settings/backup')
    await toggle.check()
    await page.goto('/')
    await expect(reminder(page)).toContainText('已经 8 天没有导出备份')
  })
})

base.describe('网页版存储说明', () => {
  base('首次打开时说明数据由浏览器保存，知道了以后不再出现', async ({ page, context }) => {
    await withoutRelease(context)
    await page.goto('/')
    const notice = page.locator('.corner-tip[data-tip="web-notice"]')
    await expect(notice).toContainText('网页版的数据由浏览器保存，清理浏览器数据可能会丢失。长期写作建议使用桌面版。')
    await notice.getByRole('button', { name: '知道了' }).click()
    await expect(notice).toHaveCount(0)
    await page.reload()
    await page.waitForTimeout(300)
    await expect(notice).toHaveCount(0)
    await page.goto('/#/settings/storage')
    await expect(page.locator('.web-storage-warning')).toContainText('长期写作建议使用桌面版')
  })

  base('英文界面显示英文说明', async ({ browser }) => {
    const context = await withoutRelease(await browser.newContext({ locale: 'en-US' }))
    const page = await context.newPage()
    await page.goto('/')
    await expect(page.locator('.corner-tip[data-tip="web-notice"]')).toContainText('clearing browser data can erase it')
    await page.goto('/#/settings/storage')
    await expect(page.locator('.web-storage-warning')).toContainText('For long-term writing, use the desktop app.')
    await expect(page.locator('.web-storage-folder')).toContainText('Save to a local folder')
    await context.close()
  })
})
