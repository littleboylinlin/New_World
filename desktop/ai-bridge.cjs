const crypto = require('node:crypto')
const http = require('node:http')

const API_VERSION = 'v1'
const MAX_BODY_BYTES = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000
const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000
const MAX_WAIT_MS = 120_000
const MAX_PENDING_CONFIRMATIONS = 20
const FINISHED_CONFIRM_TTL_MS = 5 * 60_000

const ENDPOINT_CATALOG = [
  'GET /v1/health',
  'GET /v1/capabilities',
  'GET /v1/confirmations/:id',
  'GET /v1/libraries',
  'GET /v1/groups',
  'GET /v1/works',
  'POST /v1/works',
  'GET /v1/works/:library/:bookId',
  'PATCH /v1/works/:library/:bookId',
  'DELETE /v1/works/:library/:bookId',
  'GET /v1/works/:library/:bookId/editions',
  'POST /v1/works/:library/:bookId/editions',
  'GET /v1/works/:library/:bookId/editions/:editionId',
  'DELETE /v1/works/:library/:bookId/editions/:editionId',
  'GET /v1/works/:library/:bookId/editions/:editionId/chapters',
  'POST /v1/works/:library/:bookId/editions/:editionId/chapters',
  'PUT /v1/works/:library/:bookId/editions/:editionId/chapters',
  'PATCH /v1/works/:library/:bookId/editions/:editionId/chapters/reorder',
  'GET /v1/works/:library/:bookId/editions/:editionId/chapters/:chapterId',
  'PUT /v1/works/:library/:bookId/editions/:editionId/chapters/:chapterId',
  'PATCH /v1/works/:library/:bookId/editions/:editionId/chapters/:chapterId',
  'DELETE /v1/works/:library/:bookId/editions/:editionId/chapters/:chapterId',
  'POST /v1/works/reference/:bookId/sources',
  'GET /v1/works/reference/:bookId/sources/:sourceId',
  'DELETE /v1/works/reference/:bookId/sources/:sourceId',
  'GET /v1/search',
  'GET /v1/stats',
  'GET /v1/ideas',
  'POST /v1/ideas',
  'PATCH /v1/ideas/:ideaId',
  'DELETE /v1/ideas/:ideaId',
]

function isLoopbackAddress(remoteAddress) {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
}

function isAllowedHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) return false
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i.test(hostHeader.trim())
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

function writeJson(res, statusCode, payload) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

function errorPayload(code, message, extra = {}) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...extra,
    },
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length'] || 0)
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('Request body too large.'), { statusCode: 413, code: 'payload_too_large' }))
      return
    }
    const chunks = []
    let total = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        done = true
        req.destroy()
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413, code: 'payload_too_large' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('JSON object body required.'), { statusCode: 400, code: 'invalid_json' }))
          return
        }
        resolve(parsed)
      } catch {
        reject(Object.assign(new Error('Malformed JSON body.'), { statusCode: 400, code: 'invalid_json' }))
      }
    })
    req.on('error', (err) => {
      if (done) return
      done = true
      reject(err)
    })
  })
}

