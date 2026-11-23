import { readFile, writeFile } from 'node:fs/promises'
import { TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { devices } from '@playwright/test'
import { expect, test } from './app-test.mjs'
import { chapterHeading, editorAction, historyCount } from './editor-helpers.mjs'
import { bookAction } from './fixtures.mjs'
import { addStoryChapter } from './story-settings-helpers.mjs'
import {
  approveAi, askBook, chat, chatRequest, choices, configureChatProvider, createChatWork, manuscript, message,
  navigateTo, openBookChat, postRequests, reply, writeManuscript,
} from './helpers/book-chat-page.mjs'
import { fakeAiService } from './helpers/fake-ai.mjs'

async function seedCards(page) {
  await page.evaluate(async () => {
    const [, library, bookId, editionId] = location.hash.split('/')
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('new-world-library')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const tx = db.transaction(['editions', 'storyBoards'], 'readwrite')
      const request = tx.objectStore('editions').get([library, bookId, editionId])
      request.onsuccess = () => {
        const chapters = request.result.chapters.map(({ id }) => ({ editionId, chapterId: id }))
        const card = (name, options = {}) => ({
          id: crypto.randomUUID(), kind: 'card', x: 0, y: 0, width: 168, height: 60,
          name, aliases: [], tagIds: [], fields: [], body: '', wholeBook: false, chapters: [], states: [], ...options,
        })
        const tags = [{ id: 'world', name: '世界规则', color: '#64748b' }]
        const nodes = [
          card('潮汐规律', {
            wholeBook: true, tagIds: ['world'], fields: [{ key: '涨潮', value: '每周一次' }], body: '全书规则从不例外',
            states: [
              { ...chapters[2], text: '第三章之后的秘密状态' },
              { ...chapters[0], text: '第一章起的可见状态' },
              { ...chapters[1], text: '第二章起的可见状态' },
            ],
          }),
          card('本章关联', { chapters: [chapters[1]], body: '关联即可命中' }),
          card('沈舟', { body: '按正文姓名命中' }),
          card('月光守卫', { aliases: ['ＬＵＮＡ'], body: '按正文别名命中' }),
          card('铜笛商贩', { aliases: ['兰舟'], body: '按问题别名命中', chapters: [chapters[0]] }),
          card('未来章专属设定', { chapters: [chapters[2]], body: '无关联或命中时不要发送' }),
        ]
        tx.objectStore('storyBoards').put({ library, bookId, scene: { nodes, tags, edges: [] }, view: { x: 0, y: 0, zoom: 1 }, revision: crypto.randomUUID() })
      }
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    } finally { db.close() }
  })
}

async function selectText(page, action, length = 2) {
  await manuscript(page).click()
  await page.keyboard.press('ControlOrMeta+Home')
  for (let i = 0; i < length; i++) await page.keyboard.press('Shift+ArrowRight')
  await page.locator('.selection-toolbar .selection-ai').click()
  await page.getByRole('menuitem', { name: action, exact: typeof action === 'string' }).click()
}

