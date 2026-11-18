import { defineConfig } from '@playwright/test'

const baseURL = 'http://127.0.0.1:4173'

export default defineConfig({
  testDir: './tests',
  testIgnore: '**/tests/desktop/**',
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  use: {
    baseURL,
    locale: 'zh-CN',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: { executablePath: process.env.CHROMIUM_PATH } } },
    // Key cases also run in WebKit (Safari's engine), including iPhone sizes, tagged @webkit.
    { name: 'webkit', use: { browserName: 'webkit' }, grep: /@webkit/ },
  ],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: baseURL,
  },
})
