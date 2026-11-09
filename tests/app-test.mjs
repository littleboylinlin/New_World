import { test as base } from '@playwright/test'

export const releaseEndpoint = 'https://api.github.com/repos/littleboylinlin/New_World/releases/latest'

export async function withoutRelease(context) {
  await context.route(releaseEndpoint, (route) => route.fulfill({
    status: 404, json: { message: 'Not Found' }, headers: { 'access-control-allow-origin': '*' },
  }))
  return context
}

export const test = base.extend({
  context: async ({ context }, use) => use(await withoutRelease(context)),
})

export { chromium, expect } from '@playwright/test'
