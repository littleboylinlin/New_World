import { test as base } from '@playwright/test'

export const releaseEndpoint = 'https://api.github.com/repos/littleboylinlin/New_World/releases/latest'

export async function withoutRelease(context) {
  await context.route(releaseEndpoint, (route) => route.fulfill({
    status: 404, json: { message: 'Not Found' }, headers: { 'access-control-allow-origin': '*' },
  }))
  return context
}

// The web first-visit note sits in the corner; specs about it use the plain Playwright test.
export async function pastFirstVisit(context) {
  await context.addInitScript(() => { try { localStorage.setItem('new-world:web-notice-seen', '1') } catch { /* Opaque pages have no storage. */ } })
  return context
}

export const test = base.extend({
  context: async ({ context }, use) => use(await pastFirstVisit(await withoutRelease(context))),
})

export { chromium, expect } from '@playwright/test'