function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean).map(decodeSegment)
  if (parts.some((p) => p === null)) {
    return { invalidEncoding: true }
  }
  if (parts[0] !== API_VERSION) return null

  // Reject any API-side self-confirmation attempt unconditionally
  if (parts[1] === 'confirm' || (parts[1] === 'confirmations' && parts.length >= 3 && method !== 'GET')) {
    return { action: 'self_confirm_attempt', permission: null, parts }
  }
  if (parts[1] === 'confirmations' && parts.length === 4 && (parts[3] === 'confirm' || parts[3] === 'approve' || parts[3] === 'accept')) {
    return { action: 'self_confirm_attempt', permission: null, parts }
  }

  // Trash, revision history (chapter & idea), and backup recovery storage are strictly off-limits to AI clients.
  if (
    parts[1] === 'trash'
    || parts[1] === 'revisions'
    || parts[1] === 'revision-blobs'
    || parts[1] === 'idea-revisions'
    || parts[1] === 'history'
    || parts[1] === 'backups'
    || (parts[1] === 'ideas' && ['revisions', 'history'].includes(parts[3]))
    || (parts[1] === 'works' && (
      ['trash', 'revisions', 'history'].includes(parts[4])
      || ['revisions', 'history'].includes(parts[6])
      || ['revisions', 'history'].includes(parts[8])
    ))
  ) {
    return { action: 'recovery_access_forbidden', permission: null, parts }
  }

  if (parts.length === 2 && parts[1] === 'health' && method === 'GET') {
    return { action: 'health', permission: null, public: true }
  }
  if (parts.length === 2 && parts[1] === 'capabilities' && method === 'GET') {
    return { action: 'capabilities', permission: null }
  }
  if (parts.length === 3 && parts[1] === 'confirmations' && method === 'GET') {
    return { action: 'confirmation.get', permission: null, params: { confirmationId: parts[2] } }
  }
  if (parts.length === 2 && (parts[1] === 'libraries' || parts[1] === 'groups') && method === 'GET') {
    return { action: 'libraries.list', permission: 'read' }
  }
  if (parts.length === 2 && parts[1] === 'search' && method === 'GET') {
    return { action: 'search', permission: 'read' }
  }
  if (parts.length === 2 && parts[1] === 'stats' && method === 'GET') {
    return { action: 'stats.get', permission: 'read' }
  }
  if (parts.length === 2 && parts[1] === 'ideas') {
    if (method === 'GET') return { action: 'ideas.list', permission: 'read' }
    if (method === 'POST') return { action: 'ideas.create', permission: 'create' }
  }
  if (parts.length === 3 && parts[1] === 'ideas') {
    if (method === 'PATCH') return { action: 'ideas.update', permission: 'update', params: { ideaId: parts[2] } }
    if (method === 'DELETE') return { action: 'ideas.delete', permission: 'delete', requiresConfirmation: true, params: { ideaId: parts[2] } }
  }
  if (parts.length === 2 && parts[1] === 'works') {
    if (method === 'GET') return { action: 'works.list', permission: 'read' }
    if (method === 'POST') return { action: 'works.create', permission: 'create' }
  }
  if (parts.length === 4 && parts[1] === 'works') {
    const params = { library: parts[2], bookId: parts[3] }
    if (method === 'GET') return { action: 'works.get', permission: 'read', params }
    if (method === 'PATCH') return { action: 'works.update', permission: 'update', params }
    if (method === 'DELETE') return { action: 'works.delete', permission: 'delete', requiresConfirmation: true, params }
  }
  if (parts.length === 5 && parts[1] === 'works' && parts[4] === 'sources' && method === 'POST') {
    return { action: 'sources.create', permission: 'create', params: { library: parts[2], bookId: parts[3] } }
  }
  if (parts.length === 6 && parts[1] === 'works' && parts[4] === 'sources') {
    const params = { library: parts[2], bookId: parts[3], sourceId: parts[5] }
    if (method === 'GET') return { action: 'sources.get', permission: 'read', params }
    if (method === 'DELETE') return { action: 'sources.delete', permission: 'delete', requiresConfirmation: true, params }
  }
  if (parts.length === 5 && parts[1] === 'works' && parts[4] === 'editions') {
    const params = { library: parts[2], bookId: parts[3] }
    if (method === 'GET') return { action: 'editions.list', permission: 'read', params }
    if (method === 'POST') return { action: 'editions.create', permission: 'create', params }
  }
  if (parts.length === 6 && parts[1] === 'works' && parts[4] === 'editions') {
    const params = { library: parts[2], bookId: parts[3], editionId: parts[5] }
    if (method === 'GET') return { action: 'editions.get', permission: 'read', params }
    if (method === 'DELETE') return { action: 'editions.delete', permission: 'delete', requiresConfirmation: true, params }
  }
  if (parts.length === 7 && parts[1] === 'works' && parts[4] === 'editions' && parts[6] === 'chapters') {
    const params = { library: parts[2], bookId: parts[3], editionId: parts[5] }
    if (method === 'GET') return { action: 'chapters.list', permission: 'read', params }
    if (method === 'POST') return { action: 'chapters.create', permission: 'create', params }
    if (method === 'PUT') return { action: 'chapters.replaceBatch', permission: 'update', params }
  }
  if (parts.length === 8 && parts[1] === 'works' && parts[4] === 'editions' && parts[6] === 'chapters' && parts[7] === 'reorder' && method === 'PATCH') {
    return { action: 'chapters.reorder', permission: 'update', params: { library: parts[2], bookId: parts[3], editionId: parts[5] } }
  }
  if (parts.length === 8 && parts[1] === 'works' && parts[4] === 'editions' && parts[6] === 'chapters') {
    const params = { library: parts[2], bookId: parts[3], editionId: parts[5], chapterId: parts[7] }
    if (method === 'GET') return { action: 'chapters.get', permission: 'read', params }
    if (method === 'PUT' || method === 'PATCH') return { action: 'chapters.update', permission: 'update', params }
    if (method === 'DELETE') return { action: 'chapters.delete', permission: 'delete', requiresConfirmation: true, params }
  }
  return null
}

