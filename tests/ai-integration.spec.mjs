import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './app-test.mjs'

const require = createRequire(import.meta.url)
const { createAiStore } = require('../desktop/ai-store.cjs')
const { createAiBridge } = require('../desktop/ai-bridge.cjs')

async function mountAiHarness(page, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-ai-e2e-'))
  const store = createAiStore(dir)
  const pendingCalls = new Map()
  let attentionCalls = 0

  const bridge = createAiBridge({
    store,
    bindPort: 0,
    confirmTimeoutMs: options.confirmTimeoutMs ?? 30_000,
    onAttentionNeeded: () => { attentionCalls++ },
    onPromptConfirmation: (request) => {
      void page.evaluate((req) => {
        window.__nwAiEvents?.confirmOpen?.(req)
      }, request).catch(() => {})
    },
    onCloseConfirmation: (detail) => {
      void page.evaluate((d) => {
        window.__nwAiEvents?.confirmClose?.(d)
      }, detail).catch(() => {})
    },
    dispatchOperation: (payload) => {
      const callId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingCalls.delete(callId)
          resolve({ ok: false, statusCode: 504, code: 'test_dispatch_timeout', message: 'Page dispatch timed out.' })
        }, 12_000)
        pendingCalls.set(callId, { resolve, timer })
        void page.evaluate((packet) => {
          const fn = window.__nwAiEvents?.dispatch
          if (!fn) {
            window.__nwAiHost('dispatchResult', [packet.callId, { ok: false, statusCode: 503, code: 'renderer_unavailable', message: 'No listener' }])
            return
          }
          fn(packet)
        }, { callId, payload }).catch(() => {
          clearTimeout(timer)
          pendingCalls.delete(callId)
          resolve({ ok: false, statusCode: 503, code: 'renderer_unavailable', message: 'Page navigated' })
        })
      })
    },
  })

  await page.exposeFunction('__nwAiHost', async (method, args = []) => {
    switch (method) {
      case 'getAiState':
        return { ...store.getPublicState(), bridge: bridge.getStatus() }
      case 'setAiEnabled': {
        store.setEnabled(args[0] === true)
        await bridge.sync()
        return { ...store.getPublicState(), bridge: bridge.getStatus() }
      }
      case 'setAiPort': {
        store.setPort(args[0])
        await bridge.sync()
        return { ...store.getPublicState(), bridge: bridge.getStatus() }
      }
      case 'createAiClient': {
        const created = store.createClient(args[0])
        return { state: { ...store.getPublicState(), bridge: bridge.getStatus() }, client: created.client, token: created.token }
      }
      case 'updateAiClient': {
        const updated = store.updateClient(args[0], args[1])
        if (!updated.client.enabled || !updated.client.permissions.delete) {
          bridge.cancelClientPending(args[0], 'client_updated')
        }
        return { state: { ...store.getPublicState(), bridge: bridge.getStatus() }, client: updated.client }
      }
      case 'rotateAiToken': {
        const rotated = store.rotateClientToken(args[0])
        return { state: { ...store.getPublicState(), bridge: bridge.getStatus() }, client: rotated.client, token: rotated.token }
      }
      case 'deleteAiClient':
        bridge.cancelClientPending(args[0], 'client_deleted')
        store.deleteClient(args[0])
        return { ...store.getPublicState(), bridge: bridge.getStatus() }
      case 'listAiAudit':
        return store.listAudit(args[0])
      case 'clearAiAudit':
        return store.clearAudit()
      case 'dispatchResult': {
        const [callId, result] = args
        const entry = pendingCalls.get(callId)
        if (entry) {
          clearTimeout(entry.timer)
          pendingCalls.delete(callId)
          entry.resolve(result)
        }
        return true
      }
      case 'confirmDecision':
        return bridge.handleConfirmDecision({ confirmationId: args[0], approved: args[1] === true })
      default:
        throw new Error(`Unknown host call: ${method}`)
    }
  })

  await page.addInitScript(() => {
    let closeBehavior = 'quit'
    window.__nwAiEvents = { dispatch: null, confirmOpen: null, confirmClose: null }
    window.newWorldDesktop = {
      platform: 'win32',
      reportReady: () => {},
      downloadUpdate: async () => ({ ok: true }),
      installUpdate: async () => ({ ok: true }),
      onUpdateProgress: () => {},
      savePdf: async () => {},
      onCloseRequested: () => {},
      minimizeWindow: () => {},
      toggleMaximizeWindow: () => {},
      closeWindow: () => {},
      isMaximized: async () => false,
      onMaximizeChange: () => {},
      getCloseBehavior: async () => closeBehavior,
      setCloseBehavior: async (next) => { closeBehavior = next; return closeBehavior },
      getStorageLocation: async () => ({ path: 'C:\\TestProfile', defaultPath: 'C:\\TestProfile', custom: false }),
      setStorageLocation: async () => null,
      resetStorageLocation: async () => null,
      getAiState: () => window.__nwAiHost('getAiState', []),
      setAiEnabled: (enabled) => window.__nwAiHost('setAiEnabled', [enabled]),
      setAiPort: (port) => window.__nwAiHost('setAiPort', [port]),
      createAiClient: (input) => window.__nwAiHost('createAiClient', [input]),
      updateAiClient: (id, patch) => window.__nwAiHost('updateAiClient', [id, patch]),
      rotateAiToken: (id) => window.__nwAiHost('rotateAiToken', [id]),
      deleteAiClient: (id) => window.__nwAiHost('deleteAiClient', [id]),
      listAiAudit: (limit) => window.__nwAiHost('listAiAudit', [limit]),
      clearAiAudit: () => window.__nwAiHost('clearAiAudit', []),
      onAiDispatch: (handler) => { window.__nwAiEvents.dispatch = handler; return () => {} },
      sendAiDispatchResult: (callId, result) => { void window.__nwAiHost('dispatchResult', [callId, result]) },
      onAiConfirmOpen: (handler) => { window.__nwAiEvents.confirmOpen = handler; return () => {} },
      onAiConfirmClose: (handler) => { window.__nwAiEvents.confirmClose = handler; return () => {} },
      sendAiConfirmDecision: (id, approved) => window.__nwAiHost('confirmDecision', [id, approved]),
    }
  })

  return {
    store,
    bridge,
    dir,
    getAttentionCalls: () => attentionCalls,
    baseUrl: () => {
      const status = bridge.getStatus()
      if (!status.running) throw new Error('Bridge is not running yet')
      return `http://127.0.0.1:${status.port}/v1`
    },
    api: async (method, urlPath, token, body = undefined) => {
      const res = await fetch(`${bridge.getStatus().running ? `http://127.0.0.1:${bridge.getStatus().port}/v1` : ''}${urlPath}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const json = await res.json()
      return { status: res.status, json }
    },
    cleanup: async () => {
      await bridge.stop()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function gotoReady(page, url = '/') {
  await page.goto(url)
  await page.waitForFunction(() => Boolean(window.__nwAiEvents?.dispatch))
}

async function openAiSettings(page) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  const section = dialog.getByRole('region', { name: 'AI 接入与权限', exact: true })
  await section.scrollIntoViewIfNeeded()
  return { dialog, section }
}

async function createUiNovel(page, library, title, bodyText) {
  await page.goto(`/#/${library}`)
  if (library === 'reference') {
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '导入原作建立项目' }).click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles({
      name: `${title}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(bodyText || `${title} 正文内容`, 'utf-8'),
    })
    await expect(page.locator('.book-title', { hasText: title })).toBeVisible()
    return
  }
  await page.getByRole('button', { name: '新建小说' }).click()
  const createDialog = page.getByRole('dialog', { name: '新建小说' })
  await createDialog.getByRole('textbox', { name: '作品名' }).fill(title)
  await createDialog.getByRole('button', { name: '创建小说' }).click()
  const editor = page.locator('.novel-body[contenteditable="true"]')
  await expect(editor).toBeVisible()
  if (bodyText) {
    await editor.click()
    await editor.fill(bodyText)
    await page.keyboard.press('Control+s')
    await expect(page.locator('.save-status')).toHaveText('已保存')
  }
}

test('设置页 AI 权限管理、多 AI 隔离、指定范围、未授权泄露防护与即时撤销', async ({ page }) => {
  const harness = await mountAiHarness(page)
  try {
    await gotoReady(page, '/')
    // Create two novels in UI: one original and one reference (with secret words inside)
    await createUiNovel(page, 'original', '授权小说A', '这是小说A的正文内容，包含秘密词Alpha。')
    await createUiNovel(page, 'original', '保密小说B', '这是保密小说B，绝对不能泄漏SecretBravo。')
    await createUiNovel(page, 'reference', '续写项目C', '这是续写项目C的草稿，秘密词Charlie。')

    await page.goto('/')
    const { dialog, section } = await openAiSettings(page)

    // Initially disabled
    await expect(section.locator('.ai-badge').first()).toHaveText('已停用')
    expect(harness.bridge.getStatus().running).toBe(false)

    // Enable bridge in UI
    await section.locator('input[data-ai-global-enable="true"]').check()
    await expect(section.locator('.ai-badge').first()).toContainText('本地监听 127.0.0.1:')
    expect(harness.bridge.getStatus().running).toBe(true)

    // Unauthenticated health exposes zero data; works returns 401
    const health = await harness.api('GET', '/health', null)
    expect(health.status).toBe(200)
    expect(health.json.apiVersion).toBe('v1')
    const unauthWorks = await harness.api('GET', '/works', null)
    expect(unauthWorks.status).toBe(401)

    // Add AI-1 (WriterAI)
    await section.getByLabel('AI 配置名称').fill('WriterAI')
    await section.getByRole('button', { name: '添加 AI 配置' }).click()
    await expect(section.locator('.ai-token-banner')).toBeVisible()
    await expect(section.locator('.ai-token-title')).toContainText('WriterAI')
    const token1 = (await section.locator('.ai-token-value').innerText()).trim()
    expect(token1.startsWith('nw_ai_')).toBe(true)
    await section.getByRole('button', { name: '我已保存' }).click()
    await expect(section.locator('.ai-token-banner')).toBeHidden()

    // Add AI-2 (ReaderAI)
    await section.getByLabel('AI 配置名称').fill('ReaderAI')
    await section.getByRole('button', { name: '添加 AI 配置' }).click()
    await expect(section.locator('.ai-token-banner')).toBeVisible()
    await expect(section.locator('.ai-token-title')).toContainText('ReaderAI')
    const token2 = (await section.locator('.ai-token-value').innerText()).trim()
    expect(token2).not.toBe(token1)
    await section.getByRole('button', { name: '我已保存' }).click()

    // Default CRUD permissions must all be unchecked & scope must be 'none'
    const card1 = section.locator('.ai-client-card').filter({ hasText: 'WriterAI' })
    const card2 = section.locator('.ai-client-card').filter({ hasText: 'ReaderAI' })
    for (const perm of ['create', 'read', 'update', 'delete']) {
      await expect(card1.locator(`input[data-ai-perm="${perm}"]`)).not.toBeChecked()
    }
    await expect(card1.getByRole('radio', { name: '禁止访问' })).toBeChecked()

    // With default permissions & none scope, capabilities returns permissions false; read works -> 403
    const caps1 = await harness.api('GET', '/capabilities', token1)
    expect(caps1.status).toBe(200)
    expect(caps1.json.data.client.name).toBe('WriterAI')
    expect(caps1.json.data.client.permissions).toEqual({ create: false, read: false, update: false, delete: false })
    expect((await harness.api('GET', '/works', token1)).status).toBe(403)

    // Configure WriterAI: read + create + update on '授权小说A' only
    await card1.locator('input[data-ai-perm="read"]').check()
    await card1.locator('input[data-ai-perm="create"]').check()
    await card1.locator('input[data-ai-perm="update"]').check()
    await card1.getByRole('radio', { name: '仅允许指定小说' }).check()
    await card1.locator('.ai-work-picker label').filter({ hasText: '授权小说A' }).locator('input[type="checkbox"]').check()

    // Configure ReaderAI: read only on '保密小说B' only
    await card2.locator('input[data-ai-perm="read"]').check()
    await card2.getByRole('radio', { name: '仅允许指定小说' }).check()
    await card2.locator('.ai-work-picker label').filter({ hasText: '保密小说B' }).locator('input[type="checkbox"]').check()

    // Verify isolation & no metadata/count/search leakage
    const works1 = await harness.api('GET', '/works', token1)
    expect(works1.status).toBe(200)
    expect(works1.json.data.works.map((w) => w.title)).toEqual(['授权小说A'])
    const workA = works1.json.data.works[0]

    const works2 = await harness.api('GET', '/works', token2)
    expect(works2.status).toBe(200)
    expect(works2.json.data.works.map((w) => w.title)).toEqual(['保密小说B'])
    const workB = works2.json.data.works[0]

    // WriterAI cannot access Work B by ID, its editions/chapters, or its secret text via search
    expect((await harness.api('GET', `/works/original/${workB.id}`, token1)).status).toBe(403)
    expect((await harness.api('GET', `/works/original/${workB.id}/editions`, token1)).status).toBe(403)
    expect((await harness.api('GET', `/works/original/non-existent-id`, token1)).status).toBe(403)
    const lib1 = await harness.api('GET', '/libraries', token1)
    expect(lib1.json.data.groups.original.total).toBe(1)
    expect(lib1.json.data.groups.reference.total).toBe(0)
    const stats1 = await harness.api('GET', '/stats', token1)
    expect(stats1.json.data.authorizedWorks).toBe(1)
    expect('streak' in stats1.json.data).toBe(false)
    const search1 = await harness.api('GET', '/search?q=SecretBravo', token1)
    expect(search1.status).toBe(200)
    expect(search1.json.data.results).toEqual([])
    const searchHit1 = await harness.api('GET', '/search?q=Alpha', token1)
    expect(searchHit1.json.data.results.some((r) => r.bookId === workA.id)).toBe(true)
    const searchRefBlocked = await harness.api('GET', '/search?q=Charlie', token1)
    expect(searchRefBlocked.status).toBe(200)
    expect(searchRefBlocked.json.data.results).toEqual([])

    // Selected-scope AI cannot create top-level novels or access other books, even with create=true
    const createTopBlocked = await harness.api('POST', '/works', token1, { library: 'original', title: '越权小说' })
    expect(createTopBlocked.status).toBe(403)
    expect(createTopBlocked.json.error.code).toBe('create_scope_forbidden')

    // ReaderAI cannot read Work A, cannot update Work B (update=false), and cannot spoof WriterAI via headers
    expect((await harness.api('GET', `/works/original/${workA.id}`, token2)).status).toBe(403)
    expect((await harness.api('PATCH', `/works/original/${workB.id}`, token2, { title: '试图篡改' })).status).toBe(403)
    const spoofRes = await fetch(`${harness.baseUrl()}/works`, {
      headers: { Authorization: `Bearer ${token2}`, 'X-Client-Name': 'WriterAI' },
    })
    const spoofJson = await spoofRes.json()
    expect(spoofJson.data.works.map((w) => w.title)).toEqual(['保密小说B'])

    // Verify immediate revocation: remove Work A from WriterAI -> next read immediately returns 403
    await card1.locator('.ai-work-picker label').filter({ hasText: '授权小说A' }).locator('input[type="checkbox"]').uncheck()
    await expect.poll(async () => (await harness.api('GET', `/works/original/${workA.id}`, token1)).status).toBe(403)

    // Disable ReaderAI client -> next read immediately returns 403 client_disabled
    await card2.getByLabel('允许此 AI 使用本配置发起请求').uncheck()
    const disabledRead = await harness.api('GET', '/works', token2)
    expect(disabledRead.status).toBe(403)
    expect(disabledRead.json.error.code).toBe('client_disabled')

    // Mobile viewport check in AI settings panel
    await dialog.getByRole('button', { name: '关闭' }).click()
    await page.setViewportSize({ width: 390, height: 700 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(dialog).toBeVisible()
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  } finally {
    await harness.cleanup()
  }
})

test('CRUD 权限组合、小说分组/章节/重命名/排序、续写库关系及编辑器脏状态保护', async ({ page }) => {
  const harness = await mountAiHarness(page)
  try {
    harness.store.setEnabled(true)
    await harness.bridge.sync()

    const { client: crudClient, token } = harness.store.createClient({
      name: 'NovelOpsAI',
      enabled: true,
      permissions: { create: true, read: true, update: true, delete: false },
      scope: { mode: 'all', workIds: [] },
    })
    await gotoReady(page, '/')

    // Verify key CRUD permission combinations enforce exact boundary
    harness.store.updateClient(crudClient.id, { permissions: { create: true, read: false, update: false, delete: false } })
    expect((await harness.api('GET', '/works', token)).status).toBe(403)
    expect((await harness.api('POST', '/works', token, {
      library: 'original',
      title: '测试小说流',
      initialChapters: [
        { title: '第一章 初遇', format: 'markdown', content: '晨光落进窗棂。' },
        { title: '第二章 启程', format: 'text', content: '列车穿过长夜。' },
      ],
    })).status).toBe(201)

    harness.store.updateClient(crudClient.id, { permissions: { create: false, read: true, update: false, delete: false } })
    const listRes = await harness.api('GET', '/works?library=original', token)
    expect(listRes.status).toBe(200)
    const work = listRes.json.data.works[0]
    expect(work.title).toBe('测试小说流')
    expect((await harness.api('POST', '/works', token, { library: 'original', title: '无创建权限' })).status).toBe(403)
    expect((await harness.api('PATCH', `/works/original/${work.id}`, token, { title: '无修改权限' })).status).toBe(403)

    // Enable create + read + update (delete still false)
    harness.store.updateClient(crudClient.id, { permissions: { create: true, read: true, update: true, delete: false } })

    const editions = await harness.api('GET', `/works/original/${work.id}/editions`, token)
    const editionId = editions.json.data.editions[0].id
    const chaptersBefore = await harness.api('GET', `/works/original/${work.id}/editions/${editionId}/chapters`, token)
    expect(chaptersBefore.json.data.chapters.map((c) => c.title)).toEqual(['第一章 初遇', '第二章 启程'])
    const [ch1, ch2] = chaptersBefore.json.data.chapters

    // Read chapter content in multiple formats
    const ch1Read = await harness.api('GET', `/works/original/${work.id}/editions/${editionId}/chapters/${ch1.id}?format=text`, token)
    expect(ch1Read.json.data.chapter.content).toContain('晨光落进窗棂')

    // Reorder chapters cleanly, and reject invalid omission reorder
    const badReorder = await harness.api('PATCH', `/works/original/${work.id}/editions/${editionId}/chapters/reorder`, token, {
      chapterIds: [ch2.id], // missing ch1.id!
    })
    expect(badReorder.status).toBe(400)
    expect(badReorder.json.error.code).toBe('invalid_chapter_reorder')

    const goodReorder = await harness.api('PATCH', `/works/original/${work.id}/editions/${editionId}/chapters/reorder`, token, {
      chapterIds: [ch2.id, ch1.id],
    })
    expect(goodReorder.status).toBe(200)
    expect(goodReorder.json.data.chapters.map((c) => c.title)).toEqual(['第二章 启程', '第一章 初遇'])

    // Rename & archive/unarchive groups
    const archiveRes = await harness.api('PATCH', `/works/original/${work.id}`, token, { title: '测试小说流·修订版', archived: true })
    expect(archiveRes.status).toBe(200)
    expect(archiveRes.json.data.work.archived).toBe(true)
    const archivedList = await harness.api('GET', '/works?archived=true', token)
    expect(archivedList.json.data.works.some((w) => w.id === work.id)).toBe(true)
    await harness.api('PATCH', `/works/original/${work.id}`, token, { archived: false })

    // Open work in UI editor and leave unsaved typing -> AI update gets 409 without overwriting user!
    await page.goto(`/#/original/${work.id}/${editionId}`)
    const editor = page.locator('.novel-body[contenteditable="true"]')
    await expect(editor).toBeVisible()
    await editor.click()
    await editor.fill('作者正在输入的未保存文字')
    await expect(page.locator('.save-status')).toHaveText('未保存')

    const blockedDirtyUpdate = await harness.api('PUT', `/works/original/${work.id}/editions/${editionId}/chapters/${ch2.id}`, token, {
      format: 'text',
      content: 'AI 试图覆盖未保存稿件的文字',
    })
    expect(blockedDirtyUpdate.status).toBe(409)
    expect(blockedDirtyUpdate.json.error.code).toBe('chapter_dirty_in_editor')
    await expect(editor).toContainText('作者正在输入的未保存文字')

    // Save in editor -> AI update now succeeds AND refreshes open clean editor
    await page.keyboard.press('Control+s')
    await expect(page.locator('.save-status')).toHaveText('已保存')
    const cleanUpdate = await harness.api('PUT', `/works/original/${work.id}/editions/${editionId}/chapters/${ch2.id}`, token, {
      format: 'text',
      content: '作者正在输入的未保存文字，并且由 AI 顺利扩写了一段新剧情。',
    })
    expect(cleanUpdate.status).toBe(200)
    await expect(editor).toContainText('由 AI 顺利扩写了一段新剧情')

    // Continuation project + source file + ideas relationship
    const refWorkRes = await harness.api('POST', '/works', token, {
      library: 'reference',
      title: '外传续写项目',
      sourceName: '前传原作.txt',
      sourceText: '前传第一章：旧城钟声敲响。',
      initialChapters: [{ title: '续写一章', format: 'markdown', content: '多年之后钟声依旧。' }],
    })
    expect(refWorkRes.status).toBe(201)
    const refWork = refWorkRes.json.data.work
    expect(refWork.sources.length).toBe(1)
    const sourceRead = await harness.api('GET', `/works/reference/${refWork.id}/sources/${refWork.sources[0].id}`, token)
    expect(sourceRead.status).toBe(200)
    expect(sourceRead.json.data.source.text).toContain('旧城钟声敲响')

    const ideaCreate = await harness.api('POST', '/ideas', token, {
      text: '伏笔：钟楼下埋着钥匙',
      work: { library: 'reference', bookId: refWork.id },
    })
    expect(ideaCreate.status).toBe(201)
    const ideaUpdate = await harness.api('PATCH', `/ideas/${ideaCreate.json.data.idea.id}`, token, { used: true })
    expect(ideaUpdate.status).toBe(200)
    expect(Boolean(ideaUpdate.json.data.idea.usedAt)).toBe(true)
  } finally {
    await harness.cleanup()
  }
})

test('删除强制人工二次确认（防 API 自确认、单次性、取消/超时/篡改保护）', async ({ page }) => {
  const harness = await mountAiHarness(page, { confirmTimeoutMs: 1200 })
  try {
    harness.store.setEnabled(true)
    await harness.bridge.sync()

    const { token } = harness.store.createClient({
      name: 'DeleteCheckAI',
      enabled: true,
      permissions: { create: true, read: true, update: true, delete: true },
      scope: { mode: 'all', workIds: [] },
    })

    await gotoReady(page, '/')
    const created = await harness.api('POST', '/works', token, {
      library: 'original',
      title: '待删确认书',
      initialChapters: [
        { title: '保留章节', format: 'text', content: '这章应当保留，共有二十多字的测试内容写在这里。' },
        { title: '目标章节', format: 'text', content: '准备删除这一章的正文内容，里面有不少于十个字。' },
      ],
    })
    expect(created.status).toBe(201)
    const workId = created.json.data.work.id
    const editionId = created.json.data.editions[0].id
    const chapters = (await harness.api('GET', `/works/original/${workId}/editions/${editionId}/chapters`, token)).json.data.chapters
    const targetChapter = chapters[1]

    // 1. Delete request with confirm/force flags STILL triggers human UI modal (never executes on HTTP alone!)
    const req1 = await harness.api('DELETE', `/works/original/${workId}/editions/${editionId}/chapters/${targetChapter.id}`, token, {
      confirm: true,
      approved: true,
      force: true,
      skipConfirmation: true,
    })
    expect(req1.status).toBe(202)
    expect(req1.json.status).toBe('pending_confirmation')
    expect(harness.getAttentionCalls()).toBe(1)

    const confirmDialog = page.getByRole('dialog', { name: '确认 AI 请求的操作' })
    await expect(confirmDialog).toBeVisible()
    await expect(confirmDialog).toContainText('DeleteCheckAI')
    await expect(confirmDialog).toContainText('待删确认书')
    await expect(confirmDialog).toContainText('目标章节')
    // Cancel button must be focused by default
    const cancelBtn = confirmDialog.getByRole('button', { name: '拒绝并取消' })
    await expect(cancelBtn).toBeFocused()

    // Synthetic untrusted script click on Approve button must NOT confirm!
    await confirmDialog.getByRole('button', { name: '本人确认执行' }).evaluate((btn) => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await expect(confirmDialog).toBeVisible()

    // API attempt to self-approve must be rejected
    const selfApprove = await harness.api('POST', `/confirmations/${req1.json.confirmationId}/confirm`, token, { approved: true })
    expect(selfApprove.status).toBe(403)
    expect(selfApprove.json.error.code).toBe('api_confirmation_forbidden')

    // Click Cancel -> rejected & chapter untouched
    await cancelBtn.click()
    await expect(confirmDialog).toBeHidden()
    const poll1 = await harness.api('GET', `/confirmations/${req1.json.confirmationId}`, token)
    expect(poll1.json.data.status).toBe('rejected')
    expect((await harness.api('GET', `/works/original/${workId}/editions/${editionId}/chapters/${targetChapter.id}`, token)).status).toBe(200)

    // 2. Request again -> brand-new confirmationId -> click real Approve -> executes cleanly & moves to Trash
    const waitApprovedPromise = harness.api('DELETE', `/works/original/${workId}/editions/${editionId}/chapters/${targetChapter.id}?wait=true`, token)
    await expect(confirmDialog).toBeVisible()
    await confirmDialog.getByRole('button', { name: '本人确认执行' }).click()
    const waitApproved = await waitApprovedPromise
    expect(waitApproved.status).toBe(200)
    expect(waitApproved.json.data.deleted).toBe(true)
    expect((await harness.api('GET', `/works/original/${workId}/editions/${editionId}/chapters/${targetChapter.id}`, token)).status).toBe(404)

    // Verify Trash UI contains deleted chapter
    await page.goto('/#/trash')
    await expect(page.getByText('目标章节')).toBeVisible()

    // 3. Do NOT click before timeout (1200ms) -> times out cleanly & work still exists
    const waitTimeout = await harness.api('DELETE', `/works/original/${workId}?wait=true`, token)
    expect(waitTimeout.status).toBe(408)
    expect(waitTimeout.json.error.code).toBe('confirmation_timed_out')
    await expect(confirmDialog).toBeHidden()
    expect((await harness.api('GET', `/works/original/${workId}`, token)).status).toBe(200)

    // 4. Deleting entire work WITH human confirmation moves book cleanly
    const waitWorkDel = harness.api('DELETE', `/works/original/${workId}?wait=true`, token)
    await expect(confirmDialog).toBeVisible()
    await expect(confirmDialog).toContainText('待删确认书')
    await confirmDialog.getByRole('button', { name: '本人确认执行' }).click()
    const workDelRes = await waitWorkDel
    expect(workDelRes.status).toBe(200)
    expect((await harness.api('GET', `/works/original/${workId}`, token)).status).toBe(404)
  } finally {
    await harness.cleanup()
  }
})

test('Update 变相删除全链路防护与备份恢复兼容性', async ({ page }) => {
  const harness = await mountAiHarness(page)
  try {
    harness.store.setEnabled(true)
    await harness.bridge.sync()

    const { client, token } = harness.store.createClient({
      name: 'UpdateGuardAI',
      enabled: true,
      permissions: { create: true, read: true, update: true, delete: false },
      scope: { mode: 'all', workIds: [] },
    })

    await gotoReady(page, '/')
    // Create a 240-word prose chapter (English space-separated words count cleanly word-by-word)
    const makeWords = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
    const initialBody = makeWords(240)
    const created = await harness.api('POST', '/works', token, {
      library: 'original',
      title: '备份与防删兼容作品',
      initialChapters: [
        { title: '第一章 长文', format: 'text', content: initialBody },
        { title: '第二章 副章', format: 'text', content: makeWords(60) },
      ],
    })
    expect(created.status).toBe(201)
    const workId = created.json.data.work.id
    const editionId = created.json.data.editions[0].id
    const chapters = (await harness.api('GET', `/works/original/${workId}/editions/${editionId}/chapters`, token)).json.data.chapters
    const ch1 = chapters[0]

    // 1. Single-step wipe blocked when delete=false
    const wipeDenied = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch1.id}`, token, {
      format: 'text',
      content: '',
    })
    expect(wipeDenied.status).toBe(403)
    expect(wipeDenied.json.error.code).toBe('destructive_update_forbidden')

    // 2. Multi-step slow-drip nibbling: 240 -> 140 (41% OK) -> 95 (32% step OK, cumulative 60% < 65%) -> 70 (cumulative 71% >= 65%, BLOCKED!)
    expect((await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch1.id}`, token, {
      format: 'text', content: makeWords(140),
    })).status).toBe(200)
    expect((await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch1.id}`, token, {
      format: 'text', content: makeWords(95),
    })).status).toBe(200)
    const dripBlocked = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch1.id}`, token, {
      format: 'text', content: makeWords(70),
    })
    expect(dripBlocked.status).toBe(403)
    expect(dripBlocked.json.error.code).toBe('destructive_update_forbidden')

    // 3. Batch replace omitting chapter 2 blocked when delete=false
    const batchBlocked = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters`, token, {
      chapters: [{ id: ch1.id, title: '仅剩一章', format: 'text', content: makeWords(95) }],
    })
    expect(batchBlocked.status).toBe(403)
    expect(batchBlocked.json.error.code).toBe('destructive_update_forbidden')

    // 4. With delete=true, destructive update REQUIRES mandatory human UI confirmation (cancel keeps 95 words, confirm updates)
    harness.store.updateClient(client.id, { permissions: { create: true, read: true, update: true, delete: true } })
    const confirmDialog = page.getByRole('dialog', { name: '确认 AI 请求的操作' })
    const cancelWait = harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch1.id}?wait=true`, token, {
      format: 'text', content: makeWords(10),
    })
    await expect(confirmDialog).toBeVisible()
    await expect(confirmDialog).toContainText('95 -> 10')
    await confirmDialog.getByRole('button', { name: '拒绝并取消' }).click()
    expect((await cancelWait).status).toBe(403)

    // Restore full healthy content (preserving >= 35% of peak baseline) before backup compatibility test
    const restoreBody = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch1.id}`, token, {
      format: 'text', content: `${makeWords(140)}\n\nAI 写入的正文段落，用来验证导出与备份恢复兼容。`,
    })
    expect(restoreBody.status).toBe(200)

    // 5. Real New_World .zip backup & restore compatibility test via Settings UI
    await page.goto('/')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settingsDialog = page.getByRole('dialog', { name: '设置' })
    const backupSection = settingsDialog.getByRole('region', { name: '备份', exact: true })
    const downloadPromise = page.waitForEvent('download')
    await backupSection.getByRole('button', { name: '立即备份' }).click()
    const download = await downloadPromise
    const zipPath = path.join(harness.dir, 'backup.zip')
    await download.saveAs(zipPath)
    await settingsDialog.getByRole('button', { name: '关闭' }).click()

    // Delete the work cleanly via confirmation so library is emptied
    const delWait = harness.api('DELETE', `/works/original/${workId}?wait=true`, token)
    await expect(confirmDialog).toBeVisible()
    await confirmDialog.getByRole('button', { name: '本人确认执行' }).click()
    expect((await delWait).status).toBe(200)
    expect((await harness.api('GET', '/works', token)).json.data.works).toEqual([])

    // Restore from saved .zip via UI
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const chooserPromise = page.waitForEvent('filechooser')
    await backupSection.getByRole('button', { name: '从备份恢复…' }).click()
    const chooser = await chooserPromise
    await chooser.setFiles(zipPath)
    const restoreConfirm = page.getByRole('dialog', { name: '从备份恢复' })
    await expect(restoreConfirm).toBeVisible()
    await restoreConfirm.getByRole('button', { name: '替换当前书库' }).click()
    await expect(page.getByText(/已从备份恢复 \d+ 部作品。/)).toBeVisible()

    // Verify AI-authored novel & text are back in both API & Editor UI!
    const restoredWorks = await harness.api('GET', '/works', token)
    expect(restoredWorks.json.data.works.map((w) => w.title)).toContain('备份与防删兼容作品')
    await page.goto(`/#/original/${workId}/${editionId}`)
    await expect(page.locator('.novel-body')).toContainText('AI 写入的正文段落，用来验证导出与备份恢复兼容。')
  } finally {
    await harness.cleanup()
  }
})