test('全书上下文带当前正文、相关设定及已有摘要，指定情节才带相关章原文', async ({ page }) => {
  const fake = await fakeAiService({ reply: (request) => {
    const system = chatRequest(request)[0].content
    if (system.includes('各章的摘要')) return '缓存全书梗概。'
    if (system.includes('简洁的中文概括')) return '缓存逐章摘要。'
    return '我会根据这些资料核对情节。'
  } })
  try {
    await configureChatProvider(page, fake.url + '/v1', { contextTokens: 10000 })
    await createChatWork(page, '潮汐与铜钥匙', '老船医在黎明偷走了铜钥匙。')
    await addStoryChapter(page, '石桥')
    await expect(chapterHeading(page)).toHaveText('石桥')
    await writeManuscript(page, '沈舟跟 Luna 来到石桥，藏起了影子。')
    await addStoryChapter(page, '归港')
    await expect(chapterHeading(page)).toHaveText('归港')
    await writeManuscript(page, '港口突然出现另一艘船。')
    await seedCards(page)
    await page.getByRole('list', { name: '章节', exact: true }).getByRole('button', { name: '石桥', exact: true }).click()
    await expect(chapterHeading(page)).toHaveText('石桥')

    await openBookChat(page)
    await askBook(page, '第一章是谁偷走了铜钥匙？兰舟后来有提及这事吗？', true)
    await expect(reply(page)).toContainText('我会根据这些资料核对情节。')
    expect(postRequests(fake)).toHaveLength(1)
    const [system, user] = chatRequest(postRequests(fake)[0]).map(({ content }) => content)
    expect(system).toContain('设定冲突时明确指出')
    expect(system).toContain('不要编成既定事实')
    for (const included of [
      '[CURRENT CHAPTER 2 "石桥"]', '沈舟跟 Luna 来到石桥，藏起了影子。',
      '潮汐规律', '世界规则', '每周一次', '全书规则从不例外', '第一章起的可见状态', '第二章起的可见状态',
      '本章关联', '按正文姓名命中', '按正文别名命中', '按问题别名命中',
      '[RELATED CHAPTER 1', '老船医在黎明偷走了铜钥匙。',
    ]) expect(user).toContain(included)
    for (const excluded of ['第三章之后', '未来章专属设定', '港口突然出现', '[BOOK SUMMARY]', '[CHAPTER SUMMARY']) {
      expect(user).not.toContain(excluded)
    }
    const details = reply(page).locator('.ai-context-details')
    await expect(details.locator('summary')).toHaveText('第 2 章 · 5 张设定卡 · 1 章情节原文')
    await details.locator('summary').click()
    await expect(details.getByRole('list')).toContainText('月光守卫')
    await expect(details.getByRole('list')).toContainText('第 1 章')

    await page.locator('.more-toggle').click()
    await page.getByRole('menuitem', { name: 'AI 校对与总结' }).click()
    await page.getByRole('menuitem', { name: '总结整本' }).click()
    await approveAi(page)
    const summary = page.getByRole('dialog', { name: '总结整本' })
    await expect(summary.getByRole('button', { name: '存为灵感' })).toBeVisible()
    await summary.locator('.ai-assist-actions').getByRole('button', { name: '关闭' }).click()
    expect(postRequests(fake)).toHaveLength(5)

    await askBook(page, '这一段的节奏快吗？')
    await expect(reply(page).locator('.ai-context-details summary')).toContainText('全书摘要 · 3 章摘要')
    expect(postRequests(fake)).toHaveLength(6)
    const cached = chatRequest(postRequests(fake).at(-1)).at(-1).content
    expect(cached).toContain('[BOOK SUMMARY]\n缓存全书梗概。')
    expect(cached).toContain('[CHAPTER SUMMARY 3 "归港"]')
    expect(cached).not.toContain('[RELATED CHAPTER')
    expect(cached).not.toContain('按问题别名命中')

    // The live editor text wins over the saved record, invalidating only that chapter's cache and the aggregate.
    await manuscript(page).click()
    await page.keyboard.press('End')
    await page.keyboard.insertText('这是还在编辑的句子。')
    await askBook(page, '能概括本章吗？')
    await expect(reply(page).locator('.ai-context-details summary')).toHaveText('第 2 章 · 4 张设定卡 · 2 章摘要')
    const edited = chatRequest(postRequests(fake).at(-1)).at(-1).content
    expect(edited).toContain('这是还在编辑的句子。')
    expect(edited).not.toContain('[BOOK SUMMARY]')
    expect(edited).not.toContain('[CHAPTER SUMMARY 2')
    expect(postRequests(fake)).toHaveLength(7)
  } finally { await fake.close() }
})