function createAiBridge({
  store,
  dispatchOperation,
  onPromptConfirmation = () => {},
  onCloseConfirmation = () => {},
  onAttentionNeeded = () => {},
  confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
  bindPort = null,
}) {
  let server = null
  let listeningPort = null
  let lastError = null
  const pendingConfirmations = new Map()
  const finishedConfirmations = new Map()
  const operationQueue = []
  let processingQueue = false

  function getStatus() {
    const config = store.getPublicState()
    return {
      running: Boolean(server && server.listening),
      enabled: config.enabled,
      host: '127.0.0.1',
      configuredPort: config.port,
      port: listeningPort ?? config.port,
      error: lastError,
      pendingConfirmations: pendingConfirmations.size,
    }
  }

  function pruneFinishedConfirmations() {
    const cutoff = Date.now() - FINISHED_CONFIRM_TTL_MS
    for (const [id, item] of finishedConfirmations.entries()) {
      if ((item.settledAt ?? item.expiresAt ?? 0) < cutoff) {
        finishedConfirmations.delete(id)
      }
    }
  }

  function resolveWaiters(entry, statusCode, payload) {
    if (!entry || !entry.waiters) return
    const waiters = entry.waiters.splice(0)
    for (const resolve of waiters) {
      resolve({ statusCode, payload })
    }
  }

  function finalizeConfirmation(id, status, extra = {}) {
    const entry = pendingConfirmations.get(id)
    if (!entry) return null
    clearTimeout(entry.timer)
    pendingConfirmations.delete(id)
    const finished = {
      confirmationId: entry.confirmationId,
      clientId: entry.clientId,
      clientName: entry.clientName,
      action: entry.action,
      status,
      expiresAt: entry.expiresAt,
      settledAt: Date.now(),
      impact: entry.impact,
      result: extra.result ?? null,
      error: extra.error ?? null,
    }
    pruneFinishedConfirmations()
    finishedConfirmations.set(id, finished)
    return { entry, finished }
  }

  function cancelAllPending(reason = 'bridge_stopped') {
    for (const [id, entry] of Array.from(pendingConfirmations.entries())) {
      if (entry.status !== 'pending') continue
      const done = finalizeConfirmation(id, 'rejected', {
        error: { code: reason, message: 'Pending confirmation cancelled because AI bridge stopped or client changed.' },
      })
      if (done) {
        try {
          onCloseConfirmation({ confirmationId: id, reason })
        } catch {
          // ignore UI close callback failure during teardown
        }
        resolveWaiters(done.entry, 403, errorPayload(reason, 'Confirmation cancelled.'))
      }
    }
  }

  function cancelClientPending(clientId, reason = 'client_revoked') {
    for (const [id, entry] of Array.from(pendingConfirmations.entries())) {
      if (entry.clientId !== clientId || entry.status !== 'pending') continue
      const done = finalizeConfirmation(id, 'rejected', {
        error: { code: reason, message: 'Pending confirmation cancelled because AI client was disabled, updated, or deleted.' },
      })
      if (done) {
        try {
          onCloseConfirmation({ confirmationId: id, reason })
        } catch {
          // ignore UI close callback failure during teardown
        }
        resolveWaiters(done.entry, 403, errorPayload(reason, 'Confirmation cancelled.'))
      }
    }
  }

  function serializeOperation(fn) {
    return new Promise((resolve, reject) => {
      operationQueue.push({ fn, resolve, reject })
      if (processingQueue) return
      void drainQueue()
    })
  }

  async function drainQueue() {
    processingQueue = true
    while (operationQueue.length) {
      const item = operationQueue.shift()
      try {
        item.resolve(await item.fn())
      } catch (err) {
        item.reject(err)
      }
    }
    processingQueue = false
  }

  function formatAudit(client, req, action, outcome, statusCode, extra = {}) {
    store.appendAudit({
      clientId: client?.id ?? null,
      clientName: client?.name ?? null,
      method: req.method || '',
      path: req.url ? req.url.split('?')[0] : '',
      action,
      outcome,
      statusCode,
      targetSummary: extra.targetSummary || '',
      confirmId: extra.confirmId || null,
      reason: extra.reason || '',
    })
  }

  async function createConfirmationGate({ client, req, route, query, body, prepared }) {
    if (pendingConfirmations.size >= MAX_PENDING_CONFIRMATIONS) {
      return {
        statusCode: 429,
        payload: errorPayload('too_many_pending_confirmations', 'Too many pending confirmations awaiting user decision.'),
        outcome: 'denied',
      }
    }

    const latestClient = store.getClientById(client.id)
    if (!store.getPublicState().enabled || !latestClient || !latestClient.enabled || !latestClient.permissions.delete) {
      return {
        statusCode: 403,
        payload: errorPayload('forbidden_delete_permission', 'Delete permission or AI access was revoked.'),
        outcome: 'denied',
      }
    }

    const confirmationId = crypto.randomUUID()
    const approvalGrant = crypto.randomUUID()
    const expiresAt = Date.now() + confirmTimeoutMs
    const entry = {
      confirmationId,
      approvalGrant,
      clientId: client.id,
      clientName: client.name,
      action: prepared.confirmedAction || route.action,
      params: route.params || {},
      query,
      body,
      fingerprint: prepared.fingerprint,
      targetSummary: prepared.targetSummary || '',
      impact: prepared.impact,
      status: 'pending',
      expiresAt,
      waiters: [],
      timer: null,
    }

    entry.timer = setTimeout(() => {
      const done = finalizeConfirmation(confirmationId, 'timed_out', {
        error: { code: 'confirmation_timed_out', message: 'Confirmation timed out without user approval.' },
      })
      if (!done) return
      try {
        onCloseConfirmation({ confirmationId, reason: 'timed_out' })
      } catch {
        // ignore callback error
      }
      store.appendAudit({
        clientId: client.id,
        clientName: client.name,
        method: req.method || '',
        path: req.url ? req.url.split('?')[0] : '',
        action: entry.action,
        outcome: 'timed_out',
        statusCode: 408,
        targetSummary: entry.targetSummary,
        confirmId: confirmationId,
        reason: 'timed_out',
      })
      resolveWaiters(
        done.entry,
        408,
        errorPayload('confirmation_timed_out', 'Delete or destructive update confirmation timed out; nothing was changed.', {
          confirmationId,
        }),
      )
    }, confirmTimeoutMs)

    pendingConfirmations.set(confirmationId, entry)

    formatAudit(client, req, entry.action, 'pending_confirmation', 202, {
      targetSummary: entry.targetSummary,
      confirmId: confirmationId,
    })

    try {
      onAttentionNeeded()
      onPromptConfirmation({
        confirmationId,
        clientId: entry.clientId,
        clientName: entry.clientName,
        action: entry.action,
        impact: entry.impact,
        expiresAt,
      })
    } catch {
      const done = finalizeConfirmation(confirmationId, 'failed', {
        error: { code: 'confirmation_ui_unavailable', message: 'Unable to open confirmation dialog in New_World UI.' },
      })
      if (done) {
        resolveWaiters(done.entry, 503, errorPayload('confirmation_ui_unavailable', 'Unable to open confirmation dialog.'))
      }
      return {
        statusCode: 503,
        payload: errorPayload('confirmation_ui_unavailable', 'Unable to open confirmation dialog in New_World UI.'),
        outcome: 'error',
      }
    }

    const wantsWait = query.wait === 'true' || query.wait === '1'
    if (wantsWait) {
      const result = await new Promise((resolve) => {
        entry.waiters.push(resolve)
      })
      return { ...result, alreadyAudited: true }
    }

    return {
      alreadyAudited: true,
      statusCode: 202,
      payload: {
        ok: false,
        status: 'pending_confirmation',
        confirmationId,
        expiresAt,
        impact: entry.impact,
        pollUrl: `/v1/confirmations/${confirmationId}`,
        message: 'Human confirmation required in the New_World window before this operation can execute.',
      },
    }
  }

  async function handleConfirmDecision({ confirmationId, approved }) {
    if (typeof confirmationId !== 'string' || !confirmationId) {
      return { ok: false, status: 'not_found' }
    }
    const entry = pendingConfirmations.get(confirmationId)
    if (!entry) {
      const finished = finishedConfirmations.get(confirmationId)
      return { ok: false, status: finished?.status ?? 'not_found' }
    }

    if (Date.now() > entry.expiresAt) {
      const done = finalizeConfirmation(confirmationId, 'timed_out', {
        error: { code: 'confirmation_timed_out', message: 'Confirmation expired before decision.' },
      })
      if (done) {
        resolveWaiters(done.entry, 408, errorPayload('confirmation_timed_out', 'Confirmation expired before decision.', { confirmationId }))
      }
      return { ok: false, status: 'timed_out' }
    }

    if (approved !== true) {
      const done = finalizeConfirmation(confirmationId, 'rejected', {
        error: { code: 'confirmation_rejected', message: 'User rejected the confirmation request.' },
      })
      store.appendAudit({
        clientId: entry.clientId,
        clientName: entry.clientName,
        method: 'UI',
        path: 'confirm-dialog',
        action: entry.action,
        outcome: 'rejected',
        statusCode: 403,
        targetSummary: entry.targetSummary,
        confirmId: confirmationId,
        reason: 'user_rejected',
      })
      if (done) {
        resolveWaiters(done.entry, 403, errorPayload('confirmation_rejected', 'User rejected the operation.', { confirmationId }))
      }
      return { ok: true, status: 'rejected' }
    }

    // Re-verify global enablement, client enablement, delete permission, and work scope at exact approval moment.
    const globalState = store.getPublicState()
    const currentClient = store.getClientById(entry.clientId)
    const targetBookId = entry.params?.bookId || entry.impact?.bookId
    const scopeInvalid = !currentClient || currentClient.scope?.mode === 'none' || (
      targetBookId
      && currentClient.scope?.mode === 'selected'
      && !(Array.isArray(currentClient.scope.workIds) && currentClient.scope.workIds.includes(targetBookId))
    )
    if (!globalState.enabled || !currentClient || !currentClient.enabled || !currentClient.permissions.delete || scopeInvalid) {
      const reason = scopeInvalid && currentClient?.enabled && currentClient?.permissions?.delete ? 'scope_revoked' : 'permission_revoked'
      const done = finalizeConfirmation(confirmationId, 'rejected', {
        error: { code: reason, message: 'AI access, permission, or work scope was revoked before execution.' },
      })
      store.appendAudit({
        clientId: entry.clientId,
        clientName: entry.clientName,
        method: 'UI',
        path: 'confirm-dialog',
        action: entry.action,
        outcome: 'denied',
        statusCode: 403,
        targetSummary: entry.targetSummary,
        confirmId: confirmationId,
        reason,
      })
      if (done) {
        resolveWaiters(done.entry, 403, errorPayload(reason, 'Permission or scope was revoked before execution.', { confirmationId }))
      }
      return { ok: false, status: 'rejected', code: reason }
    }

    if (entry.status !== 'pending') {
      return { ok: false, status: entry.status }
    }
    entry.status = 'executing'
    clearTimeout(entry.timer)

    try {
      const execution = await serializeOperation(() =>
        dispatchOperation({
          phase: 'execute-confirmed',
          confirmationId: entry.confirmationId,
          approvalGrant: entry.approvalGrant,
          expectedFingerprint: entry.fingerprint,
          client: currentClient,
          action: entry.action,
          params: entry.params,
          query: entry.query,
          body: entry.body,
        }),
      )

      if (!execution || !execution.ok) {
        const errCode = execution?.code || 'execution_failed'
        const errMessage = execution?.message || 'Confirmed operation failed during execution.'
        const statusCode = execution?.statusCode || 409
        const done = finalizeConfirmation(confirmationId, 'failed', {
          error: { code: errCode, message: errMessage },
        })
        store.appendAudit({
          clientId: currentClient.id,
          clientName: currentClient.name,
          method: 'UI',
          path: 'confirm-dialog',
          action: entry.action,
          outcome: 'error',
          statusCode,
          targetSummary: execution?.targetSummary || entry.targetSummary,
          confirmId: confirmationId,
          reason: execution?.auditReason || errCode,
        })
        if (done) {
          resolveWaiters(done.entry, statusCode, errorPayload(errCode, errMessage, { confirmationId }))
        }
        return { ok: false, status: 'failed', code: errCode, message: errMessage }
      }

      const done = finalizeConfirmation(confirmationId, 'completed', {
        result: execution.data ?? null,
      })
      store.appendAudit({
        clientId: currentClient.id,
        clientName: currentClient.name,
        method: 'UI',
        path: 'confirm-dialog',
        action: entry.action,
        outcome: 'confirmed',
        statusCode: 200,
        targetSummary: execution.targetSummary || entry.targetSummary,
        confirmId: confirmationId,
        reason: execution.auditReason || '',
      })
      if (done) {
        resolveWaiters(done.entry, 200, {
          ok: true,
          status: 'completed',
          confirmationId,
          data: execution.data ?? null,
        })
      }
      return { ok: true, status: 'completed', data: execution.data ?? null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const done = finalizeConfirmation(confirmationId, 'failed', {
        error: { code: 'execution_error', message },
      })
      store.appendAudit({
        clientId: currentClient.id,
        clientName: currentClient.name,
        method: 'UI',
        path: 'confirm-dialog',
        action: entry.action,
        outcome: 'error',
        statusCode: 500,
        targetSummary: entry.targetSummary,
        confirmId: confirmationId,
        reason: message,
      })
      if (done) {
        resolveWaiters(done.entry, 500, errorPayload('execution_error', message, { confirmationId }))
      }
      return { ok: false, status: 'failed', code: 'execution_error', message }
    }
  }

  async function handleRequest(req, res) {
    req.setTimeout(MAX_WAIT_MS + 10_000)
    res.setTimeout(MAX_WAIT_MS + 10_000)

    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      writeJson(res, 403, errorPayload('non_loopback_forbidden', 'Only loopback connections are allowed.'))
      return
    }
    if (!isAllowedHostHeader(req.headers.host)) {
      writeJson(res, 403, errorPayload('invalid_host_header', 'Untrusted Host header rejected.'))
      return
    }
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
      writeJson(res, 403, errorPayload('browser_origin_forbidden', 'Cross-origin or browser-origin requests are not allowed.'))
      return
    }

    let urlObj
    try {
      urlObj = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      writeJson(res, 400, errorPayload('invalid_url', 'Invalid request URL.'))
      return
    }

    const route = matchRoute(req.method || 'GET', urlObj.pathname)
    if (route?.invalidEncoding) {
      writeJson(res, 400, errorPayload('invalid_url_encoding', 'Malformed URL path encoding.'))
      return
    }
    if (!route) {
      writeJson(res, 404, errorPayload('not_found', `Unknown endpoint: ${req.method} ${urlObj.pathname}`))
      return
    }
    if (route.public) {
      writeJson(res, 200, {
        ok: true,
        service: 'new-world-ai',
        apiVersion: API_VERSION,
        confirmationRequiredForDelete: true,
      })
      return
    }

    if (!store.getPublicState().enabled) {
      writeJson(res, 503, errorPayload('ai_disabled', 'AI integration is disabled in New_World settings.'))
      return
    }

    const authHeader = req.headers.authorization
    const match = typeof authHeader === 'string' ? /^Bearer\s+(\S+)$/i.exec(authHeader.trim()) : null
    if (!match) {
      formatAudit(null, req, route.action, 'denied', 401, { reason: 'missing_bearer_token' })
      writeJson(res, 401, errorPayload('unauthorized', 'Valid Bearer token is required.'))
      return
    }

    const client = store.verifyToken(match[1])
    if (!client) {
      formatAudit(null, req, route.action, 'denied', 401, { reason: 'invalid_token' })
      writeJson(res, 401, errorPayload('unauthorized', 'Invalid AI access token.'))
      return
    }

    if (route.action === 'self_confirm_attempt') {
      formatAudit(client, req, route.action, 'denied', 403, { reason: 'api_confirmation_forbidden' })
      writeJson(
        res,
        403,
        errorPayload(
          'api_confirmation_forbidden',
          'Human confirmation in the New_World native dialog is mandatory; AI cannot approve its own confirmation via API.',
        ),
      )
      return
    }

    if (route.action === 'recovery_access_forbidden') {
      formatAudit(client, req, route.action, 'denied', 403, { reason: 'recovery_data_forbidden' })
      writeJson(
        res,
        403,
        errorPayload(
          'recovery_data_forbidden',
          'Trash, revision history, and backup recovery storage are isolated from the AI API and can only be managed in the New_World window.',
        ),
      )
      return
    }

    if (!client.enabled) {
      formatAudit(client, req, route.action, 'denied', 403, { reason: 'client_disabled' })
      writeJson(res, 403, errorPayload('client_disabled', 'This AI client configuration is currently disabled.'))
      return
    }

    if (route.permission && client.permissions[route.permission] !== true) {
      formatAudit(client, req, route.action, 'denied', 403, { reason: `missing_${route.permission}_permission` })
      writeJson(
        res,
        403,
        errorPayload('permission_denied', `AI client "${client.name}" does not have "${route.permission}" permission.`),
      )
      return
    }

    store.touchClientUsage(client.id)

    if (route.action === 'capabilities') {
      formatAudit(client, req, route.action, 'allowed', 200)
      writeJson(res, 200, {
        ok: true,
        apiVersion: API_VERSION,
        data: {
          apiVersion: API_VERSION,
          client: {
            id: client.id,
            name: client.name,
            enabled: client.enabled,
            permissions: { ...client.permissions },
            scope: {
              mode: client.scope.mode,
              workIds: [...client.scope.workIds],
            },
          },
          rules: {
            humanConfirmationRequiredForDelete: true,
            destructiveUpdateGuardActive: true,
            localOnly: true,
          },
          endpoints: ENDPOINT_CATALOG,
        },
      })
      return
    }

    if (route.action === 'confirmation.get') {
      const id = route.params.confirmationId
      const pending = pendingConfirmations.get(id)
      const record = pending || finishedConfirmations.get(id)
      if (!record || record.clientId !== client.id) {
        formatAudit(client, req, route.action, 'denied', 404, { confirmId: id, reason: 'confirmation_not_found' })
        writeJson(res, 404, errorPayload('confirmation_not_found', 'Confirmation request not found for this AI client.'))
        return
      }
      if (pending && Date.now() > pending.expiresAt) {
        const done = finalizeConfirmation(id, 'timed_out', {
          error: { code: 'confirmation_timed_out', message: 'Confirmation timed out without user approval.' },
        })
        if (done) {
          try {
            onCloseConfirmation({ confirmationId: id, reason: 'timed_out' })
          } catch {
            // ignore
          }
          writeJson(res, 200, { ok: true, data: done.finished })
          return
        }
      }
      writeJson(res, 200, {
        ok: true,
        data: {
          confirmationId: record.confirmationId,
          action: record.action,
          status: record.status,
          expiresAt: record.expiresAt,
          impact: record.impact,
          result: record.result ?? null,
          error: record.error ?? null,
        },
      })
      return
    }

    let body = {}
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
      try {
        body = await parseBody(req)
      } catch (err) {
        const statusCode = err?.statusCode || 400
        const code = err?.code || 'invalid_body'
        formatAudit(client, req, route.action, 'error', statusCode, { reason: code })
        writeJson(res, statusCode, errorPayload(code, err?.message || 'Invalid JSON body.'))
        return
      }
    }

    const query = Object.fromEntries(urlObj.searchParams.entries())

    if (
      body.skipHistory === true
      || body.preserveHistory === false
      || query.skipHistory === 'true'
      || query.skipHistory === '1'
      || query.preserveHistory === 'false'
      || query.preserveHistory === '0'
    ) {
      formatAudit(client, req, route.action, 'denied', 403, { reason: 'history_protection_non_bypassable' })
      writeJson(
        res,
        403,
        errorPayload(
          'history_protection_non_bypassable',
          'Automatic pre-edit revision history protection cannot be skipped or disabled.',
        ),
      )
      return
    }

    try {
      const result = await serializeOperation(() =>
        dispatchOperation({
          phase: route.requiresConfirmation ? 'prepare-delete' : 'execute',
          client,
          action: route.action,
          params: route.params || {},
          query,
          body,
        }),
      )

      if (!result) {
        formatAudit(client, req, route.action, 'error', 503, { reason: 'empty_dispatcher_response' })
        writeJson(res, 503, errorPayload('renderer_unavailable', 'New_World application window is not ready.'))
        return
      }

      if (result.requiresConfirmation) {
        const gated = await createConfirmationGate({
          client,
          req,
          route,
          query,
          body,
          prepared: result,
        })
        if (!gated.alreadyAudited) {
          formatAudit(client, req, route.action, gated.outcome || 'denied', gated.statusCode, {
            targetSummary: result.targetSummary || '',
          })
        }
        writeJson(res, gated.statusCode, gated.payload)
        return
      }

      if (!result.ok) {
        const statusCode = result.statusCode || 400
        const outcome = statusCode === 403 || statusCode === 401 ? 'denied' : statusCode === 409 ? 'conflict' : 'error'
        formatAudit(client, req, route.action, outcome, statusCode, {
          targetSummary: result.targetSummary || '',
          reason: result.auditReason || result.code || 'request_failed',
        })
        writeJson(res, statusCode, errorPayload(result.code || 'request_failed', result.message || 'Operation rejected.', result.details))
        return
      }

      formatAudit(client, req, route.action, 'allowed', result.statusCode || 200, {
        targetSummary: result.targetSummary || '',
        reason: result.auditReason || '',
      })
      writeJson(res, result.statusCode || 200, {
        ok: true,
        data: result.data ?? null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      formatAudit(client, req, route.action, 'error', 500, { reason: message })
      writeJson(res, 500, errorPayload('internal_error', message))
    }
  }

  async function sync() {
    const config = store.getPublicState()
    const targetPort = bindPort !== null ? bindPort : config.port
    if (!config.enabled) {
      await stop()
      return getStatus()
    }
    if (server && server.listening && (bindPort !== null || listeningPort === targetPort)) {
      return getStatus()
    }
    await stop()
    return start(targetPort)
  }

  function start(targetPort) {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        void handleRequest(req, res)
      })
      srv.requestTimeout = REQUEST_TIMEOUT_MS + MAX_WAIT_MS
      srv.on('error', (error) => {
        lastError = error.message
        if (server === srv && !srv.listening) {
          server = null
          listeningPort = null
        }
        resolve(getStatus())
      })
      srv.listen(targetPort, '127.0.0.1', () => {
        server = srv
        const addr = srv.address()
        listeningPort = typeof addr === 'object' && addr ? addr.port : targetPort
        lastError = null
        resolve(getStatus())
      })
    })
  }

  function stop() {
    cancelAllPending('bridge_stopped')
    if (!server) {
      listeningPort = null
      return Promise.resolve(getStatus())
    }
    const closing = server
    server = null
    listeningPort = null
    return new Promise((resolve) => {
      if (typeof closing.closeAllConnections === 'function') {
        closing.closeAllConnections()
      }
      closing.close(() => {
        resolve(getStatus())
      })
    })
  }

  return {
    getStatus,
    sync,
    stop,
    cancelClientPending,
    handleConfirmDecision,
    // Exposed for tests & verification
    _getPendingCount: () => pendingConfirmations.size,
  }
}

module.exports = {
  API_VERSION,
  ENDPOINT_CATALOG,
  createAiBridge,
  isAllowedHostHeader,
  isLoopbackAddress,
  matchRoute,
}
