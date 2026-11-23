import { expect } from '@playwright/test'
import {
  askBook, chat, chatRequest, choices, createChatWork, manuscript, navigateTo, openBookChat, postRequests, reply,
} from '../helpers/book-chat-page.mjs'
import { fakeAiService } from '../helpers/fake-ai.mjs'

/** Exercises a packaged renderer, main-process streaming and storage across two separate launches. */
export async function desktopBookChatFlow(launch, stop, title) {
  const round = choices([{ question: '谁接管灯塔？', options: ['船医', '守卫'] }])
  const fake = await fakeAiService({ reply: (request) => chatRequest(request).length === 2 ? round : '船医接管灯塔。' })
  let app
  try {
    app = await launch()
    let page = await app.firstWindow()
    const configured = await page.evaluate(async (url) => {
      const provider = window.newWorldDesktop.aiProvider
      const saved = await provider.call('saveProfile', {
        config: { name: 'Local test', baseUrl: url, protocol: 'openai-chat', auth: { kind: 'none' }, model: 'example' },
      })
      if (!saved.ok) return saved
      return provider.call('setRouting', { defaultProfileId: saved.data.id, byFeature: {} })
    }, fake.url + '/cors/v1')
    expect(configured).toMatchObject({ ok: true })
    const work = await createChatWork(page, title, '风穿过空灯塔。')
    await openBookChat(page)
    await askBook(page, '下一幕由谁接管？', true)
    await reply(page).getByRole('button', { name: '船医', exact: true }).click()
    await expect(reply(page)).toContainText('船医接管灯塔。')
    expect(chatRequest(postRequests(fake).at(-1)).at(-1).content).toContain('风穿过空灯塔。')
    await stop(app)
    app = undefined

    app = await launch()
    page = await app.firstWindow()
    await navigateTo(page, work)
    await expect(manuscript(page)).toHaveText('风穿过空灯塔。')
    await openBookChat(page)
    await expect(chat(page).getByRole('article')).toHaveCount(2)
    await expect(reply(page)).toContainText('船医接管灯塔。')
    await expect(reply(page).locator('summary')).toHaveText('第 1 章')
    expect(postRequests(fake)).toHaveLength(2)
  } finally {
    try { if (app) await stop(app) }
    finally { await fake.close() }
  }
}
