const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const CONFIG_VERSION = 1
const DEFAULT_PORT = 47831
const MAX_CLIENTS = 32
const MAX_WORK_IDS = 500
const MAX_AUDIT_LINES = 2000
const KEEP_AUDIT_LINES = 1000
const ALL_PERMISSIONS = ['create', 'read', 'update', 'delete']

function defaultPermissions() {
  return { create: false, read: false, update: false, delete: false }
}

function defaultScope() {
  return { mode: 'none', workIds: [] }
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    enabled: false,
    port: DEFAULT_PORT,
    clients: [],
  }
}

function sanitizePort(value) {
  const num = Number(value)
  if (!Number.isInteger(num) || num < 1024 || num > 65535) return null
  return num
}

function sanitizeName(value, fallback = 'AI Client') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().slice(0, 64)
  return trimmed || fallback
}

function sanitizePermissions(raw) {
  const perms = defaultPermissions()
  if (!raw || typeof raw !== 'object') return perms
  for (const key of ALL_PERMISSIONS) {
    perms[key] = raw[key] === true
  }
  return perms
}

function sanitizeWorkIds(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || trimmed.length > 128) continue
    seen.add(trimmed)
    if (seen.size >= MAX_WORK_IDS) break
  }
  return Array.from(seen)
}

function sanitizeScope(raw) {
  if (!raw || typeof raw !== 'object') return defaultScope()
  const mode = raw.mode === 'selected' || raw.mode === 'all' ? raw.mode : 'none'
  return {
    mode,
    workIds: mode === 'selected' ? sanitizeWorkIds(raw.workIds) : [],
  }
}

function isValidHexSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function sanitizeClientRecord(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 128) return null
  if (!isValidHexSha256(raw.tokenHash)) return null
  const createdAt = Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now()
  const updatedAt = Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : createdAt
  const lastUsedAt = Number.isFinite(raw.lastUsedAt) ? Number(raw.lastUsedAt) : null
  const tokenPrefix = typeof raw.tokenPrefix === 'string' ? raw.tokenPrefix.slice(0, 24) : 'nw_ai_'
  return {
    id: raw.id.trim(),
    name: sanitizeName(raw.name),
    enabled: raw.enabled === true,
    tokenHash: raw.tokenHash.toLowerCase(),
    tokenPrefix,
    permissions: sanitizePermissions(raw.permissions),
    scope: sanitizeScope(raw.scope),
    createdAt,
    updatedAt,
    lastUsedAt,
  }
}

function sanitizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return defaultConfig()
  const port = sanitizePort(raw.port) ?? DEFAULT_PORT
  const clients = []
  const seenIds = new Set()
  if (Array.isArray(raw.clients)) {
    for (const entry of raw.clients) {
      const clean = sanitizeClientRecord(entry)
      if (!clean || seenIds.has(clean.id)) continue
      seenIds.add(clean.id)
      clients.push(clean)
      if (clients.length >= MAX_CLIENTS) break
    }
  }
  return {
    version: CONFIG_VERSION,
    enabled: raw.enabled === true,
    port,
    clients,
  }
}

function toPublicClient(client) {
  return {
    id: client.id,
    name: client.name,
    enabled: client.enabled,
    tokenPrefix: client.tokenPrefix,
    permissions: { ...client.permissions },
    scope: {
      mode: client.scope.mode,
      workIds: [...client.scope.workIds],
    },
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    lastUsedAt: client.lastUsedAt,
  }
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

function generateToken() {
  const token = `nw_ai_${crypto.randomBytes(24).toString('base64url')}`
  return {
    token,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 14),
  }
}

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, `.tmp-${process.pid}-${crypto.randomUUID()}`)
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temp, filePath)
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true })
  }
}

