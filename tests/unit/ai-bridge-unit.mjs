import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { maxInstallerBytes, readMacInstaller, readWindowsInstaller } from '../../desktop/release.mjs'

const require = createRequire(import.meta.url)
const { createAiStore } = require('../../desktop/ai-store.cjs')
const { createAiBridge } = require('../../desktop/ai-bridge.cjs')
const {
  isTrustedOriginFrame,
  isTrustedMainRenderer,
  isTrustedCaptureRenderer,
  isTrustedAppRenderer,
  shouldCancelClientConfirmations,
} = require('../../desktop/ipc-guard.cjs')
const { createWindowsUpdater, UpdateError } = require('../../desktop/windows-update.cjs')
const { createMacUpdater, MacUpdateError } = require('../../desktop/macos-update.cjs')

const tempDirs = []

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-ai-unit-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function rawHttpRequest({ port, method = 'GET', urlPath = '/v1/health', headers = {}, body = undefined }) {
  const payload = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  const mergedHeaders = { ...headers }
  if (payload !== undefined && !mergedHeaders['Content-Length'] && !mergedHeaders['content-length']) {
    mergedHeaders['Content-Length'] = Buffer.byteLength(payload)
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: mergedHeaders,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: raw ? JSON.parse(raw) : null,
        })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

describe('desktop/ai-store', () => {
  it('defaults to disabled, hashes tokens, strips untrusted flags, and supports instant rotation', () => {
    const dir = makeTempDir()
    const store = createAiStore(dir)

    const initial = store.getPublicState()
    assert.equal(initial.enabled, false)
    assert.deepEqual(initial.clients, [])

    const created = store.createClient({
      name: 'Claude Code',
      enabled: true,
      admin: true,
      skipConfirmation: true,
    })
    assert.ok(created.token.startsWith('nw_ai_'))
    assert.equal(created.client.permissions.read, false)
    assert.equal(created.client.permissions.create, false)
    assert.equal(created.client.permissions.update, false)
    assert.equal(created.client.permissions.delete, false)
    assert.equal(created.client.scope.mode, 'none')
    assert.equal('tokenHash' in created.client, false)
    assert.equal('admin' in created.client, false)

    // Disk file must never store raw token or untrusted bypass fields
    const diskText = fs.readFileSync(store.configPath, 'utf8')
    assert.equal(diskText.includes(created.token), false)
    assert.equal(diskText.includes('skipConfirmation'), false)
    assert.equal(diskText.includes('"admin"'), false)

    assert.equal(store.verifyToken(created.token)?.id, created.client.id)
    assert.equal(store.verifyToken('nw_ai_wrongtoken_value_123456'), null)

    const rotated = store.rotateClientToken(created.client.id)
    assert.notEqual(rotated.token, created.token)
    assert.equal(store.verifyToken(created.token), null)
    assert.equal(store.verifyToken(rotated.token)?.id, created.client.id)

    // Corrupted config falls back safely to disabled
    fs.writeFileSync(store.configPath, '{bad json', 'utf8')
    const recovered = store.reload()
    assert.equal(recovered.enabled, false)
    assert.deepEqual(recovered.clients, [])
  })
})

