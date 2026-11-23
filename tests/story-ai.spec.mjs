import { devices } from '@playwright/test'
import { expect, test } from './app-test.mjs'
import { chapterHeading, editorAction, historyCount } from './editor-helpers.mjs'
import { file } from './fixtures.mjs'
import { chooseImportType } from './navigation-helpers.mjs'
import { action, addStoryChapter, boardState, card, cardPanel, openMenu, openStoryWindow, seedBoard } from './story-settings-helpers.mjs'
import { configureChatProvider, createChatWork, manuscript, navigateTo, postRequests, writeManuscript } from './helpers/book-chat-page.mjs'
import { fakeAiService } from './helpers/fake-ai.mjs'
import { checkDialog, checkReply, excerpt, extractReply, extraction, finding, newSetting, openCheck, proposal, results, runStory, suppliedCards } from './helpers/story-ai-page.mjs'

const scope = (dialog, name) => dialog.getByRole('radio', { name, exact: true })
const version = (dialog) => dialog.getByLabel('正文版本')
const canon = (extra = {}) => card('canon-ring', '银戒指', 100, 100, {
  wholeBook: true, aliases: ['月戒'], fields: [{ key: '颜色', value: '银色' }], body: '作者写下的正文', ...extra,
})
const circle = '戒指是红色。'

test('全书按章提取，勾选修改和合并一次采用，卡片不重叠并可一步撤销', async ({ page }) => {
  const fake = await fakeAiService({ reply: (request) => excerpt(request).startsWith('[CHAPTER 1]')
    ? extractReply([
      newSetting('月戒', { aliases: ['银圈'], fields: [{ key: '颜色', value: '铜色' }, { key: '材质', value: '白银' }] }),
      newSetting('古井', { tags: ['地点'], body: '在旧港' }), newSetting('可略过的建议'),
    ], [{ cardId: 'canon-ring', aliases: ['潮戒'], fields: [{ key: '出处', value: '港口' }] }])
    : extractReply([newSetting('古井', { body: '位于防波堤', chapters: [2] }), newSetting('船铃', { chapters: [2] })]) })
  try {
    await configureChatProvider(page, fake.url + '/v1')
    await createChatWork(page, '古井与港口', '月戒是白银打成，古井的水映出堤岸。')
    await addStoryChapter(page, '退潮')
    await writeManuscript(page, '月光下还能看见古井，船铃响了。')
    const story = await openStoryWindow(page)
    const state = { nodes: [canon({ width: 550, height: 470 })], tags: [], edges: [] }
    await seedBoard(story, state)
    await openMenu(story, '从正文提取')
    await expect(scope(extraction(story), '本章')).toBeChecked()
    await scope(extraction(story), '全书').check()
    expect(postRequests(fake)).toHaveLength(0)
    await runStory(story, extraction(story), { consent: true })
    await expect(proposal(story, '古井')).toContainText('第 1 章 · 第一章 · 第 2 章 · 退潮')
    await expect(proposal(story, '月戒').getByLabel('可能是同一个').locator('option:checked')).toHaveText('合并到「银戒指」')
    const dialog = extraction(story)
    await action(dialog, '全不选').click()
    await expect(action(dialog, '采用所选')).toBeDisabled()
    await action(dialog, '全选').click()
    await proposal(story, '可略过的建议').getByRole('checkbox').uncheck()
    await proposal(story, '古井').locator('summary').click()
    await proposal(story, '古井').getByLabel('名称', { exact: true }).fill('港口古井')
    const edited = proposal(story, '港口古井')
    await edited.getByLabel('正文', { exact: true }).fill('井在堤脚，可从石阶下去。')
    await action(edited, '添加字段').click()
    await edited.getByLabel('字段名', { exact: true }).fill('位置')
    await edited.getByLabel('字段内容', { exact: true }).fill('堤脚')
    await action(dialog, '采用所选').click()
    await expect(dialog).toBeHidden()
    const saved = (await boardState(story)).scene
    expect(saved.nodes.map(({ name }) => name)).toEqual(['银戒指', '港口古井', '船铃'])
    expect(saved.nodes[0]).toMatchObject({
      aliases: ['月戒', '银圈', '潮戒'], body: '作者写下的正文',
      fields: [{ key: '颜色', value: '银色' }, { key: '材质', value: '白银' }, { key: '出处', value: '港口' }],
    })
    expect(saved.nodes[1]).toMatchObject({ body: '井在堤脚，可从石阶下去。', fields: [{ key: '位置', value: '堤脚' }] })
    expect(saved.nodes[1].chapters).toHaveLength(2)
    expect(saved.tags.map(({ name }) => name)).toEqual(['地点'])
    for (const [index, a] of saved.nodes.entries()) for (const b of saved.nodes.slice(index + 1)) {
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true)
    }
    expect(postRequests(fake).map((request) => excerpt(request).match(/^\[CHAPTER (\d+)\]/)?.[1])).toEqual(['1', '2'])
    await action(story, '撤销画布操作').click()
    await expect.poll(async () => (await boardState(story)).scene).toEqual(state)
  } finally { await fake.close() }
})

