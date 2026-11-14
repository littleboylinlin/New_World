import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './app-test.mjs'

const require = createRequire(import.meta.url)
const { createAiStore } = require('../desktop/ai-store.cjs')
const { createAiBridge } = require('../desktop/ai-bridge.cjs')
const { shouldCancelClientConfirmations } = require('../desktop/ipc-guard.cjs')

async function mountAiHarness(page, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-ai-rec-e2e-'))
  const store = createAiStore(dir)
  const pendingCalls = new Map()

  const bridge = createAiBridge({
    store,
    bindPort: 0,
    confirmTimeoutMs: options.confirmTimeoutMs ?? 30_000,
    onAttentionNeeded: () => {},
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
        const prev = store.getClientById?.(args[0]) ?? store.getPublicState().clients.find((c) => c.id === args[0])
        const updated = store.updateClient(args[0], args[1])
        if (shouldCancelClientConfirmations(prev, updated.client)) {
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
    api: async (method, urlPath, token, body = undefined) => {
      const status = bridge.getStatus()
      if (!status.running) throw new Error('Bridge is not running yet')
      const res = await fetch(`http://127.0.0.1:${status.port}/v1${urlPath}`, {
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

async function createReferenceWorkViaUi(page, title, content) {
  await page.goto('/#/reference')
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '导入原作建立项目' }).click()
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles({
    name: `${title}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(content, 'utf-8'),
  })
  await expect(page.locator('.book-title', { hasText: title })).toBeVisible()
}

async function createWorkWithChapters(harness, token, title, initialChapters) {
  const workRes = await harness.api('POST', '/works', token, {
    library: 'original',
    title,
    initialChapters,
  })
  expect(workRes.status, JSON.stringify(workRes.json)).toBe(201)
  const workId = workRes.json.data.work.id
  const editionId = workRes.json.data.editions[0].id
  const edDetail = await harness.api('GET', `/works/original/${workId}/editions/${editionId}`, token)
  expect(edDetail.status).toBe(200)
  return { workId, editionId, chapters: edDetail.json.data.edition.chapters }
}

test('1-2. 无 Delete 权限拒绝删除与破坏性修改；未经人工确认、超时及脚本伪造点击无法删除且永久删除需独立二次确认', async ({ page }) => {
  const harness = await mountAiHarness(page, { confirmTimeoutMs: 1200 })
  try {
    harness.store.setEnabled(true)
    const noDelete = harness.store.createClient({
      name: 'WriterWithoutDelete',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: false },
      scope: { mode: 'all', workIds: [] },
    })
    const withDelete = harness.store.createClient({
      name: 'DeleterWithPermission',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: true },
      scope: { mode: 'all', workIds: [] },
    })
    await harness.bridge.sync()
    await createReferenceWorkViaUi(page, '不可无授权删除原作', '这是一份续写库原作正文内容。')
    await gotoReady(page, '/')

    const refList = await harness.api('GET', '/works?library=reference', noDelete.token)
    const refWorkId = refList.json.data.works[0].id

    const { workId, editionId, chapters } = await createWorkWithChapters(harness, noDelete.token, '受保护测试小说', [
      { title: '第一章', format: 'text', content: '四字短章' },
      { title: '第二章', format: 'text', content: '第二章需要保留下来的正文内容。' },
    ])
    const ch1Id = chapters[0].id
    const ch2Id = chapters[1].id

    const srcRes = await harness.api('POST', `/works/reference/${refWorkId}/sources`, noDelete.token, {
      fileName: '附加设定集.txt',
      content: '设定集独立原文内容。',
    })
    expect(srcRes.status).toBe(201)
    const sourceId = srcRes.json.data.source.id

    const ideaRes = await harness.api('POST', '/ideas', noDelete.token, {
      text: '一条不可无权限删除的灵感',
      work: { library: 'original', bookId: workId },
    })
    expect(ideaRes.status).toBe(201)
    const ideaId = ideaRes.json.data.idea.id

    // Scenario 1: All DELETE & destructive operations rejected without delete permission
    expect((await harness.api('DELETE', `/works/original/${workId}`, noDelete.token)).status).toBe(403)
    expect((await harness.api('DELETE', `/works/original/${workId}/editions/${editionId}`, noDelete.token)).status).toBe(403)
    expect((await harness.api('DELETE', `/works/original/${workId}/editions/${editionId}/chapters/${ch1Id}`, noDelete.token)).status).toBe(403)
    expect((await harness.api('DELETE', `/works/reference/${refWorkId}/sources/${sourceId}`, noDelete.token)).status).toBe(403)
    expect((await harness.api('DELETE', `/ideas/${ideaId}`, noDelete.token)).status).toBe(403)

    const shortClearBlocked = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch1Id}`, noDelete.token, {
      content: '',
    })
    expect(shortClearBlocked.status).toBe(403)
    expect(shortClearBlocked.json.error.code).toBe('destructive_update_forbidden')

    const batchDropBlocked = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters`, noDelete.token, {
      chapters: [{ id: ch2Id, title: '第二章', content: '第二章需要保留下来的正文内容。' }],
    })
    expect(batchDropBlocked.status).toBe(403)
    expect(batchDropBlocked.json.error.code).toBe('destructive_update_forbidden')

    await page.goto('/#/trash')
    await expect(page.getByRole('heading', { name: '回收站是空的' })).toBeVisible()

    // Scenario 2: Grant delete, yet untrusted synthetic click, API self-confirm, user cancel, and timeout must NEVER delete
    await gotoReady(page, '/#/original')
    const delPromise = harness.api('DELETE', `/works/original/${workId}?wait=true`, withDelete.token)
    const confirmDialog = page.getByRole('dialog', { name: '确认 AI 请求的操作' })
    await expect(confirmDialog).toBeVisible()

    // Synthetic DOM click (event.isTrusted === false) cannot confirm deletion
    await confirmDialog.getByRole('button', { name: '本人确认执行' }).evaluate((btn) => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await expect(confirmDialog).toBeVisible()

    // User rejects
    await confirmDialog.getByRole('button', { name: '拒绝并取消' }).click()
    const rejRes = await delPromise
    expect(rejRes.status).toBe(403)
    expect(rejRes.json.error.code).toBe('confirmation_rejected')

    // AI self-confirm via API is unconditionally rejected
    const pendingAsync = await harness.api('DELETE', `/works/original/${workId}`, withDelete.token)
    expect(pendingAsync.status).toBe(202)
    const selfConfirm = await harness.api('POST', `/confirmations/${pendingAsync.json.confirmationId}/confirm`, withDelete.token, { approved: true })
    expect(selfConfirm.status).toBe(403)
    expect(selfConfirm.json.error.code).toBe('api_confirmation_forbidden')
    await confirmDialog.getByRole('button', { name: '拒绝并取消' }).click()

    // Timeout (1200ms) leaves novel untouched
    const timedOutRes = await harness.api('DELETE', `/works/original/${workId}?wait=true&force=true&skipConfirmation=true`, withDelete.token)
    expect(timedOutRes.status).toBe(408)
    expect(timedOutRes.json.error.code).toBe('confirmation_timed_out')
    await expect(page.locator('.book-title', { hasText: '受保护测试小说' })).toBeVisible()
  } finally {
    await harness.cleanup()
  }
})

test('3-4. 全类型对象确认删除完整进入回收站并可恢复；AI 严禁访问/篡改回收站与历史记录，审计完整记录', async ({ page }) => {
  const harness = await mountAiHarness(page, { confirmTimeoutMs: 30_000 })
  try {
    harness.store.setEnabled(true)
    const ai = harness.store.createClient({
      name: 'RecoveryAuditAgent',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: true },
      scope: { mode: 'all', workIds: [] },
    })
    await harness.bridge.sync()
    await createReferenceWorkViaUi(page, '参考原作主项目', '参考原作第一章完整全文，不能因删除附件丢失。')
    await gotoReady(page, '/')

    const refList = await harness.api('GET', '/works?library=reference', ai.token)
    const refWorkId = refList.json.data.works[0].id
    const attachRes = await harness.api('POST', `/works/reference/${refWorkId}/sources`, ai.token, {
      fileName: '人物年表.txt',
      content: '年表详细记录内容 2026。',
    })
    expect(attachRes.status).toBe(201)
    const attachedSourceId = attachRes.json.data.source.id

    const { workId, editionId: ed1Id, chapters } = await createWorkWithChapters(harness, ai.token, '全量恢复检验小说', [
      { title: '第一章', format: 'text', content: '第一章被删前完整正文内容。' },
      { title: '第二章', format: 'text', content: '第二章伴随正文。' },
    ])
    const ch1Id = chapters[0].id

    const ed2Res = await harness.api('POST', `/works/original/${workId}/editions`, ai.token, {
      name: '修订二版',
    })
    expect(ed2Res.status).toBe(201)
    const ed2Id = ed2Res.json.data.edition.id

    const linkedIdeaRes = await harness.api('POST', '/ideas', ai.token, {
      text: '绑定小说的结构灵感',
      work: { library: 'original', bookId: workId },
    })
    const freeIdeaRes = await harness.api('POST', '/ideas', ai.token, {
      text: '独立游离灵感想法',
    })
    expect(linkedIdeaRes.status).toBe(201)
    expect(freeIdeaRes.status).toBe(201)
    const linkedIdeaId = linkedIdeaRes.json.data.idea.id
    const freeIdeaId = freeIdeaRes.json.data.idea.id

    const confirmDelete = async (urlPath, expectedSnippet) => {
      const dialog = page.getByRole('dialog', { name: '确认 AI 请求的操作' })
      const promise = harness.api('DELETE', `${urlPath}?wait=true`, ai.token)
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText(expectedSnippet)
      await dialog.getByRole('button', { name: '本人确认执行' }).click()
      const res = await promise
      expect(res.status, JSON.stringify(res.json)).toBe(200)
      expect(res.json.data.movedToTrash).toBe(true)
    }

    // Make one legitimate edit to produce a snapshot:<id> audit receipt as well
    const chUpdate = await harness.api('PUT', `/works/original/${workId}/editions/${ed1Id}/chapters/${ch1Id}`, ai.token, {
      content: '第一章被删前完整正文内容（修订句）。',
    })
    expect(chUpdate.status).toBe(200)
    expect(chUpdate.json.data.snapshotSaved).toBe(true)

    // Delete: chapter, second edition, attached source original, linked idea, unlinked idea, and whole novel
    await confirmDelete(`/works/original/${workId}/editions/${ed1Id}/chapters/${ch1Id}`, '第一章')
    await confirmDelete(`/works/original/${workId}/editions/${ed2Id}`, '修订二版')
    await confirmDelete(`/works/reference/${refWorkId}/sources/${attachedSourceId}`, '人物年表')
    await confirmDelete(`/ideas/${linkedIdeaId}`, '绑定小说的结构灵感')
    await confirmDelete(`/ideas/${freeIdeaId}`, '独立游离灵感想法')
    await confirmDelete(`/works/original/${workId}`, '全量恢复检验小说')

    // AI cannot read, restore, empty, or tamper with Trash, Revision History, or Backups
    for (const [method, urlPath] of [
      ['GET', '/trash'],
      ['DELETE', '/trash'],
      ['POST', '/trash/fake-id/restore'],
      ['GET', '/revisions'],
      ['GET', `/works/original/${workId}/revisions`],
      ['DELETE', `/works/original/${workId}/editions/${ed1Id}/chapters/${ch1Id}/revisions/rev-1`],
      ['GET', '/history'],
      ['GET', '/backups'],
    ]) {
      const blocked = await harness.api(method, urlPath, ai.token)
      expect(blocked.status).toBe(403)
      expect(blocked.json.error.code).toBe('recovery_data_forbidden')
    }

    const skipHistoryAttempt = await harness.api('PUT', `/works/reference/${refWorkId}/editions/${refWorkId}/chapters/any`, ai.token, {
      content: 'try skip',
      skipHistory: true,
    })
    expect(skipHistoryAttempt.status).toBe(403)
    expect(skipHistoryAttempt.json.error.code).toBe('history_protection_non_bypassable')

    // Verify all 6 deleted objects are present in Trash UI and restore cleanly in hierarchy order
    await page.goto('/#/trash')
    const trashList = page.getByRole('list', { name: '回收站内容' })
    await expect(trashList).toBeVisible()
    for (const label of ['全量恢复检验小说', '修订二版', '第一章', '人物年表', '绑定小说的结构灵感', '独立游离灵感想法']) {
      await expect(trashList).toContainText(label)
    }

    // Restore parent work -> edition -> chapter -> reference source -> both ideas
    const exactTrashRow = (text) => trashList.locator('.trash-row').filter({ has: page.locator('.book-title', { hasText: text }) }).first()
    const restoreRow = async (text) => {
      const row = exactTrashRow(text)
      await expect(row).toBeVisible()
      await row.getByRole('button', { name: '恢复' }).click()
      await expect(trashList.locator('.trash-row').filter({ has: page.locator('.book-title', { hasText: text }) })).toHaveCount(0)
    }
    await restoreRow('全量恢复检验小说')
    await restoreRow('修订二版')
    await restoreRow('第一章')
    await restoreRow('人物年表')
    await restoreRow('绑定小说的结构灵感')

    // Verify Trash permanent delete on the remaining unlinked idea requires its own UI second confirmation
    const remainingRow = exactTrashRow('独立游离灵感想法')
    await remainingRow.getByRole('button', { name: '彻底删除' }).click()
    const permDialog = page.getByRole('dialog', { name: '彻底删除？' })
    await expect(permDialog).toBeVisible()
    await permDialog.getByRole('button', { name: '取消' }).click()
    await expect(remainingRow).toBeVisible()
    await restoreRow('独立游离灵感想法')

    // Check everything actually exists back in real IndexedDB / UI!
    const restoredChapter = await harness.api('GET', `/works/original/${workId}/editions/${ed1Id}/chapters/${ch1Id}`, ai.token)
    expect(restoredChapter.status).toBe(200)
    expect(restoredChapter.json.data.chapter.text).toContain('第一章被删前完整正文内容（修订句）。')

    const restoredSource = await harness.api('GET', `/works/reference/${refWorkId}/sources/${attachedSourceId}`, ai.token)
    expect(restoredSource.status).toBe(200)
    expect(restoredSource.json.data.source.text).toContain('年表详细记录内容 2026。')

    await page.goto('/#/ideas')
    const ideaList = page.getByRole('list', { name: '灵感列表' })
    await expect(ideaList).toContainText('绑定小说的结构灵感')
    await expect(ideaList).toContainText('独立游离灵感想法')

    // Verify audit receipts record snapshots, trashed IDs, and forbidden recovery access
    const audit = harness.store.listAudit(100)
    expect(audit.some((a) => a.outcome === 'allowed' && String(a.reason).startsWith('snapshot:'))).toBe(true)
    expect(audit.filter((a) => a.outcome === 'confirmed' && String(a.reason).startsWith('trashed:')).length).toBeGreaterThanOrEqual(6)
    expect(audit.some((a) => a.outcome === 'denied' && a.reason === 'recovery_data_forbidden')).toBe(true)
  } finally {
    await harness.cleanup()
  }
})

test('5-6. 4字短章清空拦截与恢复；同字数全文替换拦截（无-0误导）与合法改稿不误报', async ({ page }) => {
  const harness = await mountAiHarness(page, { confirmTimeoutMs: 30_000 })
  try {
    harness.store.setEnabled(true)
    const noDel = harness.store.createClient({
      name: 'EditorAI',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: false },
      scope: { mode: 'all', workIds: [] },
    })
    const withDel = harness.store.createClient({
      name: 'ConfirmedEditorAI',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: true },
      scope: { mode: 'all', workIds: [] },
    })
    await harness.bridge.sync()
    await gotoReady(page, '/')

    // Equal-length 51-char CJK passages (exact same wordCount = 51) with unrelated vocabulary
    const passageA = '海岸灯塔亮。风吹海面。林默登梯。海盐结晶。暖光闪烁。夜潮拍岸。守塔未眠。钟声回荡。船影远去。晨雾初散。'
    const passageB = '北境星台静。极光流动。知秋调镜。齿轮轻响。星云脉冲。寒霜落窗。穹顶微开。数据飞转。夜空深邃。观测继续。'
    expect([...passageA].length).toBe([...passageB].length)
    expect([...passageA].length).toBeGreaterThanOrEqual(40)
    const minorEditOfA = '海岸灯塔亮。风吹海面。林默登梯。海盐结晶。琥珀闪烁。夜潮拍岸。守塔未眠。钟声回荡。船影远去。晨雾初散。'

    const { workId, editionId, chapters } = await createWorkWithChapters(harness, noDel.token, '短章与等字数替换试验小说', [
      { title: '短章四字', format: 'text', content: '四字短章' },
      { title: '灯塔夜班', format: 'text', content: passageA },
    ])
    const shortChId = chapters[0].id
    const proseChId = chapters[1].id

    // 1) 4-character chapter cleared without delete -> blocked
    const blockedShort = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${shortChId}`, noDel.token, {
      content: '   ',
    })
    expect(blockedShort.status).toBe(403)
    expect(blockedShort.json.error.code).toBe('destructive_update_forbidden')
    expect(blockedShort.json.error.reason).toBe('chapter_cleared_to_empty')

    // With delete + confirm -> executes, saves '四字短章' to History
    const shortDialog = page.getByRole('dialog', { name: '确认 AI 请求的操作' })
    const shortConfirmPromise = harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${shortChId}?wait=true`, withDel.token, {
      content: '',
    })
    await expect(shortDialog).toBeVisible()
    await shortDialog.getByRole('button', { name: '本人确认执行' }).click()
    expect((await shortConfirmPromise).status).toBe(200)

    // Restore 4-char chapter from Editor History UI
    await page.goto(`/#/original/${workId}/${editionId}`)
    const editor = page.locator('.novel-body[contenteditable="true"]')
    await expect(editor).toBeVisible()
    await expect(page.locator('button.history-toggle .history-count')).toHaveText('1')
    await page.locator('button.history-toggle').click()
    const revDialog = page.getByRole('dialog', { name: /历史版本/ })
    await expect(revDialog.locator('.revision-preview-text')).toHaveText('四字短章')
    await revDialog.getByRole('button', { name: '恢复此版本' }).click()
    await expect(editor).toHaveText('四字短章')

    // 2) Legitimate small edit passes cleanly without destructive confirm
    const smallEditRes = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${proseChId}`, noDel.token, {
      content: minorEditOfA,
    })
    expect(smallEditRes.status).toBe(200)
    expect(smallEditRes.json.data.snapshotSaved).toBe(true)

    // 3) Equal-word wholesale replacement without delete -> blocked!
    const equalReplaceBlocked = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${proseChId}`, noDel.token, {
      content: passageB,
    })
    expect(equalReplaceBlocked.status).toBe(403)
    expect(equalReplaceBlocked.json.error.code).toBe('destructive_update_forbidden')
    expect(equalReplaceBlocked.json.error.reason).toBe('wholesale_content_replacement')

    // With delete -> triggers confirmation modal WITHOUT misleading (-0) word diff
    const eqDialog = page.getByRole('dialog', { name: '确认 AI 请求的操作' })
    const eqPromise = harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${proseChId}?wait=true`, withDel.token, {
      content: passageB,
    })
    await expect(eqDialog).toBeVisible()
    const dialogText = await eqDialog.innerText()
    expect(dialogText).not.toContain('(-0)')
    expect(dialogText).not.toContain('-0 字')
    await eqDialog.getByRole('button', { name: '本人确认执行' }).click()
    expect((await eqPromise).status).toBe(200)

    // Verify History has both passageA (before small edit) and minorEditOfA (before passageB), and restore passageA in UI
    await page.locator('.chapter-list button', { hasText: '灯塔夜班' }).click()
    await expect(editor).toContainText('北境星台静')
    await expect(page.locator('button.history-toggle .history-count')).toHaveText('2')
    await page.locator('button.history-toggle').click()
    const proseDialog = page.getByRole('dialog', { name: /历史版本/ })
    await expect(proseDialog.locator('.revision-item')).toHaveCount(2)
    await expect(proseDialog.locator('.revision-preview-text')).toContainText('琥珀闪烁')
    await proseDialog.locator('.revision-item').nth(1).click()
    await expect(proseDialog.locator('.revision-preview-text')).toContainText('暖光闪烁')
    await proseDialog.getByRole('button', { name: '恢复此版本' }).click()
    await expect(editor).toContainText('暖光闪烁')
  } finally {
    await harness.cleanup()
  }
})

test('7. 多次连续 AI 修改与 chapters.replaceBatch 均独立保留版本，UI 恢复前自动保存当前正文', async ({ page }) => {
  const harness = await mountAiHarness(page, { confirmTimeoutMs: 30_000 })
  try {
    harness.store.setEnabled(true)
    const ai = harness.store.createClient({
      name: 'ChainEditorAI',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: true },
      scope: { mode: 'all', workIds: [] },
    })
    await harness.bridge.sync()
    await gotoReady(page, '/')

    const v0 = '版本零：清晨的蒸汽列车停靠在第三站台，林晚整理好铜壳怀表。'
    const v1 = '版本一：清晨的蒸汽列车缓缓驶离第三站台，林晚收好铜壳怀表。'
    const v2 = '版本二：正午的蒸汽列车停靠在终点站台，林晚握紧铜壳怀表。'
    const v3 = '版本三：黄昏的蒸汽列车穿过隧道站台，林晚抬头看向钟楼。'

    const { workId, editionId, chapters } = await createWorkWithChapters(harness, ai.token, '连续改稿与多版本恢复', [
      { title: '列车章节', format: 'text', content: v0 },
      { title: '保留配角章', format: 'text', content: '配角章保持不变的正文。' },
      { title: '将被批删章', format: 'text', content: '将被批量替换删除进回收站的章节内容。' },
    ])
    const ch1Id = chapters[0].id
    const ch2Id = chapters[1].id

    expect((await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch1Id}`, ai.token, { content: v1 })).status).toBe(200)
    expect((await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch1Id}`, ai.token, { content: v2 })).status).toBe(200)

    // Batch replace drops ch3 and updates ch1 -> v3
    const batchDialog = page.getByRole('dialog', { name: '确认 AI 请求的操作' })
    const batchPromise = harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters?wait=true`, ai.token, {
      chapters: [
        { id: ch1Id, title: '列车章节', content: v3 },
        { id: ch2Id, title: '保留配角章', content: '配角章保持不变的正文。' },
      ],
    })
    await expect(batchDialog).toBeVisible()
    await batchDialog.getByRole('button', { name: '本人确认执行' }).click()
    const batchRes = await batchPromise
    expect(batchRes.status).toBe(200)
    expect(batchRes.json.data.trashedCount).toBe(1)

    // Open edition (starts on ch1) -> verify all 3 historical snapshots [v2, v1, v0] are preserved intact
    await page.goto(`/#/original/${workId}/${editionId}`)
    const editor = page.locator('.novel-body[contenteditable="true"]')
    await expect(editor).toHaveText(v3)
    await expect(page.locator('button.history-toggle .history-count')).toHaveText('3')
    await page.locator('button.history-toggle').click()
    const histDialog = page.getByRole('dialog', { name: /历史版本/ })
    const items = histDialog.locator('button.revision-item')
    await expect(items).toHaveCount(3)

    await items.nth(0).click()
    await expect(histDialog.locator('.revision-preview-text')).toHaveText(v2)
    await items.nth(1).click()
    await expect(histDialog.locator('.revision-preview-text')).toHaveText(v1)
    await items.nth(2).click()
    await expect(histDialog.locator('.revision-preview-text')).toHaveText(v0)

    // Restore v0 -> current v3 is automatically backed up BEFORE overwriting!
    await histDialog.getByRole('button', { name: '恢复此版本' }).click()
    await expect(editor).toHaveText(v0)
    await expect(page.locator('button.history-toggle .history-count')).toHaveText('4')

    // Open History again -> top entry is pre-restore backup of v3 and can itself be restored
    await page.locator('button.history-toggle').click()
    await expect(histDialog).toBeVisible()
    await expect(histDialog.locator('button.revision-item').first()).toContainText('恢复前自动备份')
    await expect(histDialog.locator('.revision-preview-text')).toHaveText(v3)
    await histDialog.getByRole('button', { name: '恢复此版本' }).click()
    await expect(editor).toHaveText(v3)
    await expect(page.locator('button.history-toggle .history-count')).toHaveText('5')

    // Confirm ch3 dropped in batch is recoverable in Trash
    await page.goto('/#/trash')
    await expect(page.getByRole('list', { name: '回收站内容' })).toContainText('将被批删章')
  } finally {
    await harness.cleanup()
  }
})

