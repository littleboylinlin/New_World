import { defineConfig } from '@playwright/test'

export default defineConfig({
  // On CI a test that fails is run once more: a real bug fails again, a one-off timeout shows as flaky.
  retries: process.env.CI ? 1 : 0,
  testDir: '../tests/desktop', testMatch: 'macos.spec.mjs',
  outputDir: '../test-results/macos', workers: 1, timeout: 180_000, reporter: 'list',
})