test('一致性检查按章使用有效状态，可定位、改正文、打开卡片及记住忽略', async ({ page }) => {
  const nextQuote = '戒指仍是蓝色。'
  const fake = await fakeAiService({ reply(request) {
    const text = excerpt(request)
    if (text.includes(circle)) return checkReply([finding('canon-ring', circle)])
    if (text.includes(nextQuote)) return checkReply([finding('canon-ring', nextQuote, {
      field: '@state', reason: '第二章起是绿色。', replacement: '戒指是绿色。',
    })])
    return checkReply()
  } })
  try {
    await configureChatProvider(page, fake.url + '/v1', { rememberKey: true })
    await createChatWork(page, '戒指档案', circle)
    await addStoryChapter(page, '第二夜')
    await writeManuscript(page, nextQuote)
    await addStoryChapter(page, '第三夜')
    await writeManuscript(page, '大家看着船出海。')
    const story = await openStoryWindow(page)
    const chapters = await page.evaluate(async () => {
      const key = location.hash.slice(2).split('/')
      const db = await new Promise((resolve) => { const req = indexedDB.open('new-world-library'); req.onsuccess = () => resolve(req.result) })
      const value = await new Promise((resolve) => { const req = db.transaction('editions').objectStore('editions').get(key); req.onsuccess = () => resolve(req.result) })
      db.close()
      return value.chapters.map(({ id }) => ({ editionId: key[2], chapterId: id }))
    })
    await seedBoard(story, { nodes: [canon({ states: [
      { ...chapters[1], text: '自这一章起，戒指是绿色。' }, { ...chapters[2], text: '后来变成黑色。' },
    ] })], tags: [], edges: [] })
    await openCheck(page, '全书')
    await expect(scope(checkDialog(page), '全书')).toBeChecked()
    await expect(version(checkDialog(page)).locator('option:checked')).toHaveText(/编辑版本/)
    await runStory(page, checkDialog(page), { consent: true })
    const found = results(page)
    await expect(found.getByRole('heading', { level: 2 })).toHaveText('检查结果 · 2 处')
    const [first, second, third] = postRequests(fake)
    expect(suppliedCards(first)[0]).not.toHaveProperty('state')
    expect(suppliedCards(second)[0].state).toBe('自这一章起，戒指是绿色。')
    expect(suppliedCards(third)[0].state).toBe('后来变成黑色。')
    expect(excerpt(first)).not.toContain(nextQuote)
    await action(found, circle).click()
    await expect(chapterHeading(page)).toHaveText('第一章')
    await expect(manuscript(page).locator('.found-text-current')).toHaveText(circle)
    await action(found, '展开结果').click()
    const firstFinding = found.locator('.story-ai-conflict').filter({ hasText: circle })
    await action(firstFinding, '改设定').click()
    await expect(cardPanel(story).getByLabel('名称', { exact: true })).toHaveValue('银戒指')
    await action(found, '展开结果').click()
    await action(firstFinding, '改正文').click()
    const review = page.getByRole('dialog', { name: '一致性检查' })
    await expect(review).toBeVisible()
    await action(review, '全部采用').click()
    await expect(manuscript(page)).toHaveText('戒指是银色。')
    await expect.poll(() => historyCount(page)).toBe('1')
    await action(review, '撤销').click()
    await expect(manuscript(page)).toHaveText(circle)
    await action(review.locator('.ai-assist-actions'), '关闭').click()
    await action(found, '展开结果').click()
    await action(firstFinding, '忽略').click()
    await expect(found.getByRole('heading', { level: 2 })).toHaveText('检查结果 · 1 处')
    await writeManuscript(page, circle + '\n一阵风经过。')
    await page.reload()
    await expect(manuscript(page)).toBeVisible()
    await openCheck(page, '全书')
    await runStory(page, checkDialog(page))
    await expect(results(page)).toContainText(nextQuote)
    await expect(results(page)).not.toContainText(circle)
  } finally { await fake.close() }
})