test('8. 页面刷新/应用重启后，回收站、历史版本以及持久化 AI 防破坏累计基线依然有效', async ({ page }) => {
  const harness = await mountAiHarness(page, { confirmTimeoutMs: 30_000 })
  try {
    harness.store.setEnabled(true)
    const noDel = harness.store.createClient({
      name: 'RestartTestWriter',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: false },
      scope: { mode: 'all', workIds: [] },
    })
    const withDel = harness.store.createClient({
      name: 'RestartTestDeleter',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: true },
      scope: { mode: 'all', workIds: [] },
    })
    await harness.bridge.sync()
    await gotoReady(page, '/')

    const words = Array.from({ length: 220 }, (_, i) => `word${String(i + 1).padStart(3, '0')}`)
    const full220 = words.join(' ')
    const cutTo145 = words.slice(0, 145).join(' ')
    const cutTo76 = words.slice(0, 76).join(' ')

    const anchorPartA = Array.from({ length: 30 }, (_, i) => `alpha${i}`).join(' ')
    const anchorPartB = Array.from({ length: 30 }, (_, i) => `beta${i}`).join(' ')
    const step1KeepA = `${anchorPartA} ${Array.from({ length: 30 }, (_, i) => `gamma${i}`).join(' ')}`
    const step2DropA = `${Array.from({ length: 30 }, (_, i) => `delta${i}`).join(' ')} ${Array.from({ length: 30 }, (_, i) => `gamma${i}`).join(' ')}`

    const { workId, editionId, chapters } = await createWorkWithChapters(harness, withDel.token, '重启持久化小说', [
      { title: '长章累计测试', format: 'text', content: full220 },
      { title: '进回收站章节', format: 'text', content: '重启后必须还在回收站的正文。' },
      { title: '渐进全文替换章', format: 'text', content: `${anchorPartA} ${anchorPartB}` },
    ])
    const ch1Id = chapters[0].id
    const ch2Id = chapters[1].id
    const ch3Id = chapters[2].id

    // Delete ch2 into trash with confirmation
    const dialog = page.getByRole('dialog', { name: '确认 AI 请求的操作' })
    const delPromise = harness.api('DELETE', `/works/original/${workId}/editions/${editionId}/chapters/${ch2Id}?wait=true`, withDel.token)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '本人确认执行' }).click()
    expect((await delPromise).status).toBe(200)

    // Step 1 before restart: noDel trims 220 -> 145 and rewrites half of ch3 (both allowed!)
    const trim1 = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch1Id}`, noDel.token, {
      content: cutTo145,
    })
    expect(trim1.status).toBe(200)
    const rewrite1 = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch3Id}`, noDel.token, {
      content: step1KeepA,
    })
    expect(rewrite1.status).toBe(200)

    // Simulated full app restart / page reload (wipes ALL in-memory Maps & UI state!)
    await page.reload()
    await page.waitForFunction(() => Boolean(window.__nwAiEvents?.dispatch))
    await page.goto('/#/trash')

    // Trash survives restart and restores ch2 cleanly
    const trashList = page.getByRole('list', { name: '回收站内容' })
    await expect(trashList).toContainText('进回收站章节')
    await trashList.locator('.trash-row', { hasText: '进回收站章节' }).getByRole('button', { name: '恢复' }).click()
    const restoredCh2 = await harness.api('GET', `/works/original/${workId}/editions/${editionId}/chapters/${ch2Id}`, noDel.token)
    expect(restoredCh2.status).toBe(200)
    expect(restoredCh2.json.data.chapter.text).toBe('重启后必须还在回收站的正文。')

    // History survives restart
    await page.goto(`/#/original/${workId}/${editionId}`)
    await expect(page.locator('button.history-toggle .history-count')).toHaveText('1')

    // Step 2 AFTER restart: trim 145 -> 76 triggers cumulative_massive_loss,
    // AND replacing the remaining half of ch3 triggers cumulative_wholesale_replacement via persisted anchorText!
    const trim2AfterReload = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch1Id}`, noDel.token, {
      content: cutTo76,
    })
    expect(trim2AfterReload.status).toBe(403)
    expect(trim2AfterReload.json.error.code).toBe('destructive_update_forbidden')
    expect(trim2AfterReload.json.error.reason).toBe('cumulative_massive_loss')

    const rewrite2AfterReload = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch3Id}`, noDel.token, {
      content: step2DropA,
    })
    expect(rewrite2AfterReload.status).toBe(403)
    expect(rewrite2AfterReload.json.error.code).toBe('destructive_update_forbidden')
    expect(rewrite2AfterReload.json.error.reason).toBe('cumulative_wholesale_replacement')

    // Verify chapters remained untouched after reload block
    const readCh1 = await harness.api('GET', `/works/original/${workId}/editions/${editionId}/chapters/${ch1Id}`, noDel.token)
    expect(readCh1.json.data.chapter.text).toBe(cutTo145)
    const readCh3 = await harness.api('GET', `/works/original/${workId}/editions/${editionId}/chapters/${ch3Id}`, noDel.token)
    expect(readCh3.json.data.chapter.text).toBe(step1KeepA)
  } finally {
    await harness.cleanup()
  }
})

