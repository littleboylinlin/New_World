import { expect, test } from './app-test.mjs'

const textArea = (page) => page.getByRole('textbox', { name: '章节正文' })

async function newNovel(page, name) {
  await page.goto('/#/original')
  await page.getByRole('button', { name: '新建小说' }).click()
  await page.getByRole('textbox', { name: '作品名' }).fill(name)
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(textArea(page)).toBeVisible()
}

test('英文按单词计数，中文按字计数，混排相加', async ({ page }) => {
  await newNovel(page, 'Word Count')
  await textArea(page).fill('The keeper climbed the stairs.')
  await expect(page.locator('.word-count')).toHaveText('本章 5 字')
  await textArea(page).fill('The keeper’s well-known lamp. 灯塔守望者。')
  await expect(page.locator('.word-count')).toHaveText('本章 10 字')
  await expect(page.locator('.word-counts')).toHaveAttribute('title', '中文按字计数，英文等按词计数')
})

test('拼写检查默认关闭，可在「外观」面板打开并记住', async ({ page }) => {
  await newNovel(page, 'Spelling')
  const spellcheck = () => textArea(page).evaluate((node) => node.spellcheck)
  expect(await spellcheck()).toBe(false)
  await page.getByRole('button', { name: '外观', exact: true }).click()
  const box = page.getByRole('group', { name: '外观' }).getByRole('checkbox', { name: '拼写检查' })
  await expect(box).not.toBeChecked()
  await box.check()
  await expect.poll(spellcheck).toBe(true)
  expect(await page.evaluate(() => document.documentElement.spellcheck)).toBe(false)
  await page.reload()
  await expect(textArea(page)).toBeVisible()
  await expect.poll(spellcheck).toBe(true)
  await page.getByRole('button', { name: '新建章节' }).click()
  expect(await page.getByRole('textbox', { name: '章节名' }).evaluate((node) => node.spellcheck)).toBe(false)
})

test('行距、段落间距、首行缩进和正文宽度可在设置中调整', async ({ page }, testInfo) => {
  await newNovel(page, 'Layout')
  await textArea(page).fill('First paragraph.\nSecond paragraph.')
  const paragraph = textArea(page).locator('p').first()
  await expect(paragraph).toHaveCSS('text-indent', '0px')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const section = page.getByRole('dialog', { name: '设置' }).getByRole('region', { name: '外观', exact: true })
  await section.getByRole('radiogroup', { name: '行距' }).getByRole('radio', { name: '宽松' }).check()
  await section.getByRole('radiogroup', { name: '段落间距' }).getByRole('radio', { name: '无' }).check()
  await section.getByRole('radiogroup', { name: '首行缩进' }).getByRole('radio', { name: '缩进两字' }).check()
  await section.getByRole('radiogroup', { name: '正文宽度' }).getByRole('radio', { name: '宽' }).check()
  await page.screenshot({ path: testInfo.outputPath('home-settings-layout.png') })
  await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
  const metrics = await paragraph.evaluate((node) => {
    const text = getComputedStyle(node.parentElement)
    const style = getComputedStyle(node)
    return {
      size: parseFloat(text.fontSize), lineHeight: parseFloat(text.lineHeight), width: text.maxWidth,
      indent: parseFloat(style.textIndent), gap: style.marginBottom,
    }
  })
  expect(metrics.gap).toBe('0px')
  expect(metrics.indent).toBeCloseTo(metrics.size * 2, 1)
  expect(metrics.lineHeight).toBeCloseTo(metrics.size * 2.3, 1)
  expect(metrics.width).toBe('928px')
})

test('专注模式只留正文，Esc 或离开页面后恢复', async ({ page }, testInfo) => {
  await newNovel(page, 'Focus')
  await textArea(page).fill('Only the words remain.')
  const focus = page.getByRole('button', { name: '专注写作' })
  await focus.click()
  const exit = page.getByRole('button', { name: '退出专注' })
  await expect(exit).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveClass(/focus-writing/)
  await expect(page.locator('.chapter-navigation')).toBeHidden()
  await expect(page.locator('.edition-header')).toBeHidden()
  await expect(page.locator('.breadcrumbs')).toBeHidden()
  await expect(textArea(page)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('editor-focus.png') })

  await textArea(page).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('html')).not.toHaveClass(/focus-writing/)
  await expect(page.locator('.chapter-navigation')).toBeVisible()

  await page.getByRole('button', { name: '专注写作' }).click()
  await page.getByRole('button', { name: '查找／替换' }).click()
  await page.getByRole('searchbox', { name: '查找文字' }).press('Escape')
  await expect(page.locator('.search-panel')).toBeHidden()
  await expect(page.locator('html')).toHaveClass(/focus-writing/)

  await page.goto('/#/')
  await expect(page.locator('html')).not.toHaveClass(/focus-writing/)
  await expect(page.locator('.site-footer')).toBeVisible()
})