test('范围默认当前编辑版本，切换版本或原文件后从结果跳到对应正文', async ({ page }) => {
  const original = '原文件里，戒指是红色。'
  const old = '旧编辑版本里，戒指是红色。'
  const current = '当前编辑版本里，戒指是红色。'
  const fake = await fakeAiService({ reply(request) {
    const quote = [original, old, current].find((text) => excerpt(request).includes(text))
    return checkReply(quote ? [finding('canon-ring', quote)] : [])
  } })
  try {
    await configureChatProvider(page, fake.url + '/v1')
    await navigateTo(page, '#/original')
    await page.locator('input[type=file]').setInputFiles(file('原始戒指.txt', original))
    await chooseImportType(page, 'original')
    await page.getByRole('link', { name: '查看 原始戒指', exact: true }).click()
    await action(page, '转换为编辑稿').click()
    await expect(manuscript(page)).toBeVisible()
    const previousHash = new URL(page.url()).hash
    await writeManuscript(page, old)
    await editorAction(page, '另存为独立版本')
    const save = page.getByRole('dialog', { name: '另存为独立版本' })
    await save.getByLabel('版本名').fill('当前稿')
    await action(save, '保存独立版本').click()
    await expect(save).toBeHidden()
    await expect(page).not.toHaveURL(new RegExp(previousHash + '$'))
    await writeManuscript(page, current)
    const story = await openStoryWindow(page)
    await seedBoard(story, { nodes: [canon()], tags: [], edges: [] })
    await openCheck(page, '全书')
    await expect(version(checkDialog(page)).locator('option:checked')).toHaveText('编辑版本 · 当前稿')
    await version(checkDialog(page)).selectOption(previousHash.split('/').at(-1))
    await runStory(page, checkDialog(page), { consent: true })
    await expect(results(page)).toContainText(old)
    await action(results(page), old).click()
    await expect(page).toHaveURL(new RegExp(previousHash + '$'))
    await expect(manuscript(page).locator('.found-text-current')).toHaveText(old)
    await openCheck(page, '全书')
    const originalOption = version(checkDialog(page)).locator('option').filter({ hasText: '原文件 · 原始戒指.txt' })
    await version(checkDialog(page)).selectOption(await originalOption.getAttribute('value'))
    await runStory(page, checkDialog(page))
    await expect(results(page)).toContainText('原文件 · 原始戒指.txt')
    await expect(action(results(page), '改正文')).toHaveCount(0)
    await action(results(page), original).click()
    await expect(page.locator('.reader-panel mark.story-ai-quote')).toHaveText(original)
    await expect(manuscript(page)).toHaveCount(0)
  } finally { await fake.close() }
})

test('选中的几章只发送已勾选的稿件，错误 JSON 显示提示 @webkit', async ({ page }) => {
  const fake = await fakeAiService({ reply: () => '这里不是 JSON' })
  try {
    await configureChatProvider(page, fake.url + '/v1')
    await createChatWork(page, '选择章节', '不要发送这章。')
    await addStoryChapter(page, '仅选这一章')
    await writeManuscript(page, '这章应当发送。')
    const story = await openStoryWindow(page)
    await action(story, '从正文提取').click()
    const dialog = extraction(story)
    await scope(dialog, '选中的几章').check()
    await expect(dialog.getByRole('checkbox', { name: '第 2 章 · 仅选这一章' })).toBeChecked()
    await runStory(story, dialog, { consent: true })
    await expect(dialog).toContainText('有 1 项 AI 返回内容无法读取或定位，已跳过。')
    expect(postRequests(fake)).toHaveLength(1)
    expect(excerpt(postRequests(fake)[0])).toContain('这章应当发送。')
    expect(excerpt(postRequests(fake)[0])).not.toContain('不要发送这章。')
    await expect(action(dialog, '采用所选')).toHaveCount(0)
    await action(dialog, '关闭').click()
    await expect(dialog).toBeHidden()
  } finally { await fake.close() }
})

test('选区检查只提交选区，并可停止正在处理的请求', async ({ page }) => {
  const fake = await fakeAiService()
  try {
    await configureChatProvider(page, fake.url + '/timeout/v1')
    await createChatWork(page, '停止检查', circle + '不要发送这句话。')
    const story = await openStoryWindow(page)
    await seedBoard(story, { nodes: [canon()], tags: [], edges: [] })
    await manuscript(page).click()
    await page.keyboard.press('ControlOrMeta+Home')
    for (const _ of circle) await page.keyboard.press('Shift+ArrowRight')
    await page.locator('.selection-toolbar .selection-ai').click()
    await page.getByRole('menuitem', { name: '一致性检查' }).click()
    await expect(scope(checkDialog(page), '选区')).toBeChecked()
    await runStory(page, checkDialog(page), { consent: true })
    await expect.poll(() => postRequests(fake).length).toBe(1)
    expect(excerpt(postRequests(fake)[0])).toContain(circle)
    expect(excerpt(postRequests(fake)[0])).not.toContain('不要发送这句话')
    await action(checkDialog(page), '停止').click()
    await expect(results(page)).toContainText('已停止。')
    await expect.poll(() => postRequests(fake)[0].closed).toBe(true)
  } finally { await fake.close() }
})

