import { expect, test } from './app-test.mjs'
import { checkSettingsLayout, expectHeaderLayout } from './header-layout.mjs'

for (const locale of ['zh-CN', 'en-US']) {
  test.describe(locale, () => {
    test.use({ locale })
    for (const platform of ['web', 'win32', 'darwin']) {
      test(`${platform} 中英文标题栏在缩窄和放大后不重叠，设置仍可操作`, async ({ page }, info) => {
        if (platform !== 'web') {
          await page.addInitScript((platform) => {
            window.newWorldDesktop = {
              platform, arch: 'x64', onCloseRequested: () => {}, onUpdateProgress: () => {},
              minimizeWindow: () => {}, toggleMaximizeWindow: () => {}, closeWindow: () => {},
              isMaximized: async () => false, onMaximizeChange: () => {},
              getStorageLocation: async () => ({ path: '/Library/NewWorld', custom: false }),
              getCloseBehavior: async () => 'quit',
            }
          }, platform)
          await page.route('https://api.github.com/**', (route) => route.fulfill({ json: [] }))
        }
        await page.goto('/')
        await expect(page.locator('html')).toHaveAttribute('lang', locale === 'en-US' ? 'en' : 'zh-CN')
        await expect(page.locator('#app-version')).not.toBeEmpty()
        const widths = platform === 'web' ? [1220, 820, 720, 641, 640, 480, 390, 320, 1220]
          : [1220, 1024, 820, 720, 641, 640, 480, 1220]
        for (const width of widths) {
          await page.setViewportSize({ width, height: 420 })
          await expectHeaderLayout(page)
          await expect(page.getByRole('link', { name: locale === 'en-US' ? 'Trash' : '回收站', exact: true })).toBeVisible()
          if ([1024, 641, 480, 320].includes(width)) {
            await page.screenshot({ path: info.outputPath(`home-header-${platform}-${locale}-${width}.png`), animations: 'disabled' })
          }
          if (width === 480) await checkSettingsLayout(page)
        }
      })
    }
  })
}
