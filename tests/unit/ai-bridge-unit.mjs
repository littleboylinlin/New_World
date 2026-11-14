import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

const require = createRequire(import.meta.url)
const { createAiStore } = require('../../desktop/ai-store.cjs')
const { createAiBridge } = require('../../desktop/ai-bridge.cjs')

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
})