test('设定窗口停止全书提取会取消当前请求并保留已处理章节的建议', async ({ page }) => {
  const { promise, resolve } = Promise.withResolvers()
  const fake = await fakeAiService({ reply: (request) => excerpt(request).startsWith('[CHAPTER 1]')
    ? extractReply([newSetting('第一章里的船')]) : promise })
  try {
    await configureChatProvider(page, fake.url + '/v1')
    await createChatWork(page, '停止全书提取', '第一章写一艘船。')
    await addStoryChapter(page, '等候')
    await writeManuscript(page, '第二章写等待。')
    await addStoryChapter(page, '冒险')
    await writeManuscript(page, '第三章写冒险。')
    const story = await openStoryWindow(page)
    await action(story, '从正文提取').click()
    const dialog = extraction(story)
    await scope(dialog, '全书').check()
    await runStory(story, dialog, { consent: true })
    await expect(dialog.getByText('正在处理第 2 / 3 章「等候」的第 1 批')).toBeVisible()
    await expect.poll(() => postRequests(fake).length).toBe(2)
    await action(dialog, '停止').click()
    await expect(dialog).toContainText('已停止。')
    await expect(proposal(story, '第一章里的船')).toBeVisible()
    await expect.poll(() => postRequests(fake)[1].closed).toBe(true)
    expect(postRequests(fake)).toHaveLength(2)
  } finally {
    resolve(extractReply())
    await fake.close()
  }
})

for (const preset of ['OpenAI Responses', 'Anthropic', 'Gemini']) {
  test(`${preset} 使用 JSON 提取和检查，解析失败保留已完成结果`, async ({ page }) => {
    const fake = await fakeAiService({ reply(request) {
      if (!suppliedCards(request).length) {
        const fence = String.fromCharCode(96).repeat(3)
        return fence + 'json\n' + extractReply([newSetting('旧戒指', { fields: [{ key: '颜色', value: '银色' }] })]) + '\n' + fence
      }
      return checkReply([finding(suppliedCards(request)[0].id, circle), { invalid: true }])
    } })
    try {
      await configureChatProvider(page, fake.url + '/v1', { preset })
      await createChatWork(page, '四协议中的戒指', circle)
      const story = await openStoryWindow(page)
      await action(story, '从正文提取').click()
      await runStory(story, extraction(story), { consent: true })
      await expect(proposal(story, '旧戒指')).toBeVisible()
      await action(extraction(story), '采用所选').click()
      await expect(extraction(story)).toBeHidden()
      await openCheck(page)
      await runStory(page, checkDialog(page))
      await expect(results(page)).toContainText(circle)
      await expect(results(page)).toContainText('有 1 项 AI 返回内容无法读取或定位，已跳过。')
      expect(postRequests(fake)).toHaveLength(2)
    } finally { await fake.close() }
  })
}

test.describe('iPhone 尺寸', () => {
  test.use({ viewport: devices['iPhone 13'].viewport, isMobile: true, hasTouch: true })
  test('设定确认列表和检查结果可触控 @webkit', async ({ page }) => {
    const fake = await fakeAiService({ reply: (request) => suppliedCards(request).length
      ? checkReply([finding(suppliedCards(request)[0].id, circle)])
      : extractReply([newSetting('可触控戒指', { fields: [{ key: '颜色', value: '银色' }] }), newSetting('不采用')]) })
    try {
      await configureChatProvider(page, fake.url + '/v1')
      await createChatWork(page, '手机检查', circle)
      const story = await openStoryWindow(page)
      await action(story, '从正文提取').tap()
      await runStory(story, extraction(story), { consent: true, touch: true })
      await proposal(story, '不采用').getByRole('checkbox').tap()
      await expect(proposal(story, '不采用').getByRole('checkbox')).not.toBeChecked()
      await action(extraction(story), '采用所选').tap()
      await expect(extraction(story)).toBeHidden()
      await openCheck(page, '本章', true)
      await runStory(page, checkDialog(page), { touch: true })
      await action(results(page), circle).tap()
      await expect(manuscript(page).locator('.found-text-current')).toHaveText(circle)
      await action(results(page), '展开结果').tap()
      await action(results(page), '忽略').tap()
      await expect(results(page)).toContainText('检查结果 · 0 处')
    } finally { await fake.close() }
  })
})
