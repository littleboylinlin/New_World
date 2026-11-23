import { expect } from '@playwright/test'
import { startWork } from '../navigation-helpers.mjs'
import { saveNow } from '../editor-helpers.mjs'

export const manuscript = (page) => page.getByRole('textbox', { name: '章节正文', exact: true })
export const chat = (page) => page.getByRole('region', { name: 'AI 对话', exact: true })
export const reply = (page) => chat(page).getByRole('article', { name: 'AI 回复' }).last()
export const message = (page) => chat(page).getByRole('textbox', { name: '对话消息' })
export const postRequests = (fake) => fake.requests.filter(({ method }) => method === 'POST')

export async function navigateTo(page, hash) {
  if (page.url() === 'about:blank') await page.goto('/' + hash)
  else await page.evaluate((target) => { location.hash = target }, hash)
}

export async function configureChatProvider(page, url, { preset = 'OpenAI Chat Completions', contextTokens } = {}) {
  await navigateTo(page, '#/settings/ai')
  const settings = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'AI 服务', exact: true }) })
  await settings.getByRole('button', { name: '新建配置' }).click()
  await settings.getByRole('button', { name: preset, exact: true }).click()
  await expect(settings.locator('.aip-presets')).toBeHidden()
  await settings.getByLabel('Base URL').fill(url)
  await settings.getByLabel('API Key').fill('fake-key')
  await settings.getByLabel('模型', { exact: true }).fill('example')
  if (contextTokens) {
    await settings.getByRole('button', { name: '生成参数' }).click()
    await settings.getByLabel('上下文窗口 token').fill(String(contextTokens))
  }
  await settings.getByRole('button', { name: '保存配置' }).click()
  await expect(settings.getByRole('status').filter({ hasText: '配置已保存。' })).toBeVisible()
}

export async function writeManuscript(page, text) {
  await manuscript(page).fill(text)
  await saveNow(page)
  await expect(page.locator('.save-status')).toHaveText('已保存')
}

export async function createChatWork(page, name, text) {
  await navigateTo(page, '#/original')
  await startWork(page)
  await page.getByRole('textbox', { name: '作品名' }).fill(name)
  await page.getByRole('button', { name: '创建小说' }).click()
  await expect(manuscript(page)).toBeVisible()
  await writeManuscript(page, text)
  return new URL(page.url()).hash
}

export async function openBookChat(page) {
  if (!(await chat(page).isVisible())) {
    await page.locator('.more-toggle').click()
    await page.getByRole('menuitem', { name: 'AI 对话', exact: true }).click()
  }
  await expect(chat(page)).toBeVisible()
}

export async function approveAi(page) {
  const confirm = page.getByRole('dialog', { name: '发送前确认' })
  await confirm.getByRole('button', { name: '知道了，继续' }).click()
}

export async function askBook(page, question, consent = false) {
  await message(page).fill(question)
  await chat(page).getByRole('button', { name: '发送', exact: true }).click()
  if (consent) await approveAi(page)
}

export function choices(questions, preface = '') {
  return `${preface ? preface + '\n' : ''}[NW_CHOICES]\n${JSON.stringify(questions)}\n[/NW_CHOICES]`
}

export function chatRequest(request) {
  const { body } = request
  if (body.contents) return [
    { role: 'system', content: body.systemInstruction.parts[0].text },
    ...body.contents.map(({ role, parts }) => ({ role: role === 'model' ? 'assistant' : role, content: parts[0].text })),
  ]
  if (body.input) return body.input
  return body.system ? [{ role: 'system', content: body.system }, ...body.messages] : body.messages
}
