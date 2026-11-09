import { readFile } from 'node:fs/promises'
import { chromium, expect, test } from '@playwright/test'
import { docx, epub, file, odt, pdf } from './fixtures.mjs'

async function importFiles(page, files, count = files.length) {
  await page.locator('input[type=file]').setInputFiles(files)
  await expect(page.getByRole('status').filter({ hasText: `已导入 ${count} 部` })).toBeVisible()
}

async function openBook(page, title) {
  await page.getByRole('link', { name: `查看 ${title}`, exact: true }).click()
  await expect(page.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible()
}

async function expectOriginal(page, expected) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下载原文件' }).click(),
  ])
  expect(download.suggestedFilename()).toBe(expected.name)
  expect(await readFile(await download.path())).toEqual(expected.buffer)
}

test('首页、两个独立书库、原件下载、去重、重命名与删除', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '我的小说书库' })).toBeVisible()
  const original = page.getByRole('link', { name: '进入原创库' })
  const reference = page.getByRole('link', { name: '进入续写／仿写库' })
  await expect(original).toContainText('0 部作品')
  await expect(reference).toContainText('0 部作品')
  await page.screenshot({ path: testInfo.outputPath('home-desktop.png') })
  await original.click()
  await expect(page.getByText('还没有原创作品')).toBeVisible()

  const novel = file('纸船与星光.TXT', '第一章\n\n一只纸船绕过了桥墩。')
  const fileChooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '导入文件' }).click()
  await (await fileChooser).setFiles(novel)
  await expect(page.getByText('已导入 1 部。')).toBeVisible()
  await importFiles(page, [file('另一份文件.txt', novel.buffer)], 0)
  await expect(page.getByText('已导入 0 部，跳过 1 部重复文件。')).toBeVisible()

  await page.getByRole('button', { name: '重命名' }).click()
  const dialog = page.getByRole('dialog', { name: '重命名作品' })
  await dialog.getByRole('textbox', { name: '作品名' }).fill('  ')
  await dialog.getByRole('button', { name: '保存名称' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('请输入有效的作品名。')
  await dialog.getByRole('textbox', { name: '作品名' }).fill('  星光初稿  ')
  await dialog.getByRole('button', { name: '保存名称' }).click()
  await openBook(page, '星光初稿')
  await expect(page.getByRole('article')).toContainText('一只纸船绕过了桥墩。')
  await expectOriginal(page, novel)
  const originalDetail = new URL(page.url()).hash

  await page.getByRole('link', { name: '书库首页', exact: true }).click()
  await expect(original).toContainText('1 部作品')
  await expect(reference).toContainText('0 部作品')
  await reference.click()
  await expect(page.getByText('还没有参考原作')).toBeVisible()
  await importFiles(page, [novel])
  await expect(page.getByRole('link', { name: '查看 纸船与星光' })).toBeVisible()
  await page.goto(originalDetail.replace('/original/', '/reference/'))
  await expect(page.getByRole('alert')).toHaveText('这个书库中没有找到该作品。')

  await page.goto('/#/original')
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '删除作品？' })
  await confirmation.getByRole('button', { name: '取消' }).click()
  await expect(page.getByRole('link', { name: '查看 星光初稿' })).toBeVisible()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await confirmation.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByText('还没有原创作品')).toBeVisible()
  await page.goto(originalDetail)
  await expect(page.getByRole('alert')).toHaveText('这个书库中没有找到该作品。')
  await page.goto('/#/reference')
  await openBook(page, '纸船与星光')
  await expectOriginal(page, novel)
  await page.goto('/#/original')
  await importFiles(page, [novel])
})

test('关闭整个浏览器后用同一配置重新打开，作品名、正文和字节仍在', async ({ baseURL }, testInfo) => {
  const novel = file('夜航记录.txt', '凌晨三点，灯塔还亮着。')
  const profile = testInfo.outputPath('browser-profile')
  const launch = () => chromium.launchPersistentContext(profile, { baseURL, executablePath: process.env.CHROMIUM_PATH })

  const first = await launch()
  try {
    const page = first.pages()[0]
    await page.goto('/#/original')
    await importFiles(page, [novel])
    await page.getByRole('button', { name: '重命名' }).click()
    await page.getByRole('textbox', { name: '作品名' }).fill('夜航手稿')
    await page.getByRole('button', { name: '保存名称' }).click()
    await expect(page.getByRole('link', { name: '查看 夜航手稿' })).toBeVisible()
  } finally {
    await first.close()
  }

  const second = await launch()
  try {
    const page = second.pages()[0]
    await page.goto('/#/original')
    await openBook(page, '夜航手稿')
    await expect(page.getByRole('article')).toHaveText('凌晨三点，灯塔还亮着。')
    await expectOriginal(page, novel)
  } finally {
    await second.close()
  }
})

