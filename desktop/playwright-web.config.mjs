import { defineConfig } from '@playwright/test'

// The desktop web pane, against the app built from this checkout (npm run build first).
export default defineConfig({
  testDir: '../tests/desktop', testMatch: 'web-pane.spec.mjs',
  outputDir: '../test-results/web-pane', workers: 1, timeout: 120_000, reporter: 'list',
})
