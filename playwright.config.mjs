import { defineConfig } from '@playwright/test'

const baseURL = 'http://127.0.0.1:4173'

export default defineConfig({
  testDir: './tests',
  testIgnore: '**/tests/desktop/**',
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    baseURL,
    locale: 'zh-CN',
    launchOptions: { executablePath: process.env.CHROMIUM_PATH },
  },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: baseURL,
  },
})