test('选中提问单独标记选区并可点选继续，改文和校对仍只发送原选段', async ({ page }) => {
  const round = choices([{ question: '这两字扮演什么角色？', options: ['人名', '地名'] }])
  const fake = await fakeAiService({ reply: (request) => {
    const messages = chatRequest(request)
    if (messages[0].content.includes('校对编辑')) return '[]'
    if (messages[0].content.includes('[NW_CHOICES]')) return messages.length === 2 ? round : '把它当人名来解释。'
    return '风又起了。'
  } })
  try {
    await configureChatProvider(page, fake.url + '/v1')
    await createChatWork(page, '青山录', '青山转头离开。未选中的正文。')
    await selectText(page, '自由提问')
    await approveAi(page)
    const question = page.getByRole('dialog', { name: '自由提问' })
    await question.getByRole('textbox').fill('这两字有歧义吗？')
    await question.getByRole('button', { name: '发送', exact: true }).click()
    await expect(question.getByRole('button', { name: '地名' })).toBeVisible()
    const user = chatRequest(postRequests(fake).at(-1)).at(-1).content
    expect(user).toContain('[SELECTED TEXT]\n青山\n\n')
    expect(user).toContain('[CURRENT CHAPTER 1 "第一章"]\n青山转头离开。未选中的正文。')
    await expect(question.getByRole('textbox')).toBeVisible()
    await question.getByRole('button', { name: '人名' }).click()
    await expect(question.locator('.ai-assist-text')).toHaveText('把它当人名来解释。')
    const next = chatRequest(postRequests(fake).at(-1))
    expect(next[1].content).toBe('这两字有歧义吗？')
    expect(next[2].content).toBe(round)
    expect(next.at(-1).content).toContain('这两字扮演什么角色？\n人名')
    await question.locator('.ai-assist-actions').getByRole('button', { name: '关闭' }).click()

    for (const [action, title, sent] of [
      ['润色', '润色', '青山'],
      ['改写', '改写', '青山'],
      ['扩写', '扩写', '青山'],
      ['缩写', '缩写', '青山'],
      ['校对选区', '校对选区', '[1] 青山'],
    ]) {
      const before = postRequests(fake).length
      await selectText(page, action)
      if (action === '润色') await approveAi(page)
      await expect.poll(() => postRequests(fake).length).toBe(before + 1)
      const messages = chatRequest(postRequests(fake).at(-1))
      expect(messages.map(({ role }) => role)).toEqual(['system', 'user'])
      expect(messages.at(-1).content).toBe(sent)
      expect(messages[0].content).not.toContain('[BOOK CONTEXT]')
      await page.getByRole('dialog', { name: title, exact: true }).locator('.ai-assist-close').click()
    }
    await selectText(page, /^改语气/)
    await page.getByRole('menuitem', { name: '更温柔', exact: true }).click()
    await expect.poll(() => postRequests(fake).length).toBe(8)
    expect(chatRequest(postRequests(fake).at(-1)).at(-1).content).toBe('青山')
  } finally { await fake.close() }
})

test('对话多轮、分书保存、可以新建和确认删除，回复复制及光标插入能撤销', async ({ page, context }) => {
  const fake = await fakeAiService({ reply: () => '灯亮了。\n船靠岸。' })
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await configureChatProvider(page, fake.url + '/v1')
    const first = await createChatWork(page, '第一本书', '灯塔外面')
    await openBookChat(page)
    await askBook(page, '有灯吗？', true)
    await expect(reply(page).locator('.ai-chat-text')).toHaveText('灯亮了。\n船靠岸。')
    await askBook(page, '然后呢？')
    await expect(chat(page).getByRole('article')).toHaveCount(2)
    const messages = chatRequest(postRequests(fake).at(-1))
    expect(messages.slice(1, 3)).toEqual([
      { role: 'user', content: '有灯吗？' }, { role: 'assistant', content: '灯亮了。\n船靠岸。' },
    ])
    await reply(page).getByRole('button', { name: '复制', exact: true }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('灯亮了。\n船靠岸。')

    const before = Number(await historyCount(page) || 0)
    await manuscript(page).click()
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await reply(page).getByRole('button', { name: '插入到光标处' }).click()
    await expect(manuscript(page).locator('p')).toHaveText(['灯塔灯亮了。', '船靠岸。外面'])
    await expect.poll(() => historyCount(page)).toBe(String(before + 1))
    await manuscript(page).press('ControlOrMeta+z')
    await expect(manuscript(page)).toHaveText('灯塔外面')

    await chat(page).getByRole('button', { name: '新建对话' }).click()
    await askBook(page, '另开一个话题。')
    await expect(reply(page)).toContainText('灯亮了。')
    expect(chatRequest(postRequests(fake).at(-1))).toHaveLength(2)
    const other = await createChatWork(page, '另一本书', '这里没有灯塔。')
    await openBookChat(page)
    await expect(chat(page).getByRole('article')).toHaveCount(0)
    await askBook(page, '这是另一本书。')
    await expect(reply(page)).toContainText('灯亮了。')
    expect(chatRequest(postRequests(fake).at(-1)).at(-1).content).not.toContain('灯塔外面')

    await navigateTo(page, first)
    await expect(manuscript(page)).toHaveText('灯塔外面')
    await openBookChat(page)
    const history = chat(page).getByRole('combobox', { name: '对话历史' })
    await history.selectOption({ label: '有灯吗？' })
    await expect(chat(page).getByRole('article')).toHaveCount(2)
    await page.reload()
    await openBookChat(page)
    await history.selectOption({ label: '有灯吗？' })
    await expect(chat(page).getByRole('article')).toHaveCount(2)
    await chat(page).getByRole('button', { name: '删除对话' }).click()
    const confirm = page.getByRole('dialog', { name: '删除这段对话？' })
    await confirm.getByRole('button', { name: '取消' }).click()
    await expect(chat(page).getByRole('article')).toHaveCount(2)
    await chat(page).getByRole('button', { name: '删除对话' }).click()
    await confirm.getByRole('button', { name: '删除对话' }).click()
    await expect(history.locator('option')).toHaveText(['新建对话', '另开一个话题。'])
    await navigateTo(page, other)
    await expect(manuscript(page)).toHaveText('这里没有灯塔。')
    await openBookChat(page)
    await expect(chat(page).getByRole('log')).toContainText('这是另一本书。')
  } finally { await fake.close() }
})