test('9. 保存恢复快照失败时原子中止修改：单章更新与批量替换均不得改写原正文或残留脏状态', async ({ page }) => {
  const harness = await mountAiHarness(page, { confirmTimeoutMs: 30_000 })
  try {
    harness.store.setEnabled(true)
    const ai = harness.store.createClient({
      name: 'AtomicityAI',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: true },
      scope: { mode: 'all', workIds: [] },
    })
    await harness.bridge.sync()
    await gotoReady(page, '/')

    const originalOne = '原子性保护第一章：若历史快照写入失败，这一句必须一字不动地保留。'
    const originalTwo = '原子性保护第二章：批量写入事务中止后本章依然完整无缺。'
    const { workId, editionId, chapters } = await createWorkWithChapters(harness, ai.token, '快照失败原子保护小说', [
      { title: '第一章', format: 'text', content: originalOne },
      { title: '第二章', format: 'text', content: originalTwo },
    ])
    const ch1Id = chapters[0].id
    const ch2Id = chapters[1].id

    // Fault inject IndexedDB `revisions.add` to abort transaction and throw QuotaExceededError
    await page.evaluate(() => {
      const origAdd = IDBObjectStore.prototype.add
      window.__restoreIdbAdd = () => { IDBObjectStore.prototype.add = origAdd }
      IDBObjectStore.prototype.add = function patchedAdd(...args) {
        if (this.name === 'revisions') {
          try { this.transaction?.abort?.() } catch {}
          throw new DOMException('Simulated snapshot persistence failure', 'QuotaExceededError')
        }
        return origAdd.apply(this, args)
      }
    })

    // 1) Single-chapter update fails cleanly and leaves originalOne intact
    const singleAttempt = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${ch1Id}`, ai.token, {
      content: '原子性保护第一章：若历史快照写入失败，这一句变成了错误覆盖结果。',
    })
    expect(singleAttempt.status).toBeGreaterThanOrEqual(400)
    expect(singleAttempt.json.ok).toBe(false)

    // 2) Batch replacement (both non-destructive and confirmed destructive) fails cleanly when snapshot write fails
    const nonDestructiveBatch = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters`, ai.token, {
      chapters: [
        { id: ch1Id, title: '第一章', content: originalOne.replace('保留', '保存') },
        { id: ch2Id, title: '第二章', content: originalTwo.replace('无缺', '完好') },
      ],
    })
    expect(nonDestructiveBatch.status).toBeGreaterThanOrEqual(400)
    expect(nonDestructiveBatch.json.ok).toBe(false)

    const confirmDialog = page.getByRole('dialog', { name: '确认 AI 请求的操作' })
    const confirmedDestructiveBatchPromise = harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters?wait=true`, ai.token, {
      chapters: [{ id: ch1Id, title: '改坏了的标题', content: '错误批改一' }],
    })
    await expect(confirmDialog).toBeVisible()
    await confirmDialog.getByRole('button', { name: '本人确认执行' }).click()
    const destructiveBatchAttempt = await confirmedDestructiveBatchPromise
    expect(destructiveBatchAttempt.status).toBeGreaterThanOrEqual(400)
    expect(destructiveBatchAttempt.json.ok).toBe(false)

    // Remove fault injection and verify storage & UI are completely untouched
    await page.evaluate(() => { window.__restoreIdbAdd?.() })

    const verifyCh1 = await harness.api('GET', `/works/original/${workId}/editions/${editionId}/chapters/${ch1Id}`, ai.token)
    const verifyCh2 = await harness.api('GET', `/works/original/${workId}/editions/${editionId}/chapters/${ch2Id}`, ai.token)
    expect(verifyCh1.json.data.chapter.text).toBe(originalOne)
    expect(verifyCh1.json.data.chapter.title).toBe('第一章')
    expect(verifyCh2.json.data.chapter.text).toBe(originalTwo)

    await page.goto(`/#/original/${workId}/${editionId}`)
    await expect(page.locator('.novel-body[contenteditable="true"]')).toHaveText(originalOne)
    await expect(page.locator('button.history-toggle .history-count')).toHaveText('')
    await expect(page.locator('button.history-toggle .history-count')).toBeHidden()
    await page.goto('/#/trash')
    await expect(page.getByRole('heading', { name: '回收站是空的' })).toBeVisible()
  } finally {
    await page.evaluate(() => { window.__restoreIdbAdd?.() }).catch(() => {})
    await harness.cleanup()
  }
})