describe('desktop/ai-bridge', () => {
  it('binds strictly on localhost only when enabled and rejects spoofed Host/Origin headers', async () => {
    const dir = makeTempDir()
    const store = createAiStore(dir)
    const bridge = createAiBridge({
      store,
      bindPort: 0,
      dispatchOperation: async () => ({ ok: true, data: {} }),
    })

    try {
      await bridge.sync()
      assert.equal(bridge.getStatus().running, false)

      store.setEnabled(true)
      const status = await bridge.sync()
      assert.equal(status.running, true)
      assert.equal(status.host, '127.0.0.1')
      const port = status.port

      const health = await rawHttpRequest({ port, urlPath: '/v1/health' })
      assert.equal(health.status, 200)
      assert.equal(health.body.ok, true)
      assert.equal(health.body.apiVersion, 'v1')
      assert.equal(health.body.confirmationRequiredForDelete, true)

      const unauth = await rawHttpRequest({ port, urlPath: '/v1/capabilities' })
      assert.equal(unauth.status, 401)

      const badHost = await rawHttpRequest({
        port,
        urlPath: '/v1/health',
        headers: { Host: 'evil.attacker.com:47831' },
      })
      assert.equal(badHost.status, 403)
      assert.equal(badHost.body.error.code, 'invalid_host_header')

      const badOrigin = await rawHttpRequest({
        port,
        urlPath: '/v1/health',
        headers: { Origin: 'https://evil.attacker.com' },
      })
      assert.equal(badOrigin.status, 403)
      assert.equal(badOrigin.body.error.code, 'browser_origin_forbidden')

      const badFetchSite = await rawHttpRequest({
        port,
        urlPath: '/v1/health',
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      })
      assert.equal(badFetchSite.status, 403)
      assert.equal(badFetchSite.body.error.code, 'browser_origin_forbidden')

      store.setEnabled(false)
      await bridge.sync()
      assert.equal(bridge.getStatus().running, false)
    } finally {
      await bridge.stop()
    }
  })

  it('enforces client identity strictly by Bearer token (ignores spoofed client headers)', async () => {
    const dir = makeTempDir()
    const store = createAiStore(dir)
    store.setEnabled(true)
    const clientA = store.createClient({
      name: 'ClientA',
      enabled: true,
      permissions: { read: false, create: false, update: false, delete: false },
      scope: { mode: 'none', workIds: [] },
    })
    const clientB = store.createClient({
      name: 'ClientB',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: true },
      scope: { mode: 'all', workIds: [] },
    })

    const bridge = createAiBridge({
      store,
      bindPort: 0,
      dispatchOperation: async (req) => ({ ok: true, data: { seenClientId: req.client.id } }),
    })

    try {
      const { port } = await bridge.sync()
      const denied = await rawHttpRequest({
        port,
        urlPath: '/v1/works',
        headers: {
          Authorization: `Bearer ${clientA.token}`,
          'X-Client-Name': clientB.client.name,
          'X-Client-Id': clientB.client.id,
        },
      })
      assert.equal(denied.status, 403)
      assert.equal(denied.body.error.code, 'permission_denied')

      const caps = await rawHttpRequest({
        port,
        urlPath: '/v1/capabilities',
        headers: {
          Authorization: `Bearer ${clientA.token}`,
          'X-Client-Name': clientB.client.name,
        },
      })
      assert.equal(caps.status, 200)
      assert.equal(caps.body.data.client.id, clientA.client.id)
      assert.equal(caps.body.data.client.name, 'ClientA')
    } finally {
      await bridge.stop()
    }
  })

  it('guarantees non-bypassable, single-use, client-isolated delete confirmations and timeout/revocation safety', async () => {
    const dir = makeTempDir()
    const store = createAiStore(dir)
    store.setEnabled(true)
    const owner = store.createClient({
      name: 'OwnerAI',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: true },
      scope: { mode: 'all', workIds: [] },
    })
    const other = store.createClient({
      name: 'OtherAI',
      enabled: true,
      permissions: { read: true, create: false, update: false, delete: true },
      scope: { mode: 'all', workIds: [] },
    })

    const executedGrants = []
    let prompted = 0
    let closedCount = 0

    const bridge = createAiBridge({
      store,
      bindPort: 0,
      confirmTimeoutMs: 250,
      onPromptConfirmation: () => { prompted++ },
      onCloseConfirmation: () => { closedCount++ },
      dispatchOperation: async (req) => {
        if (req.phase === 'prepare-delete') {
          return {
            ok: false,
            requiresConfirmation: true,
            confirmedAction: req.action,
            fingerprint: 'fp-1',
            targetSummary: 'Demo Novel',
            impact: { kind: 'work', bookTitle: 'Demo Novel', summary: 'Demo Novel (1 chapter)' },
          }
        }
        if (req.phase === 'execute-confirmed') {
          executedGrants.push(req.approvalGrant)
          return { ok: true, data: { deleted: true } }
        }
        return { ok: true, data: {} }
      },
    })

    try {
      const { port } = await bridge.sync()

      // 1. Delete returns pending confirmation even when AI passes confirm/force flags
      const del1 = await rawHttpRequest({
        port,
        method: 'DELETE',
        urlPath: '/v1/works/original/book-1',
        headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
        body: { confirm: true, force: true, skipConfirmation: true },
      })
      assert.equal(del1.status, 202, JSON.stringify(del1.body))
      assert.equal(del1.body.status, 'pending_confirmation')
      assert.equal(prompted, 1)
      assert.equal(executedGrants.length, 0)

      // 2. AI cannot approve its own confirmation via API
      const selfConfirm = await rawHttpRequest({
        port,
        method: 'POST',
        urlPath: `/v1/confirmations/${del1.body.confirmationId}/confirm`,
        headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
        body: { approved: true },
      })
      assert.equal(selfConfirm.status, 403)
      assert.equal(selfConfirm.body.error.code, 'api_confirmation_forbidden')
      assert.equal(executedGrants.length, 0)

      // 3. Another AI cannot inspect OwnerAI's confirmation
      const otherPoll = await rawHttpRequest({
        port,
        method: 'GET',
        urlPath: `/v1/confirmations/${del1.body.confirmationId}`,
        headers: { Authorization: `Bearer ${other.token}` },
      })
      assert.equal(otherPoll.status, 404)

      // 4. Approve once via trusted UI callback -> executes once; second approval cannot reuse!
      const approved = await bridge.handleConfirmDecision({
        confirmationId: del1.body.confirmationId,
        approved: true,
      })
      assert.equal(approved.ok, true)
      assert.equal(approved.status, 'completed')
      assert.equal(executedGrants.length, 1)

      const reuse = await bridge.handleConfirmDecision({
        confirmationId: del1.body.confirmationId,
        approved: true,
      })
      assert.equal(reuse.ok, false)
      assert.equal(executedGrants.length, 1)

      // 5. Timeout with ?wait=true returns 408 and never executes
      const timedOutRes = await rawHttpRequest({
        port,
        method: 'DELETE',
        urlPath: '/v1/works/original/book-2?wait=true',
        headers: { Authorization: `Bearer ${owner.token}` },
      })
      assert.equal(timedOutRes.status, 408)
      assert.equal(timedOutRes.body.error.code, 'confirmation_timed_out')
      assert.equal(executedGrants.length, 1)
      assert.ok(closedCount >= 1)

      // 6. Revoking delete permission while modal is pending prevents approval
      const del3 = await rawHttpRequest({
        port,
        method: 'DELETE',
        urlPath: '/v1/works/original/book-3',
        headers: { Authorization: `Bearer ${owner.token}` },
      })
      assert.equal(del3.status, 202)
      store.updateClient(owner.client.id, {
        permissions: { read: true, create: true, update: true, delete: false },
      })
      const revokedDecision = await bridge.handleConfirmDecision({
        confirmationId: del3.body.confirmationId,
        approved: true,
      })
      assert.equal(revokedDecision.ok, false)
      assert.equal(executedGrants.length, 1)
    } finally {
      await bridge.stop()
    }
  })

  it('strictly isolates trash/revisions/backups, rejects history bypass flags, and records recovery audit receipts', async () => {
    const dir = makeTempDir()
    const store = createAiStore(dir)
    store.setEnabled(true)
    const fullClient = store.createClient({
      name: 'FullAI',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: true },
      scope: { mode: 'all', workIds: [] },
    })

    const dispatched = []
    const bridge = createAiBridge({
      store,
      bindPort: 0,
      confirmTimeoutMs: 5_000,
      onPromptConfirmation: () => {},
      onCloseConfirmation: () => {},
      dispatchOperation: async (req) => {
        dispatched.push(req)
        if (req.phase === 'prepare-delete') {
          return {
            ok: false,
            requiresConfirmation: true,
            confirmedAction: req.action,
            fingerprint: 'fp-trash-1',
            targetSummary: 'Trashable Idea',
            impact: { kind: 'idea', summary: 'Delete idea -> trash' },
          }
        }
        if (req.phase === 'execute-confirmed') {
          return {
            ok: true,
            auditReason: 'trashed:trash-idea-1',
            data: { deleted: true, recoverableInTrash: true },
          }
        }
        return {
          ok: true,
          auditReason: 'snapshot:rev-001',
          data: { updated: true },
        }
      },
    })

    try {
      const { port } = await bridge.sync()
      const auth = { Authorization: `Bearer ${fullClient.token}`, 'Content-Type': 'application/json' }

      // 1. Trash, revision history, and backup endpoints are unconditionally forbidden
      const forbiddenRoutes = [
        ['GET', '/v1/trash'],
        ['POST', '/v1/trash/item-1/restore'],
        ['DELETE', '/v1/trash/item-1'],
        ['DELETE', '/v1/trash'],
        ['GET', '/v1/revisions'],
        ['GET', '/v1/works/original/book-1/revisions'],
        ['DELETE', '/v1/works/original/book-1/editions/ed-1/chapters/ch-1/revisions/rev-1'],
        ['GET', '/v1/history'],
        ['GET', '/v1/backups'],
        ['POST', '/v1/backups/restore'],
      ]
      for (const [method, urlPath] of forbiddenRoutes) {
        const res = await rawHttpRequest({ port, method, urlPath, headers: auth })
        assert.equal(res.status, 403, `${method} ${urlPath} -> ${res.status}`)
        assert.equal(res.body.error.code, 'recovery_data_forbidden')
      }
      assert.equal(dispatched.length, 0)

      // 2. Attempting to disable or skip revision history via body or query is rejected cleanly
      const bypassAttempts = [
        {
          method: 'PUT',
          urlPath: '/v1/works/original/book-1/editions/ed-1/chapters/ch-1',
          body: { content: 'new text', skipHistory: true },
        },
        {
          method: 'PUT',
          urlPath: '/v1/works/original/book-1/editions/ed-1/chapters/ch-1',
          body: { content: 'new text', preserveHistory: false },
        },
        {
          method: 'PUT',
          urlPath: '/v1/works/original/book-1/editions/ed-1/chapters/ch-1?skipHistory=true',
          body: { content: 'new text' },
        },
        {
          method: 'PUT',
          urlPath: '/v1/works/original/book-1/editions/ed-1/chapters?preserveHistory=false',
          body: { chapters: [{ id: 'ch-1', title: 'Ch1', format: 'text', content: 'x' }] },
        },
      ]
      for (const req of bypassAttempts) {
        const res = await rawHttpRequest({ port, ...req, headers: auth })
        assert.equal(res.status, 403, `${req.method} ${req.urlPath}`)
        assert.equal(res.body.error.code, 'history_protection_non_bypassable')
      }
      assert.equal(dispatched.length, 0)

      // 3. Audit trail preserves snapshot & trash receipts on allowed / confirmed calls
      const editRes = await rawHttpRequest({
        port,
        method: 'PUT',
        urlPath: '/v1/works/original/book-1/editions/ed-1/chapters/ch-1',
        headers: auth,
        body: { content: 'safe edit' },
      })
      assert.equal(editRes.status, 200)

      const delRes = await rawHttpRequest({
        port,
        method: 'DELETE',
        urlPath: '/v1/ideas/idea-1',
        headers: auth,
      })
      assert.equal(delRes.status, 202)
      const confirmed = await bridge.handleConfirmDecision({
        confirmationId: delRes.body.confirmationId,
        approved: true,
      })
      assert.equal(confirmed.ok, true)

      const audit = store.listAudit(50)
      const allowedReasons = audit.filter((item) => item.outcome === 'allowed').map((item) => item.reason)
      const confirmedReasons = audit.filter((item) => item.outcome === 'confirmed').map((item) => item.reason)
      assert.equal(allowedReasons.includes('snapshot:rev-001'), true)
      assert.equal(confirmedReasons.includes('trashed:trash-idea-1'), true)
      const deniedReasons = audit.filter((item) => item.outcome === 'denied').map((item) => item.reason)
      assert.equal(deniedReasons.includes('recovery_data_forbidden'), true)
      assert.equal(deniedReasons.includes('history_protection_non_bypassable'), true)
    } finally {
      await bridge.stop()
    }
  })

  it('blocks idea/blob revision routes and rejects confirmation when client scope narrows before approval', async () => {
    const dir = makeTempDir()
    const store = createAiStore(dir)
    store.setEnabled(true)
    const workA = 'original:book-a'
    const workB = 'original:book-b'
    const client = store.createClient({
      name: 'ScopeShrinkAgent',
      enabled: true,
      permissions: { read: true, create: false, update: true, delete: true },
      scope: { mode: 'selected', workIds: [workA, workB] },
    })

    let promptedConfirmId = null
    const bridge = createAiBridge({
      store,
      bindPort: 0,
      onPromptConfirmation: (req) => {
        promptedConfirmId = req.confirmationId
      },
      dispatchOperation: async ({ action, params, phase }) => {
        if (phase === 'prepare-delete' && action === 'works.delete') {
          return {
            ok: false,
            requiresConfirmation: true,
            confirmedAction: 'works.delete',
            fingerprint: 'fp-book-a',
            targetSummary: 'Book A',
            impact: { kind: 'delete_work', library: params.library, bookId: params.bookId, title: 'Book A', summary: 'Delete Book A' },
          }
        }
        return { ok: true, statusCode: 200, data: { unexpected: true } }
      },
    })

    try {
      const { port } = await bridge.sync()
      const auth = { Authorization: `Bearer ${client.token}`, 'Content-Type': 'application/json' }

      // 1. Additional v0.15.2 recovery isolation routes are unconditionally forbidden
      for (const [method, urlPath] of [
        ['GET', '/v1/ideas/idea-1/revisions'],
        ['POST', '/v1/ideas/idea-1/history'],
        ['GET', '/v1/idea-revisions'],
        ['DELETE', '/v1/idea-revisions/rev-1'],
        ['GET', '/v1/revision-blobs'],
        ['DELETE', '/v1/revision-blobs/hash-1'],
      ]) {
        const res = await rawHttpRequest({ port, method, urlPath, headers: auth })
        assert.equal(res.status, 403, `${method} ${urlPath} -> ${res.status}`)
        assert.equal(res.body.error.code, 'recovery_data_forbidden')
      }

      // 2. Narrowing client scope to exclude target book invalidates pending confirmation
      const pendingPromise = rawHttpRequest({
        port,
        method: 'DELETE',
        urlPath: '/v1/works/original/book-a?wait=true',
        headers: auth,
      })
      for (let i = 0; i < 40 && !promptedConfirmId; i++) {
        await new Promise((r) => setTimeout(r, 15))
      }
      assert.ok(promptedConfirmId, 'Expected confirmation prompt to be queued')

      store.updateClient(client.client.id, {
        scope: { mode: 'selected', workIds: [workB] },
      })

      const decided = await bridge.handleConfirmDecision({
        confirmationId: promptedConfirmId,
        approved: true,
      })
      assert.equal(decided.ok, false)
      assert.equal(decided.code, 'scope_revoked')

      const waitRes = await pendingPromise
      assert.equal(waitRes.status, 403)
      assert.equal(waitRes.body.error.code, 'scope_revoked')

      const reasons = store.listAudit(20).map((item) => item.reason)
      assert.equal(reasons.includes('scope_revoked'), true)
    } finally {
      await bridge.stop()
    }
  })
})

