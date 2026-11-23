import { expect } from '@playwright/test'
import { approveAi, createChatWork, manuscript, postRequests } from '../helpers/book-chat-page.mjs'
import { fakeAiService } from '../helpers/fake-ai.mjs'
import { checkDialog, checkReply, extractReply, extraction, finding, newSetting, proposal, results, runStory, suppliedCards } from '../helpers/story-ai-page.mjs'
import { action, cardPanel, openMenu, openStoryWindow } from '../story-settings-helpers.mjs'

export async function desktopStoryAiFlow(launch, stop, title) {
  const quote = '戒指是红色。'
  const fake = await fakeAiService({ reply(request) {
    const [card] = suppliedCards(request)
    return card ? checkReply([finding(card.id, quote)])
      : extractReply([newSetting('银戒指', { fields: [{ key: '颜色', value: '银色' }] })])
  } })
  let app
  try {
    app = await launch()
    const page = await app.firstWindow()
    const saved = await page.evaluate(async (baseUrl) => {
      const provider = window.newWorldDesktop.aiProvider
      const profile = await provider.call('saveProfile', { config: { name: 'Local story test', baseUrl, protocol: 'openai-chat', auth: { kind: 'none' }, model: 'example' } })
      return profile.ok ? provider.call('setRouting', { defaultProfileId: profile.data.id, byFeature: {} }) : profile
    }, fake.url + '/cors/v1')
    expect(saved).toMatchObject({ ok: true })
    await createChatWork(page, title, quote)
    const story = await openStoryWindow(page, app)
    const access = await story.evaluate(async () => {
      const provider = window.newWorldDesktop.aiProvider
      return [
        await provider.call('exportConfig'),
        await provider.start(crypto.randomUUID(), { feature: 'ask', messages: [{ role: 'user', text: 'test' }] }),
      ]
    })
    expect(access).toMatchObject([{ ok: false, error: { code: 'forbidden' } }, false])
    await action(story, '从正文提取').click()
    await runStory(story, extraction(story))
    await approveAi(story)
    await expect(proposal(story, '银戒指')).toBeVisible()
    await action(extraction(story), '采用所选').click()
    await expect(extraction(story)).toBeHidden()
    await openMenu(story, '一致性检查')
    await runStory(story, checkDialog(story))
    await expect(results(story)).toContainText(quote)
    await action(results(story), '改设定').click()
    await expect(cardPanel(story).getByLabel('名称', { exact: true })).toHaveValue('银戒指')
    await action(results(story), '展开结果').click()
    await action(results(story), quote).click()
    await expect(manuscript(page).locator('.found-text-current')).toHaveText(quote)
    expect(postRequests(fake)).toHaveLength(2)
  } finally {
    try { if (app) await stop(app) }
    finally { await fake.close() }
  }
}