test('10. ideas.update 原子快照保护、多版本叠加恢复与灵感历史严格隔离', async ({ page }) => {
  const harness = await mountAiHarness(page, { confirmTimeoutMs: 30_000 })
  try {
    harness.store.setEnabled(true)
    const ai = harness.store.createClient({
      name: 'IdeaGuardAI',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: false },
      scope: { mode: 'all', workIds: [] },
    })
    await harness.bridge.sync()
    await gotoReady(page, '/')

    const { workId } = await createWorkWithChapters(harness, ai.token, '灵感归属小说', [
      { title: '第一章', format: 'text', content: '小说起步内容。' },
    ])

    const createdIdea = await harness.api('POST', '/ideas', ai.token, {
      text: '初始灵感：雨夜钟楼其实是一台大型留声机',
      work: { library: 'original', bookId: workId },
    })
    expect(createdIdea.status).toBe(201)
    const ideaId = createdIdea.json.data.idea.id

    // Continuous AI updates preserve each prior state before modifying
    const up1 = await harness.api('PATCH', `/ideas/${ideaId}`, ai.token, {
      text: '第二版灵感：钟楼在停电后会倒放十年前的录音',
      used: true,
      work: null,
    })
    expect(up1.status).toBe(200)
    expect(up1.json.data.snapshotSaved).toBe(true)

    const up2 = await harness.api('PATCH', `/ideas/${ideaId}`, ai.token, {
      text: '第三版灵感：被删掉的时间段都被存在地下铜盘里',
      used: false,
      work: { library: 'original', bookId: workId },
    })
    expect(up2.status).toBe(200)
    expect(up2.json.data.snapshotSaved).toBe(true)

    // AI cannot read or tamper with idea history routes
    for (const [method, urlPath] of [
      ['GET', `/ideas/${ideaId}/revisions`],
      ['GET', '/idea-revisions'],
      ['GET', '/revision-blobs'],
    ]) {
      const forbidden = await harness.api(method, urlPath, ai.token)
      expect(forbidden.status).toBe(403)
      expect(forbidden.json.error.code).toBe('recovery_data_forbidden')
    }

    // Survive reload + UI preview & restore backs up current idea state first
    await page.reload()
    await page.waitForFunction(() => Boolean(window.__nwAiEvents?.dispatch))
    await page.goto('/#/ideas')
    const badge = page.locator('.idea-history-button')
    await expect(badge).toContainText('2 个历史版本')
    await badge.click()

    const dialog = page.getByRole('dialog', { name: '灵感历史版本' })
    const items = dialog.locator('button.revision-item')
    await expect(items).toHaveCount(2)
    await expect(dialog.locator('.revision-preview-text')).toHaveText('第二版灵感：钟楼在停电后会倒放十年前的录音')
    await items.nth(1).click()
    await expect(dialog.locator('.revision-preview-text')).toHaveText('初始灵感：雨夜钟楼其实是一台大型留声机')

    await dialog.getByRole('button', { name: '恢复此版本' }).click()
    await expect(page.getByRole('status').filter({ hasText: '已恢复所选灵感版本，当前状态已自动备份。' })).toBeVisible()
    await expect(page.locator('.idea-text')).toHaveText('初始灵感：雨夜钟楼其实是一台大型留声机')
    await expect(badge).toContainText('3 个历史版本')

    // Pre-restore state (v3) must be saved as the newest history entry
    await badge.click()
    await expect(dialog.locator('button.revision-item')).toHaveCount(3)
    await expect(dialog.locator('.revision-preview-text')).toHaveText('第三版灵感：被删掉的时间段都被存在地下铜盘里')
    await dialog.getByRole('button', { name: '关闭' }).first().click()

    // Fault inject QuotaExceededError on ideaRevisions.add -> ideas.update aborts atomically
    await page.evaluate(() => {
      const origAdd = IDBObjectStore.prototype.add
      window.__restoreIdeaAdd = () => { IDBObjectStore.prototype.add = origAdd }
      IDBObjectStore.prototype.add = function patched(value, key) {
        if (this.name === 'ideaRevisions') {
          throw new DOMException('Simulated quota exceeded on ideaRevisions', 'QuotaExceededError')
        }
        return origAdd.call(this, value, key)
      }
    })
    const failedUpdate = await harness.api('PATCH', `/ideas/${ideaId}`, ai.token, {
      text: '故障注入下绝不能写进去的内容',
    })
    expect(failedUpdate.status).toBeGreaterThanOrEqual(400)
    expect(failedUpdate.json.ok).toBe(false)

    await page.evaluate(() => { window.__restoreIdeaAdd?.() })
    const listAfterFail = await harness.api('GET', '/ideas', ai.token)
    expect(listAfterFail.status).toBe(200)
    expect(listAfterFail.json.data.ideas.find((item) => item.id === ideaId).text).toBe('初始灵感：雨夜钟楼其实是一台大型留声机')
  } finally {
    await page.evaluate(() => { window.__restoreIdeaAdd?.() }).catch(() => {})
    await harness.cleanup()
  }
})