describe('desktop/ipc-guard', () => {
  it('separates main renderer from capture renderer and rejects subframes/untrusted origins', () => {
    const appUrl = 'http://127.0.0.1:45123/'
    const mainContents = { id: 1, mainFrame: { url: `${appUrl}#/settings` } }
    const captureContents = { id: 2, mainFrame: { url: `${appUrl}#/capture` } }
    const subframe = { url: `${appUrl}#/settings` }
    const mainWindow = { webContents: mainContents, isDestroyed: () => false }
    const captureWindow = { webContents: captureContents, isDestroyed: () => false }

    const mainEvent = { sender: mainContents, senderFrame: mainContents.mainFrame }
    const captureEvent = { sender: captureContents, senderFrame: captureContents.mainFrame }
    const subframeEvent = { sender: mainContents, senderFrame: subframe }
    const evilEvent = { sender: { mainFrame: { url: 'https://evil.example/' } }, senderFrame: null }
    evilEvent.senderFrame = evilEvent.sender.mainFrame

    assert.equal(isTrustedOriginFrame(mainEvent, appUrl), true)
    assert.equal(isTrustedOriginFrame(subframeEvent, appUrl), false)
    assert.equal(isTrustedOriginFrame(evilEvent, appUrl), false)

    assert.equal(isTrustedMainRenderer(mainEvent, { appUrl, mainWindow }), true)
    assert.equal(isTrustedMainRenderer(captureEvent, { appUrl, mainWindow }), false)
    assert.equal(isTrustedMainRenderer(subframeEvent, { appUrl, mainWindow }), false)
    assert.equal(isTrustedMainRenderer(mainEvent, { appUrl, mainWindow: { webContents: mainContents, isDestroyed: () => true } }), false)

    assert.equal(isTrustedCaptureRenderer(captureEvent, { appUrl, captureWindow }), true)
    assert.equal(isTrustedCaptureRenderer(mainEvent, { appUrl, captureWindow }), false)

    assert.equal(isTrustedAppRenderer(mainEvent, { appUrl, mainWindow, captureWindow }), true)
    assert.equal(isTrustedAppRenderer(captureEvent, { appUrl, mainWindow, captureWindow }), true)
    assert.equal(isTrustedAppRenderer(evilEvent, { appUrl, mainWindow, captureWindow }), false)
  })

  it('detects confirmation cancellation on disable, delete revocation, or scope narrowing', () => {
    const base = {
      enabled: true,
      permissions: { read: true, create: false, update: true, delete: true },
      scope: { mode: 'selected', workIds: ['original:b1', 'original:b2'] },
    }
    assert.equal(shouldCancelClientConfirmations(base, { ...base, enabled: false }), true)
    assert.equal(shouldCancelClientConfirmations(base, { ...base, permissions: { ...base.permissions, delete: false } }), true)
    assert.equal(shouldCancelClientConfirmations(base, { ...base, scope: { mode: 'selected', workIds: ['original:b1'] } }), true)
    assert.equal(shouldCancelClientConfirmations({ ...base, scope: { mode: 'all', workIds: [] } }, base), true)
    assert.equal(shouldCancelClientConfirmations(base, { ...base, scope: { mode: 'selected', workIds: ['original:b1', 'original:b2', 'original:b3'] } }), false)
  })
})