function createAiStore(baseDir) {
  const configPath = path.join(baseDir, 'NewWorld-ai.json')
  const auditPath = path.join(baseDir, 'NewWorld-ai-audit.jsonl')

  let state = load()

  function load() {
    try {
      const text = fs.readFileSync(configPath, 'utf8')
      return sanitizeConfig(JSON.parse(text))
    } catch {
      return defaultConfig()
    }
  }

  function save(next) {
    state = sanitizeConfig(next)
    writeAtomic(configPath, JSON.stringify(state, null, 2))
    return getPublicState()
  }

  function reload() {
    state = load()
    return getPublicState()
  }

  function getPublicState() {
    return {
      version: state.version,
      enabled: state.enabled,
      port: state.port,
      clients: state.clients.map(toPublicClient),
    }
  }

  function setEnabled(enabled) {
    return save({ ...state, enabled: enabled === true })
  }

  function setPort(port) {
    const cleanPort = sanitizePort(port)
    if (cleanPort === null) {
      throw new Error('Invalid AI bridge port; expected integer 1024-65535.')
    }
    return save({ ...state, port: cleanPort })
  }

  function createClient(input = {}) {
    if (state.clients.length >= MAX_CLIENTS) {
      throw new Error(`Maximum number of AI clients (${MAX_CLIENTS}) reached.`)
    }
    const now = Date.now()
    const generated = generateToken()
    const client = sanitizeClientRecord({
      id: crypto.randomUUID(),
      name: sanitizeName(input.name),
      enabled: input.enabled === true,
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix,
      permissions: sanitizePermissions(input.permissions),
      scope: sanitizeScope(input.scope),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    })
    const nextState = save({
      ...state,
      clients: [...state.clients, client],
    })
    return {
      state: nextState,
      client: toPublicClient(client),
      token: generated.token,
    }
  }

  function updateClient(clientId, patch = {}) {
    const index = state.clients.findIndex((item) => item.id === clientId)
    if (index < 0) {
      throw new Error('AI client not found.')
    }
    const current = state.clients[index]
    const next = {
      ...current,
      name: patch.name !== undefined ? sanitizeName(patch.name, current.name) : current.name,
      enabled: patch.enabled !== undefined ? patch.enabled === true : current.enabled,
      permissions: patch.permissions !== undefined
        ? sanitizePermissions(patch.permissions)
        : current.permissions,
      scope: patch.scope !== undefined ? sanitizeScope(patch.scope) : current.scope,
      updatedAt: Date.now(),
    }
    const clients = [...state.clients]
    clients[index] = next
    const nextState = save({ ...state, clients })
    return {
      state: nextState,
      client: toPublicClient(next),
    }
  }

  function rotateClientToken(clientId) {
    const index = state.clients.findIndex((item) => item.id === clientId)
    if (index < 0) {
      throw new Error('AI client not found.')
    }
    const current = state.clients[index]
    const generated = generateToken()
    const next = {
      ...current,
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix,
      updatedAt: Date.now(),
    }
    const clients = [...state.clients]
    clients[index] = next
    const nextState = save({ ...state, clients })
    return {
      state: nextState,
      client: toPublicClient(next),
      token: generated.token,
    }
  }

  function deleteClient(clientId) {
    const nextClients = state.clients.filter((item) => item.id !== clientId)
    return save({ ...state, clients: nextClients })
  }

  function getClientById(clientId) {
    const found = state.clients.find((item) => item.id === clientId)
    return found ? toPublicClient(found) : null
  }

  function verifyToken(rawToken) {
    if (typeof rawToken !== 'string' || !rawToken.startsWith('nw_ai_') || rawToken.length < 20 || rawToken.length > 256) {
      return null
    }
    const incoming = Buffer.from(hashToken(rawToken), 'hex')
    let matched = null
    for (const client of state.clients) {
      const candidate = Buffer.from(client.tokenHash, 'hex')
      if (candidate.length === incoming.length && crypto.timingSafeEqual(incoming, candidate)) {
        matched = client
      }
    }
    return matched ? toPublicClient(matched) : null
  }

  function touchClientUsage(clientId) {
    const index = state.clients.findIndex((item) => item.id === clientId)
    if (index < 0) return
    const clients = [...state.clients]
    clients[index] = { ...clients[index], lastUsedAt: Date.now() }
    save({ ...state, clients })
  }

  function appendAudit(entry) {
    const cleanEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      clientId: typeof entry.clientId === 'string' ? entry.clientId : null,
      clientName: typeof entry.clientName === 'string' ? entry.clientName : null,
      method: typeof entry.method === 'string' ? entry.method : '',
      path: typeof entry.path === 'string' ? entry.path : '',
      action: typeof entry.action === 'string' ? entry.action : '',
      outcome: typeof entry.outcome === 'string' ? entry.outcome : 'error',
      statusCode: Number.isInteger(entry.statusCode) ? entry.statusCode : 0,
      targetSummary: typeof entry.targetSummary === 'string' ? entry.targetSummary.slice(0, 240) : '',
      confirmId: typeof entry.confirmId === 'string' ? entry.confirmId : null,
      reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 240) : '',
    }
    try {
      fs.mkdirSync(path.dirname(auditPath), { recursive: true })
      fs.appendFileSync(auditPath, `${JSON.stringify(cleanEntry)}\n`, { encoding: 'utf8', mode: 0o600 })
      const lines = fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean)
      if (lines.length > MAX_AUDIT_LINES) {
        writeAtomic(auditPath, `${lines.slice(-KEEP_AUDIT_LINES).join('\n')}\n`)
      }
    } catch {
      // Never crash caller on audit disk error
    }
    return cleanEntry
  }

  function listAudit(limit = 100) {
    const capped = Math.max(1, Math.min(500, Number(limit) || 100))
    try {
      const lines = fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean)
      const recent = lines.slice(-capped).reverse()
      const parsed = []
      for (const line of recent) {
        try {
          parsed.push(JSON.parse(line))
        } catch {
          // ignore malformed line
        }
      }
      return parsed
    } catch {
      return []
    }
  }

  function clearAudit() {
    if (fs.existsSync(auditPath)) {
      fs.rmSync(auditPath, { force: true })
    }
    return []
  }

  return {
    configPath,
    auditPath,
    reload,
    getPublicState,
    setEnabled,
    setPort,
    createClient,
    updateClient,
    rotateClientToken,
    deleteClient,
    getClientById,
    verifyToken,
    touchClientUsage,
    appendAudit,
    listAudit,
    clearAudit,
  }
}

module.exports = {
  ALL_PERMISSIONS,
  CONFIG_VERSION,
  DEFAULT_PORT,
  createAiStore,
  defaultPermissions,
  defaultScope,
  sanitizePort,
}