test('11. restoreChapterRevision 在统一事务内完整恢复原章节标题与正文，并同步目录与编辑区', async ({ page }) => {
  const harness = await mountAiHarness(page, { confirmTimeoutMs: 30_000 })
  try {
    harness.store.setEnabled(true)
    const ai = harness.store.createClient({
      name: 'TitleRestoreAI',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: false },
      scope: { mode: 'all', workIds: [] },
    })
    await harness.bridge.sync()
    await gotoReady(page, '/')

    const shared = '海风吹过灯塔外墙时总带着潮湿的铁锈气息，值守人把今晚的航标记录摊开在长桌上，仔细核对每一个刻度与潮汐时间。'
    const origText = `${shared} 原始第一版段落结尾保持完整。`
    const nextText = `${shared} 经过 AI 润色后的段落结尾也保持足够重合。`
    const { workId, editionId, chapters } = await createWorkWithChapters(harness, ai.token, '标题与正文联动书', [
      { title: '最初的序章标题', format: 'text', content: origText },
    ])
    const chId = chapters[0].id

    const updated = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${chId}`, ai.token, {
      title: 'AI 改写后的章名',
      content: nextText,
    })
    expect(updated.status).toBe(200)

    await page.goto(`/#/original/${workId}/${editionId}`)
    await expect(page.locator('.writing-header h3')).toHaveText('AI 改写后的章名')
    await expect(page.getByRole('list', { name: '章节' }).getByRole('button').first()).toContainText('AI 改写后的章名')
    await expect(page.locator('.novel-body[contenteditable="true"]')).toHaveText(nextText)

    await page.locator('button.history-toggle').click()
    const dialog = page.getByRole('dialog', { name: /历史版本/ })
    await expect(dialog.locator('.revision-preview-text')).toHaveText(origText)
    await dialog.getByRole('button', { name: '恢复此版本' }).click()

    // Title in heading & sidebar AND body content AND backup snapshot all update cleanly
    await expect(page.locator('.writing-header h3')).toHaveText('最初的序章标题')
    await expect(page.getByRole('list', { name: '章节' }).getByRole('button').first()).toContainText('最初的序章标题')
    await expect(page.locator('.novel-body[contenteditable="true"]')).toHaveText(origText)
    await expect(page.locator('button.history-toggle .history-count')).toHaveText('2')

    await page.reload()
    await page.waitForFunction(() => Boolean(window.__nwAiEvents?.dispatch))
    await expect(page.locator('.writing-header h3')).toHaveText('最初的序章标题')
    await expect(page.locator('.novel-body[contenteditable="true"]')).toHaveText(origText)

    await page.locator('button.history-toggle').click()
    await expect(dialog.locator('.revision-preview-text')).toHaveText(nextText)
  } finally {
    await harness.cleanup()
  }
})

