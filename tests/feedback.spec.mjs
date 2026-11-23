import { readFileSync } from 'node:fs'
import { devices } from '@playwright/test'
import { expect, test } from './app-test.mjs'
import { startWork } from './navigation-helpers.mjs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const versionTag = `v${version}`
const issueChooser = 'https://github.com/littleboylinlin/New_World/issues/new/choose'

test('反馈链接只带版本和平台，并在新标签页打开 GitHub', async ({ page, context }) => {
  await page.goto('/#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名', exact: true }).fill('私密作品标题')
  await page.getByRole('button', { name: '创建小说', exact: true }).click()
  await page.getByRole('textbox', { name: '章节正文', exact: true }).fill('私密章节正文')

  await page.getByRole('link', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '更新与关于', exact: true }).click()
  const settings = page.getByRole('region', { name: '更新与关于', exact: true })
  const github = settings.getByRole('link', { name: '在 GitHub 提交', exact: true })
  const email = settings.getByRole('link', { name: '发邮件', exact: true })
  await expect(github).toBeHidden()
  await expect(email).toBeHidden()
  await settings.getByText('反馈与建议', { exact: true }).click()

  const githubUrl = new URL(await github.getAttribute('href'))
  expect(githubUrl.origin + githubUrl.pathname).toBe(issueChooser)
  expect([...githubUrl.searchParams]).toEqual([['version', versionTag], ['platform', '网页']])
  expect(githubUrl.hash).toBe('')
  await expect(github).toHaveAttribute('rel', 'noopener noreferrer')

  const emailUrl = new URL(await email.getAttribute('href'))
  expect(emailUrl.protocol + emailUrl.pathname).toBe('mailto:feedback@writenewworld.com')
  expect([...emailUrl.searchParams]).toEqual([
    ['subject', `New World 反馈 ${versionTag}`],
    ['body', `版本号：${versionTag}\r\n平台：网页\r\n\r\n`],
  ])
  expect(emailUrl.hash).toBe('')

  await context.route(githubUrl.href, (route) => route.fulfill({ body: 'Issue chooser' }))
  const [popup] = await Promise.all([page.waitForEvent('popup'), github.click()])
  await expect(popup).toHaveURL(githubUrl.href)
  await expect(page).toHaveURL(/#\/settings\/updates$/)
})

test.describe('English mobile browser', () => {
  const { userAgent, viewport, isMobile, hasTouch } = devices['iPhone 13']
  test.use({ locale: 'en-US', userAgent, viewport, isMobile, hasTouch })

  test('shows localized feedback links and prefills Mobile browser @webkit', async ({ page }) => {
    await page.goto('/#/settings/updates')
    const settings = page.getByRole('region', { name: 'Updates & about', exact: true })
    await settings.getByText('Feedback', { exact: true }).click()

    const github = settings.getByRole('link', { name: 'Submit on GitHub', exact: true })
    const email = settings.getByRole('link', { name: 'Send email', exact: true })
    const githubUrl = new URL(await github.getAttribute('href'))
    expect(githubUrl.origin + githubUrl.pathname).toBe(issueChooser)
    expect([...githubUrl.searchParams]).toEqual([['version', versionTag], ['platform', 'Mobile browser']])

    const emailUrl = new URL(await email.getAttribute('href'))
    expect([...emailUrl.searchParams]).toEqual([
      ['subject', `New World Feedback ${versionTag}`],
      ['body', `Version: ${versionTag}\r\nPlatform: Mobile browser\r\n\r\n`],
    ])
  })
})
