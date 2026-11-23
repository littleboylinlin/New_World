import { readFileSync } from 'node:fs'
import { devices } from '@playwright/test'
import { expect, test } from './app-test.mjs'
import { startWork } from './navigation-helpers.mjs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const versionTag = `v${version}`
const issueForm = 'https://github.com/littleboylinlin/New_World/issues/new'

async function expectIssueLink(link, template, platform) {
  const url = new URL(await link.getAttribute('href'))
  expect(url.origin + url.pathname).toBe(issueForm)
  expect([...url.searchParams]).toEqual([
    ['template', template], ['version', versionTag], ['platform', platform],
  ])
  expect([url.username, url.password, url.hash]).toEqual(['', '', ''])
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  return url
}

test('Bug 和建议链接直达各自表单，只预填版本和平台', async ({ page, context }) => {
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名', exact: true }).fill('私密作品标题')
  await page.getByRole('button', { name: '创建小说', exact: true }).click()
  await page.getByRole('textbox', { name: '章节正文', exact: true }).fill('私密章节正文')

  await page.getByRole('link', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '更新与关于', exact: true }).click()
  const settings = page.getByRole('region', { name: '更新与关于', exact: true })
  const bug = settings.getByRole('link', { name: '报告 Bug', exact: true })
  const feature = settings.getByRole('link', { name: '提建议', exact: true })
  const email = settings.getByRole('link', { name: '发邮件', exact: true })
  await expect(bug).toBeHidden()
  await expect(feature).toBeHidden()
  await expect(email).toBeHidden()
  await settings.getByText('反馈与建议', { exact: true }).click()

  for (const [link, template] of [[bug, 'bug.yml'], [feature, 'feature.yml']]) {
    const url = await expectIssueLink(link, template, '网页')
    await context.route(url.href, (route) => route.fulfill({ body: 'Issue form' }))
    const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()])
    await expect(popup).toHaveURL(url.href)
    await popup.close()
    await expect(page).toHaveURL(/#\/settings\/updates$/)
  }

  const emailUrl = new URL(await email.getAttribute('href'))
  expect(emailUrl.protocol + emailUrl.pathname).toBe('mailto:feedback@writenewworld.com')
  expect([...emailUrl.searchParams]).toEqual([
    ['subject', `New World 反馈 ${versionTag}`],
    ['body', `版本号：${versionTag}\r\n平台：网页\r\n\r\n`],
  ])
  expect(emailUrl.hash).toBe('')
})

test.describe('English mobile browser', () => {
  const { userAgent, viewport, isMobile, hasTouch } = devices['iPhone 13']
  test.use({ locale: 'en-US', userAgent, viewport, isMobile, hasTouch })

  test('shows localized feedback links and prefills Mobile browser @webkit', async ({ page }) => {
    await page.goto('/#/settings/updates')
    const settings = page.getByRole('region', { name: 'Updates & about', exact: true })
    await settings.getByText('Feedback', { exact: true }).click()

    const bug = settings.getByRole('link', { name: 'Report a bug', exact: true })
    const feature = settings.getByRole('link', { name: 'Suggest a feature', exact: true })
    const email = settings.getByRole('link', { name: 'Send email', exact: true })
    await expectIssueLink(bug, 'bug.yml', 'Mobile browser')
    await expectIssueLink(feature, 'feature.yml', 'Mobile browser')

    const emailUrl = new URL(await email.getAttribute('href'))
    expect([...emailUrl.searchParams]).toEqual([
      ['subject', `New World Feedback ${versionTag}`],
      ['body', `Version: ${versionTag}\r\nPlatform: Mobile browser\r\n\r\n`],
    ])
  })
})