async function zipText(download) {
  const zip = new ZipReader(new Uint8ArrayReader(await readFile(await download.path())))
  try {
    const entries = (await zip.getEntries()).filter((entry) => /\.json$/.test(entry.filename))
    return Object.fromEntries(await Promise.all(entries.map(async (entry) => [entry.filename, await entry.getData(new TextWriter())])))
  } finally { await zip.close() }
}

async function restoreLibrary(page, path) {
  await page.goto('/#/settings/backup')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '从备份恢复…', exact: true }).click()
  await (await chooser).setFiles(path)
  await page.getByRole('button', { name: '替换当前书库' }).click()
  await expect(page.getByText('已从备份恢复 1 部作品。')).toBeVisible()
}

test('对话的全库备份往返，单书工程不含任何对话数据', async ({ page }, info) => {
  const fake = await fakeAiService({ reply: () => '只保存在对话里的回答。' })
  try {
    await page.addInitScript(() => { window.showSaveFilePicker = undefined })
    await configureChatProvider(page, fake.url + '/v1')
    const work = await createChatWork(page, '备份对话', '手稿的正文。')
    await openBookChat(page)
    await askBook(page, '只保存在对话里的问题。', true)
    await expect(reply(page)).toContainText('只保存在对话里的回答。')
    await page.goto('/#/settings/backup')
    const backup = page.waitForEvent('download')
    await page.getByRole('button', { name: '立即备份', exact: true }).click()
    const archive = await backup
    const path = info.outputPath('chat-backup.zip')
    await archive.saveAs(path)
    const manifest = JSON.parse((await zipText(archive))['new-world-backup.json'])
    expect(manifest.version).toBe(5)
    expect(manifest.bookChats[0].turns[0]).toMatchObject({
      question: '只保存在对话里的问题。', reply: { text: '只保存在对话里的回答。', context: { current: { number: 1 } } },
    })

    await page.goto('/#/original')
    await bookAction(page, '导出 New_World 工程（.newworld）', '备份对话')
    const projectDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: '保存工程', exact: true }).click()
    const project = await zipText(await projectDownload)
    expect(JSON.stringify(project)).not.toMatch(/只保存在对话里|bookChats/)

    await navigateTo(page, work)
    await expect(manuscript(page)).toHaveText('手稿的正文。')
    await openBookChat(page)
    await chat(page).getByRole('button', { name: '删除对话' }).click()
    await page.getByRole('dialog', { name: '删除这段对话？' }).getByRole('button', { name: '删除对话' }).click()
    await expect(chat(page).getByRole('article')).toHaveCount(0)
    await restoreLibrary(page, path)
    await navigateTo(page, work)
    await expect(manuscript(page)).toHaveText('手稿的正文。')
    await openBookChat(page)
    await expect(chat(page).getByRole('log')).toContainText('只保存在对话里的问题。')
    await expect(reply(page)).toContainText('只保存在对话里的回答。')
    await expect(reply(page).locator('summary')).toHaveText('第 1 章')

    const legacy = { ...manifest, version: 4 }
    delete legacy.bookChats
    const old = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
    await old.add('new-world-backup.json', new TextReader(JSON.stringify(legacy)))
    const oldPath = info.outputPath('chat-legacy-v4.zip')
    await writeFile(oldPath, await old.close())
    await restoreLibrary(page, oldPath)
    await navigateTo(page, work)
    await expect(manuscript(page)).toHaveText('手稿的正文。')
    await openBookChat(page)
    await expect(chat(page).getByRole('combobox')).toBeEnabled()
    await expect(chat(page).getByRole('article')).toHaveCount(0)
  } finally { await fake.close() }
})

test('对话可以停止流式请求，保留已收到的文字', async ({ page }) => {
  const fake = await fakeAiService({ reply: () => '你好，回复还会继续。' })
  try {
    await configureChatProvider(page, fake.url + '/hang/v1')
    await createChatWork(page, '中途停下', '书中的正文。')
    await openBookChat(page)
    await askBook(page, '继续说。', true)
    await expect(chat(page).locator('.ai-assist-streaming')).toHaveText('你好，回复还会继续。')
    await chat(page).getByRole('button', { name: '停止', exact: true }).click()
    await expect(reply(page)).toContainText('已停止')
    await expect(reply(page)).toContainText('你好，回复还会继续。')
    await expect.poll(() => postRequests(fake).at(-1)?.closed).toBe(true)
  } finally { await fake.close() }
})