test('12. 删除/破坏性修改确认期间目标内容变化返回 409，权限范围缩小即时终止待确认', async ({ page }) => {
  const harness = await mountAiHarness(page, { confirmTimeoutMs: 30_000 })
  try {
    harness.store.setEnabled(true)
    const { client: readerClient, token: editorToken } = harness.store.createClient({
      name: 'ConcurrentEditorAI',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: false },
      scope: { mode: 'all', workIds: [] },
    })
    const { client: aiClient, token: deleterToken } = harness.store.createClient({
      name: 'DeleterConfirmAI',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: true },
      scope: { mode: 'all', workIds: [] },
    })
    await harness.bridge.sync()
    await gotoReady(page, '/')

    const baseWords = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    const { workId, editionId, chapters } = await createWorkWithChapters(harness, editorToken, '确认一致性作品', [
      { title: '第一章', format: 'text', content: baseWords },
    ])
    const chId = chapters[0].id

    // 1. Destructive chapters.update interrupted by another edit while waiting for confirmation
    const dialog = page.getByRole('dialog', { name: '确认 AI 请求的操作' })
    const destructivePromise = harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${chId}?wait=true`, deleterToken, {
      content: '被缩水成一句话',
    })
    await expect(dialog).toBeVisible()
    const newerBody = `${baseWords} concurrent_addition`
    expect((await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${chId}`, editorToken, {
      content: newerBody,
    })).status).toBe(200)
    await dialog.getByRole('button', { name: '本人确认执行' }).click()
    const staleUpdate = await destructivePromise
    expect(staleUpdate.status).toBe(409)
    expect(staleUpdate.json.error.code).toBe('stale_confirmation_target')

    // 2. chapters.delete interrupted by edit while waiting -> 409 and chapter preserved
    const chDeletePromise = harness.api('DELETE', `/works/original/${workId}/editions/${editionId}/chapters/${chId}?wait=true`, deleterToken)
    await expect(dialog).toBeVisible()
    expect((await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${chId}`, editorToken, {
      title: '第一章（已修改）',
    })).status).toBe(200)
    await dialog.getByRole('button', { name: '本人确认执行' }).click()
    const staleChDelete = await chDeletePromise
    expect(staleChDelete.status).toBe(409)
    expect(staleChDelete.json.error.code).toBe('stale_confirmation_target')

    // 3. ideas.delete interrupted by ideas.update -> 409 and idea preserved
    const ideaCreated = await harness.api('POST', '/ideas', editorToken, {
      text: '等待删除确认前的灵感',
      work: { library: 'original', bookId: workId },
    })
    const ideaId = ideaCreated.json.data.idea.id
    const ideaDelPromise = harness.api('DELETE', `/ideas/${ideaId}?wait=true`, deleterToken)
    await expect(dialog).toBeVisible()
    expect((await harness.api('PATCH', `/ideas/${ideaId}`, editorToken, { text: '用户刚修改过这条灵感' })).status).toBe(200)
    await dialog.getByRole('button', { name: '本人确认执行' }).click()
    const staleIdeaDel = await ideaDelPromise
    expect(staleIdeaDel.status).toBe(409)
    expect(staleIdeaDel.json.error.code).toBe('stale_confirmation_target')

    // 4. Shrinking client scope from 'all' to 'selected' excluding target cancels pending delete immediately
    const { workId: otherWorkId } = await createWorkWithChapters(harness, editorToken, '另一部安全作品', [
      { title: '第一章', format: 'text', content: '安全内容' },
    ])
    const workDelPromise = harness.api('DELETE', `/works/original/${workId}?wait=true`, deleterToken)
    await expect(dialog).toBeVisible()
    await page.evaluate(async ([id, keepWork]) => {
      await window.newWorldDesktop.updateAiClient(id, { scope: { mode: 'selected', workIds: [keepWork] } })
    }, [aiClient.id, `original:${otherWorkId}`])
    await expect(dialog).toBeHidden()
    const canceledRes = await workDelPromise
    expect(canceledRes.status).toBeGreaterThanOrEqual(400)
    expect(canceledRes.json.ok).toBe(false)

    // Verify work & idea are intact
    expect((await harness.api('GET', `/works/original/${workId}`, editorToken)).status).toBe(200)
    const remainingIdeas = await harness.api('GET', '/ideas', editorToken)
    expect(remainingIdeas.json.data.ideas.some((item) => item.id === ideaId)).toBe(true)
    void readerClient
  } finally {
    await harness.cleanup()
  }
})

test('13. 章节历史去重压缩存储、空间统计与超阈值提示、用户确认清理旧历史并保留最新可恢复版本', async ({ page }) => {
  const harness = await mountAiHarness(page, { confirmTimeoutMs: 30_000 })
  try {
    harness.store.setEnabled(true)
    const ai = harness.store.createClient({
      name: 'DedupPruneAI',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: false },
      scope: { mode: 'all', workIds: [] },
    })
    await harness.bridge.sync()
    await gotoReady(page, '/')

    const commonLead = '这是一个用来验证内容去重与压缩机制的较长公共前缀正文，反复出现在多次版本迭代中以确保能够切实压缩并命中同一个内容寻址块。'
    const textA = `${commonLead} 分支版本 Alpha 段落。`
    const textB = `${commonLead} 分支版本 Beta 段落。`
    const { workId, editionId, chapters } = await createWorkWithChapters(harness, ai.token, '历史空间治理作品', [
      { title: '测试章', format: 'text', content: textA },
    ])
    const chId = chapters[0].id

    // Produce 7 snapshots alternating between textA and textB
    for (let i = 0; i < 7; i++) {
      const next = i % 2 === 0 ? textB : textA
      const res = await harness.api('PUT', `/works/original/${workId}/editions/${editionId}/chapters/${chId}`, ai.token, {
        content: next,
      })
      expect(res.status).toBe(200)
    }

    // Deduplication check in IndexedDB: 7 revisions reference only 2 unique blobs
    const counts = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('new-world-library')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const revs = await new Promise((r) => { const q = db.transaction('revisions').objectStore('revisions').getAll(); q.onsuccess = () => r(q.result) })
      const blobs = await new Promise((r) => { const q = db.transaction('revisionBlobs').objectStore('revisionBlobs').getAll(); q.onsuccess = () => r(q.result) })
      db.close()
      return { revs: revs.length, blobs: blobs.length, hasInline: revs.some((r) => Boolean(r.content)) }
    })
    expect(counts.revs).toBe(7)
    expect(counts.blobs).toBe(2)
    expect(counts.hasInline).toBe(false)

    // UI stats + cancel + confirmed pruning down to 5 -> then 1 -> button hides so >=1 stays protected
    await page.goto(`/#/original/${workId}/${editionId}`)
    await page.locator('button.history-toggle').click()
    const histDialog = page.getByRole('dialog', { name: /历史版本/ })
    await expect(histDialog.locator('.revision-storage-summary')).toContainText('本章 7 条 · 历史库共 7 条')

    const pruneBtn = histDialog.getByRole('button', { name: '清理较早历史…' })
    await pruneBtn.click()
    const confirmPruneDialog = page.getByRole('dialog', { name: '清理较早历史版本？' })
    await confirmPruneDialog.getByRole('button', { name: '取消' }).click()
    await expect(histDialog.locator('button.revision-item')).toHaveCount(7)

    await pruneBtn.click()
    await confirmPruneDialog.getByRole('button', { name: '确认清理较早历史' }).click()
    await expect(page.getByRole('status').filter({ hasText: '已清理 2 条较早历史，当前保留最近 5 个可恢复版本。' })).toBeVisible()
    await expect(histDialog.locator('button.revision-item')).toHaveCount(5)

    await pruneBtn.click()
    await confirmPruneDialog.getByRole('button', { name: '确认清理较早历史' }).click()
    await expect(histDialog.locator('button.revision-item')).toHaveCount(1)
    await expect(pruneBtn).toBeHidden()
    await histDialog.getByRole('button', { name: '关闭' }).first().click()

    // Seeding 205 revisions triggers soft capacity warning banner cleanly
    await page.evaluate(async ([wId, edId, chapterId]) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('new-world-library')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const existingBlobs = await new Promise((r) => {
        const q = db.transaction('revisionBlobs').objectStore('revisionBlobs').getAll()
        q.onsuccess = () => r(q.result)
      })
      const blob = existingBlobs[0]
      const tx = db.transaction('revisions', 'readwrite', { durability: 'strict' })
      const store = tx.objectStore('revisions')
      const baseTime = Date.now() - 1_000_000
      for (let i = 0; i < 205; i++) {
        store.add({
          id: `seed-${i}-${crypto.randomUUID()}`,
          library: 'original',
          bookId: wId,
          editionId: edId,
          chapterId,
          chapterTitle: '测试章',
          contentHash: blob.hash,
          blobHash: blob.hash,
          rawBytes: blob.rawBytes,
          storedBytes: blob.storedBytes,
          words: 50,
          source: 'ai',
          action: 'chapters.update',
          createdAt: baseTime + i,
        })
      }
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
      db.close()
    }, [workId, editionId, chId])

    await page.locator('button.history-toggle').click()
    await expect(histDialog.getByRole('status')).toContainText('历史快照已累积 206 条')
  } finally {
    await harness.cleanup()
  }
})