test('不同标签页同时导入同一文件仅产生一部作品', async ({ page, context }) => {
  const other = await context.newPage()
  const novel = file('一起读.txt', '相同的正文。')
  await Promise.all([page.goto('/#/original'), other.goto('/#/original')])
  await Promise.all([page, other].map((tab) => tab.locator('input[type=file]').setInputFiles(novel)))
  for (const tab of [page, other]) await expect(tab.getByRole('status').filter({ hasText: '已导入' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('link', { name: '查看 一起读' })).toHaveCount(1)
  await expect(page.getByRole('list', { name: '全部作品' }).getByRole('listitem')).toHaveCount(1)
})

test('中文 GBK、UTF-16 和手动 Big5 解码', async ({ page }) => {
  const gbk = file('旧稿.txt', Buffer.from('d6d0cec4cec4b1be', 'hex'))
  const utf16 = file('新稿.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('窗边的灯', 'utf16le')]))
  const big5 = file('繁體.txt', Buffer.from('a4a4a4e5', 'hex'))
  await page.goto('/#/original')
  await importFiles(page, [gbk, utf16, big5])
  await openBook(page, '旧稿')
  await expect(page.getByRole('article')).toHaveText('中文文本')
  await expect(page.getByRole('combobox', { name: '编码' })).toContainText('自动 · GB18030 / GBK')
  await page.goBack()
  await openBook(page, '新稿')
  await expect(page.getByRole('article')).toHaveText('窗边的灯')
  await page.goBack()
  await openBook(page, '繁體')
  await page.getByRole('combobox', { name: '编码' }).selectOption('big5')
  await expect(page.getByRole('article')).toHaveText('中文')
  await expectOriginal(page, big5)
})

test('PDF 页面真正渲染并可翻页，本地 CJK 字符映射可用', async ({ page }) => {
  const novel = pdf()
  await page.goto('/#/reference')
  await importFiles(page, [novel])
  await openBook(page, '双页试读')

  function centerPixel(canvas) {
    return canvas.evaluate((node) => Array.from(node.getContext('2d').getImageData(node.width / 2, node.height / 2, 1, 1).data))
  }
  const first = page.getByRole('img', { name: 'PDF 第 1 页' })
  await expect(first).toBeVisible()
  expect(await centerPixel(first)).toEqual([255, 0, 0, 255])
  await expect(page.getByRole('button', { name: '上一页' })).toBeDisabled()
  await page.getByRole('button', { name: '下一页' }).click()
  const second = page.getByRole('img', { name: 'PDF 第 2 页' })
  await expect(second).toBeVisible()
  expect(await centerPixel(second)).toEqual([0, 0, 255, 255])
  const hasGlyphs = await second.evaluate((node) => {
    const pixels = node.getContext('2d').getImageData(0, 0, node.width, Math.floor(node.height * 0.22)).data
    return pixels.some((value, index) => index % 4 === 0 && value < 32 && pixels[index + 1] < 32 && pixels[index + 2] < 32)
  })
  expect(hasGlyphs).toBe(true)
  const cmap = await page.request.get('/pdfjs/cmaps/UniGB-UCS2-H.bcmap')
  expect(cmap.ok()).toBe(true)
  expect(cmap.headers()['content-type']).not.toContain('text/html')
  await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled()
  await expectOriginal(page, novel)
})

test('EPUB 按 spine 顺序阅读中文路径的章节', async ({ page }) => {
  const novel = await epub()
  await page.goto('/#/original')
  await importFiles(page, [novel])
  await openBook(page, '纸上森林')
  await expect(page.getByRole('article')).toContainText('第一节的树叶响了。')
  await page.getByRole('button', { name: '下一节' }).click()
  await expect(page.getByRole('article')).toContainText('第二节的窗亮了。')
  await page.getByRole('button', { name: '上一节' }).click()
  await expect(page.getByRole('article')).toContainText('第一节的树叶响了。')
  await expectOriginal(page, novel)
})

test('DOCX 和 ODT 提取正文、段落与换行', async ({ page }) => {
  const [word, openDocument] = await Promise.all([docx(), odt()])
  await page.goto('/#/reference')
  await importFiles(page, [word, openDocument])
  await openBook(page, '未寄的信')
  await expect(page.getByRole('article')).toBeVisible()
  expect(await page.getByRole('article').textContent()).toBe('未寄的信\n\n他把信放在窗边。\n等雨停。')
  await expectOriginal(page, word)
  await page.goBack()
  await openBook(page, '傍晚的雾')
  await expect(page.getByRole('article')).toBeVisible()
  expect(await page.getByRole('article').textContent()).toBe('傍晚的雾\n\n巷子  起了雾。\n有人走来。')
  await expectOriginal(page, openDocument)
})

test('Markdown 显示源文，HTML 提取正文且不运行脚本或加载远程资源', async ({ page, context }) => {
  const requests = []
  await context.route('https://example.invalid/**', (route) => {
    requests.push(route.request().url())
    return route.abort()
  })
  const markdown = file('试读.MARKDOWN', '# 开头\n\n纸上有**海风**。')
  const html = file('岛屿.HTM', `<!doctype html><html><head><title>无需显示</title>
    <link rel="stylesheet" href="https://example.invalid/remote.css"></head><body>
    <h1>岛屿</h1><p>傍晚有潮声。</p><script>window.importedScriptRan = true</script>
    <iframe src="https://example.invalid/frame"></iframe><img src="https://example.invalid/photo"></body></html>`)
  await page.goto('/#/reference')
  await importFiles(page, [markdown, html])
  await openBook(page, '试读')
  await expect(page.getByRole('heading', { name: 'Markdown 源文' })).toBeVisible()
  await expect(page.getByRole('article')).toContainText('纸上有**海风**。')
  await page.goBack()
  await openBook(page, '岛屿')
  await expect(page.getByRole('article')).toHaveText('岛屿 傍晚有潮声。')
  expect(await page.evaluate(() => window.importedScriptRan)).toBeUndefined()
  expect(requests).toEqual([])
  await expectOriginal(page, html)
})

test('损坏的 PDF、EPUB 保留原件，空文件和未知扩展名有明确错误', async ({ page }) => {
  const brokenPdf = file('残缺.pdf', '%PDF-1.4\n没有页面。')
  const brokenEpub = file('无目录.epub', '文件已损坏。')
  await page.goto('/#/original')
  await importFiles(page, [brokenPdf, brokenEpub, file('空白.txt', ''), file('未知.xyz', '内容')], 2)
  await expect(page.getByText('已导入 2 部，2 个文件导入失败。')).toBeVisible()
  await expect(page.getByText('空白.txt · 文件为空。')).toBeVisible()
  await expect(page.getByText('未知.xyz · 此文件扩展名不在导入列表中。')).toBeVisible()
  await openBook(page, '残缺')
  await expect(page.getByRole('alert')).toContainText('无法打开此 PDF')
  await expectOriginal(page, brokenPdf)
  await page.goBack()
  await openBook(page, '无目录')
  await expect(page.getByRole('alert')).toContainText('无法读取文档的压缩包')
  await expectOriginal(page, brokenEpub)
})

test('DOC、MOBI、AZW3 明示仅保存原件并逐字节下载', async ({ page }) => {
  const files = [
    file('旧稿.doc', Buffer.from('d0cf11e0a1b11ae1000001', 'hex')),
    file('电子书.mobi', Buffer.from('00000000424f4f4b4d4f4249', 'hex')),
    file('样本.azw3', Buffer.from('00000001424f4f4b4d4f4249', 'hex')),
  ]
  await page.goto('/#/reference')
  await importFiles(page, files)
  for (const original of files) {
    const [title, extension] = original.name.split('.')
    await openBook(page, title)
    await expect(page.getByRole('status')).toContainText(`${extension.toUpperCase()} 当前仅保存原文件。`)
    await expectOriginal(page, original)
    await page.goBack()
  }
})

test.describe('手机视口', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 })

  test('首页入口堆叠，书库和长中文文件名无横向溢出', async ({ page }, testInfo) => {
    async function expectNoOverflow() {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await page.goto('/')
    const original = page.getByRole('link', { name: '进入原创库' })
    const reference = page.getByRole('link', { name: '进入续写／仿写库' })
    await expect(reference).toBeVisible()
    expect((await reference.boundingBox()).y).toBeGreaterThan((await original.boundingBox()).y)
    await expectNoOverflow()
    await page.screenshot({ path: testInfo.outputPath('home-mobile.png'), fullPage: true })
    await reference.tap()
    const title = '中文长文件名'.repeat(18)
    await importFiles(page, [file(`${title}.txt`, '窄屏也能读。'.repeat(20))])
    await expectNoOverflow()
    await openBook(page, title)
    await expect(page.getByRole('article')).toContainText('窄屏也能读。')
    await expectNoOverflow()
  })
})
