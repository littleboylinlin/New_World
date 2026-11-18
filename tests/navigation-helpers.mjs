import { expect } from '@playwright/test'

export async function startWork(page, library = 'original') {
  await page.getByRole('button', { name: /^(新建作品|New work)$/ }).click()
  await page.locator('.type-options button.mode-' + library).click()
}

export async function activeLibrary(page) {
  return page.locator('.segment[aria-pressed="true"][data-filter]').getAttribute('data-filter')
}

export async function chooseImportType(page, library) {
  const type = library ?? await activeLibrary(page)
  await page.locator('.type-options button.mode-' + (type === 'reference' ? type : 'original')).click()
}

export async function openDrawer(page) {
  const toggle = page.locator('#drawer-toggle')
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  }
}
