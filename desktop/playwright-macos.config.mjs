import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '../tests/desktop', testMatch: 'macos.spec.mjs',
  outputDir: '../test-results/macos', workers: 1, timeout: 180_000, reporter: 'list',
})