test('没有配置时引导去设置，额度不足时保留对话并显示友好提示', async ({ page }) => {
  const fake = await fakeAiService()
  try {
    const work = await createChatWork(page, '等配置', '书中的正文。')
    await openBookChat(page)
    await expect(chat(page).getByRole('link', { name: '去设置' })).toHaveAttribute('href', '#/settings/ai')
    await chat(page).getByRole('link', { name: '去设置' }).click()
    await configureChatProvider(page, fake.url + '/quota/v1')
    await navigateTo(page, work)
    await expect(manuscript(page)).toBeVisible()
    await openBookChat(page)
    await askBook(page, '还能继续吗？', true)
    await expect(chat(page).getByRole('status')).toContainText('额度不足')
    await expect(chat(page).getByRole('log')).toContainText('还能继续吗？')
    await expect(message(page)).toBeEditable()
  } finally { await fake.close() }
})

for (const preset of ['OpenAI Responses', 'Anthropic', 'Gemini']) {
  test(`${preset} 的文字选项可点，解析失败的下一轮原样显示`, async ({ page }) => {
    const malformed = '[NW_CHOICES]\n格式错误\n[/NW_CHOICES]'
    const fake = await fakeAiService({ reply: (request) => chatRequest(request).length > 2
      ? malformed : choices([{ question: '谁该留下？', options: ['船医', '守卫'] }]) })
    try {
      await configureChatProvider(page, fake.url + '/v1', { preset })
      await createChatWork(page, '离开港口', '三个人快到港口了。')
      await openBookChat(page)
      await askBook(page, '谁留下？', true)
      await reply(page).getByRole('button', { name: '船医', exact: true }).click()
      await expect(reply(page).locator('.ai-chat-text')).toHaveText(malformed)
      await expect(reply(page).locator('.ai-clarification')).toHaveCount(0)
      const request = chatRequest(postRequests(fake).at(-1))
      expect(request.map(({ role }) => role)).toEqual(['system', 'user', 'assistant', 'user'])
      expect(request.at(-1).content).toContain('谁该留下？\n船医')
      expect(request.at(-1).content).toContain('三个人快到港口了。')
    } finally { await fake.close() }
  })
}

test.describe('iPhone 尺寸', () => {
  test.use({ viewport: devices['iPhone 13'].viewport, isMobile: true, hasTouch: true })
  test('侧栏抽屉和多题选项可触控，也能自由输入答案 @webkit', async ({ page }) => {
    const round = choices([
      { question: '从哪里出发？', options: ['港口', '林地'] },
      { question: '什么时候出发？', options: ['白天', '晚上'] },
    ])
    const fake = await fakeAiService({ reply: (request) => chatRequest(request).length === 2 ? round : '收到，按你的选择写。' })
    try {
      await configureChatProvider(page, fake.url + '/v1')
      await createChatWork(page, '手机写作', '行李都放在门边。')
      await openBookChat(page)
      await expect(page.locator('.workbench-end')).toHaveAttribute('data-mode', 'overlay')
      await askBook(page, '用哪条路线?', true)
      await reply(page).getByRole('button', { name: '港口', exact: true }).tap()
      await expect(reply(page).getByRole('button', { name: '发送选项' })).toBeDisabled()
      await reply(page).getByRole('button', { name: '晚上', exact: true }).tap()
      await reply(page).getByRole('button', { name: '发送选项' }).tap()
      await expect(reply(page)).toContainText('收到，按你的选择写。')
      expect(chatRequest(postRequests(fake).at(-1)).at(-1).content).toContain('从哪里出发？\n港口\n\n什么时候出发？\n晚上')
      await chat(page).getByRole('button', { name: '新建对话' }).tap()
      await askBook(page, '再给点选择。')
      await expect(reply(page).getByRole('button', { name: '林地', exact: true })).toBeVisible()
      await askBook(page, '沿着海边走，中午出发。')
      await expect(reply(page)).toContainText('收到，按你的选择写。')
      expect(chatRequest(postRequests(fake).at(-1)).at(-1).content).toContain('沿着海边走，中午出发。')
      await chat(page).getByRole('button', { name: '收起 AI 对话' }).tap()
      await expect(chat(page)).toBeHidden()
      await openBookChat(page)
      await expect(reply(page)).toContainText('收到，按你的选择写。')
    } finally { await fake.close() }
  })
})