describe('desktop/release & updaters', () => {
  it('enforces maxInstallerBytes bound in release asset parsing', () => {
    assert.equal(maxInstallerBytes, 1024 * 1024 * 1024)
    const tag = 'v0.99.0'
    const digest = 'sha256:' + 'a'.repeat(64)
    const winName = 'New-World-Setup-0.99.0-x64.exe'
    const macName = 'New-World-0.99.0-macos-arm64.dmg'

    assert.equal(readWindowsInstaller(tag, [{
      name: winName,
      state: 'uploaded',
      browser_download_url: `https://github.com/littleboylinlin/New_World/releases/download/${tag}/${winName}`,
      size: maxInstallerBytes + 1,
      digest,
    }]), undefined)

    assert.equal(readMacInstaller(tag, [{
      name: macName,
      state: 'uploaded',
      browser_download_url: `https://github.com/littleboylinlin/New_World/releases/download/${tag}/${macName}`,
      size: maxInstallerBytes + 1,
      digest,
    }], 'arm64'), undefined)
  })

  it('rejects installers when HTTP Content-Length mismatches declared asset size without leaving cache files', async () => {
    const winPayload = Buffer.from('fake-windows-installer')
    const macPayload = Buffer.from('fake-mac-installer')
    const winSha = crypto.createHash('sha256').update(winPayload).digest('hex')
    const macSha = crypto.createHash('sha256').update(macPayload).digest('hex')
    const tag = 'v0.99.0'
    const winUrl = `https://github.com/littleboylinlin/New_World/releases/download/${tag}/New-World-Setup-0.99.0-x64.exe`
    const macUrl = `https://github.com/littleboylinlin/New_World/releases/download/${tag}/New-World-0.99.0-macos-arm64.dmg`

    const releaseJson = {
      tag_name: tag,
      draft: false,
      prerelease: false,
      assets: [
        {
          name: 'New-World-Setup-0.99.0-x64.exe',
          state: 'uploaded',
          browser_download_url: winUrl,
          size: winPayload.byteLength,
          digest: `sha256:${winSha}`,
        },
        {
          name: 'New-World-0.99.0-macos-arm64.dmg',
          state: 'uploaded',
          browser_download_url: macUrl,
          size: macPayload.byteLength,
          digest: `sha256:${macSha}`,
        },
      ],
    }

    const fakeNetwork = (payload, declaredLength) => ({
      webRequest: { onBeforeRequest: () => {} },
      fetch: async (url) => {
        if (url.endsWith(`/releases/tags/${tag}`)) {
          return new Response(JSON.stringify(releaseJson), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(payload, {
          status: 200,
          headers: { 'content-length': String(declaredLength) },
        })
      },
    })

    const winCache = makeTempDir()
    const installDir = makeTempDir()
    fs.writeFileSync(path.join(installDir, 'Uninstall New World.exe'), 'uninstaller')
    const winUpdater = createWindowsUpdater({
      network: fakeNetwork(winPayload, winPayload.byteLength + 100),
      cache: winCache,
      installDir,
      version: '0.15.1',
    })
    await assert.rejects(
      winUpdater.download(tag, () => {}),
      (err) => err instanceof UpdateError && err.message === 'windowsUpdate.theInstallerSizeOrSha256ChecksumDoes',
    )
    assert.deepEqual(fs.readdirSync(winCache), [])

    const macCache = makeTempDir()
    const macUpdater = await createMacUpdater({
      network: fakeNetwork(macPayload, macPayload.byteLength + 50),
      version: '0.15.1',
      arch: 'arm64',
      cache: macCache,
    })
    await assert.rejects(
      macUpdater.download(tag, () => {}),
      (err) => err instanceof MacUpdateError && err.message === 'windowsUpdate.theInstallerSizeOrSha256ChecksumDoes',
    )
    assert.deepEqual(fs.readdirSync(macCache), [])
  })
})

describe('desktop/ai-bridge confirmation concurrency & revocation', () => {
  it('prevents duplicate concurrent execution of handleConfirmDecision and re-checks revoked permissions inside queued execution', async () => {
    const dir = makeTempDir()
    const store = createAiStore(dir)
    store.setEnabled(true)
    const client = store.createClient({
      name: 'ConcurrentRaceAI',
      enabled: true,
      permissions: { read: true, create: true, update: true, delete: true },
      scope: { mode: 'all', workIds: [] },
    })

    const prompted = []
    let releaseQueueGate
    const queueGate = new Promise((resolve) => { releaseQueueGate = resolve })
    let confirmedExecCalls = 0
    let queuedWorkExecCalls = 0

    const bridge = createAiBridge({
      store,
      bindPort: 0,
      onPromptConfirmation: (req) => {
        prompted.push(req)
      },
      dispatchOperation: async ({ action, phase }) => {
        if (action === 'works.list') {
          await queueGate
          return { ok: true, statusCode: 200, data: { works: [] } }
        }
        if (phase === 'prepare-delete') {
          return {
            ok: false,
            requiresConfirmation: true,
            confirmedAction: action,
            fingerprint: `fp-${prompted.length}`,
            targetSummary: 'Target Work',
            impact: { kind: 'work', library: 'original', bookId: 'book-1', bookTitle: 'Work 1', summary: 'Delete' },
          }
        }
        if (phase === 'execute-confirmed') {
          if (queuedWorkExecCalls > 0 || confirmedExecCalls > 0) queuedWorkExecCalls++
          confirmedExecCalls++
          return { ok: true, statusCode: 200, data: { deleted: true } }
        }
        return { ok: true, statusCode: 200, data: {} }
      },
    })

    try {
      const { port } = await bridge.sync()
      const auth = { Authorization: `Bearer ${client.token}`, 'Content-Type': 'application/json' }

      // 1. Concurrent double-approval on one confirmation executes at most once
      const req1 = rawHttpRequest({ port, method: 'DELETE', urlPath: '/v1/works/original/book-1?wait=true', headers: auth })
      for (let i = 0; i < 40 && prompted.length < 1; i++) await new Promise((r) => setTimeout(r, 10))
      assert.equal(prompted.length, 1)

      // Hold the serialized queue busy behind a slow read while firing two concurrent approvals
      releaseQueueGate?.()
      const [decA, decB] = await Promise.all([
        bridge.handleConfirmDecision({ confirmationId: prompted[0].confirmationId, approved: true }),
        bridge.handleConfirmDecision({ confirmationId: prompted[0].confirmationId, approved: true }),
      ])
      const winCount = [decA, decB].filter((r) => r.ok === true).length
      assert.equal(winCount, 1)
      assert.equal([decA, decB].some((r) => r.ok === false), true)
      assert.equal(confirmedExecCalls, 1)
      const res1 = await req1
      assert.equal(res1.status, 200)

      // 2. Permission revoked AFTER approval while waiting behind an in-flight serialized operation -> blocked inside queue
      let releaseSecondGate
      const secondGate = new Promise((resolve) => { releaseSecondGate = resolve })
      const bridge2 = createAiBridge({
        store,
        bindPort: 0,
        onPromptConfirmation: (req) => prompted.push(req),
        dispatchOperation: async ({ action, phase }) => {
          if (action === 'stats.get') {
            await secondGate
            return { ok: true, statusCode: 200, data: {} }
          }
          if (phase === 'prepare-delete') {
            return {
              ok: false,
              requiresConfirmation: true,
              confirmedAction: action,
              fingerprint: 'fp-queued',
              targetSummary: 'Work Q',
              impact: { kind: 'work', library: 'original', bookId: 'book-q', bookTitle: 'Work Q', summary: 'Delete Q' },
            }
          }
          if (phase === 'execute-confirmed') {
            queuedWorkExecCalls++
            return { ok: true, statusCode: 200, data: { deleted: true } }
          }
          return { ok: true, statusCode: 200, data: {} }
        },
      })
      const { port: port2 } = await bridge2.sync()
      const execCallsBefore = queuedWorkExecCalls
      try {
        const queuedConfirmHttp = rawHttpRequest({ port: port2, method: 'DELETE', urlPath: '/v1/works/original/book-q?wait=true', headers: auth })
        for (let i = 0; i < 40 && prompted.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
        assert.equal(prompted.length, 2)

        // Occupy serialized queue with stats.get
        const blockerHttp = rawHttpRequest({ port: port2, method: 'GET', urlPath: '/v1/stats', headers: auth })
        await new Promise((r) => setTimeout(r, 25))

        // Approve while queue is occupied, then immediately revoke delete permission before blocker finishes
        const approvePromise = bridge2.handleConfirmDecision({ confirmationId: prompted[1].confirmationId, approved: true })
        store.updateClient(client.client.id, { permissions: { read: true, create: true, update: true, delete: false } })
        releaseSecondGate()

        const [decisionRes, confirmHttpRes, blockerRes] = await Promise.all([approvePromise, queuedConfirmHttp, blockerHttp])
        assert.equal(blockerRes.status, 200)
        assert.equal(decisionRes.ok, false)
        assert.equal(decisionRes.code, 'permission_revoked')
        assert.equal(confirmHttpRes.status, 403)
        assert.equal(confirmHttpRes.body.error.code, 'permission_revoked')
        assert.equal(queuedWorkExecCalls, execCallsBefore)
      } finally {
        await bridge2.stop()
      }
    } finally {
      await bridge.stop()
    }
  })
})
