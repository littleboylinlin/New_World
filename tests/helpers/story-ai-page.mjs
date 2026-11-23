import { expect } from '@playwright/test'
import { action } from '../story-settings-helpers.mjs'
import { approveAi, chatRequest } from './book-chat-page.mjs'

export const extraction = (page) => page.getByRole('dialog', { name: '从正文提取' })
export const checkDialog = (page) => page.locator('dialog[data-story-analysis="check"]')
export const results = (page) => page.getByRole('region', { name: '一致性检查结果' })
export const proposal = (page, name) => extraction(page).locator('.story-ai-proposal').filter({ has: page.getByRole('checkbox', { name, exact: true }) })
export const newSetting = (name, details = {}) => ({ name, aliases: [], tags: [], fields: [], body: '', chapters: [1], ...details })
export const extractReply = (cards = [], additions = []) => JSON.stringify({ cards, additions })
export const checkReply = (conflicts = []) => JSON.stringify({ conflicts })
export const excerpt = (request) => chatRequest(request).at(-1).content
export const suppliedCards = (request) => JSON.parse(excerpt(request).match(/^\[CARDS\] (.*)$/m)?.[1] ?? '[]')
export const finding = (cardId, original, extra = {}) => ({
  paragraph: 1, original, before: '', cardId, field: '颜色', reason: '正文与记载的颜色相反。', replacement: '戒指是银色。', ...extra,
})

export async function openCheck(page, scope = '本章', touch = false) {
  const use = (node) => touch ? node.tap() : node.click()
  await use(page.locator('.more-toggle'))
  for (const name of [/^AI 校对与总结/, /^一致性检查/, scope]) {
    await use(page.getByRole('menuitem', { name, exact: typeof name === 'string' }))
  }
  await expect(checkDialog(page)).toBeVisible()
}

export async function runStory(page, dialog, { consent = false, touch = false } = {}) {
  await expect(action(dialog, '开始')).toBeEnabled()
  if (touch) await action(dialog, '开始').tap()
  else await action(dialog, '开始').click()
  if (consent) await approveAi(page)
}
