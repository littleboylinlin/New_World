import { defineConfig } from '@playwright/test'

const baseURL = 'http://127.0.0.1:8788'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    baseURL,
    locale: 'zh-CN',
    launchOptions: { executablePath: process.env.CHROMIUM_PATH },
  },
  webServer: {
    command: 'LATEST_JSON=tests/fixtures/latest.json node scripts/build.mjs && wrangler dev --ip 127.0.0.1 --port 8788 --log-level warn',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
