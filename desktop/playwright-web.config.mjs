import { defineConfig } from '@playwright/test'

// The desktop web pane, against the app built from this checkout (npm run build first).
export default defineConfig({
  // On CI a test that fails is run once more: a real bug fails again, a one-off timeout shows as flaky.
  retries: process.env.CI ? 1 : 0,
  testDir: '../tests/desktop', testMatch: 'web-pane.spec.mjs',
  outputDir: '../test-results/web-pane', workers: 1, timeout: 120_000, reporter: 'list',
})
