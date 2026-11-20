import { invalid } from './errors.mjs'

export const protocols = ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generate-content']
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const secretName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

export function isRecord(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function nonempty(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function jsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return true
  if ((!Array.isArray(value) && !isRecord(value)) || ancestors.has(value)) return false
  ancestors.add(value)
  const valid = Object.values(value).every((child) => jsonValue(child, ancestors))
  ancestors.delete(value)
  return valid
}

export function parseBaseUrl(value) {
  let url
  try { url = new URL(value) } catch { invalid('Enter a valid AI service Base URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    invalid('Use an HTTP(S) Base URL without embedded credentials or a fragment.')
  }
  return url
}

export function endpointUrl(config, path, model = '') {
  const base = parseBaseUrl(config.baseUrl)
  const trimmed = model.replace(/^models\//, '')
  const resolvedPath = path.replaceAll('{model}', encodeURIComponent(trimmed))
  const query = new URLSearchParams(base.search)
  base.search = ''
  base.pathname = base.pathname.replace(/\/*$/, '/')
  let endpoint
  try { endpoint = new URL(resolvedPath, base) } catch { invalid('Enter a valid AI request path.') }
  if (endpoint.origin !== base.origin || endpoint.username || endpoint.password || endpoint.hash) {
    invalid('AI request paths must use the Base URL origin without embedded credentials or a fragment.')
  }
  for (const name of new Set(query.keys())) {
    if (!endpoint.searchParams.has(name)) {
      for (const value of query.getAll(name)) endpoint.searchParams.append(name, value)
    }
  }
  return endpoint
}

export function validateGeneration(options) {
  if (options === undefined) return
  if (!isRecord(options)) invalid('Generation options must be an object.')
  const { temperature, topP, maxOutputTokens, contextTokens, reasoningEffort, thinkingBudgetTokens } = options
  if ((temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0))
    || (topP !== undefined && (!Number.isFinite(topP) || topP < 0 || topP > 1))
    || [maxOutputTokens, contextTokens].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 1))
    || (thinkingBudgetTokens !== undefined && (!Number.isSafeInteger(thinkingBudgetTokens) || thinkingBudgetTokens < 0))
    || (reasoningEffort !== undefined && !nonempty(reasoningEffort))) {
    invalid('Check the numeric ranges and reasoning effort in the generation options.')
  }
}

function validateHeaderValue(value) {
  if (typeof value !== 'string' || /[\0\r\n]|[^\u0000-\u00ff]/.test(value)) invalid('Enter a valid HTTP header value.')
}

export function validateProfile(config) {
  if (!isRecord(config) || !nonempty(config.name) || !protocols.includes(config.protocol) || !nonempty(config.baseUrl)) {
    invalid('Enter an AI profile name, protocol and Base URL.')
  }
  const { paths, auth, headers, extraBody, model, generation, stream, timeoutMs, retries, anthropicDirectBrowserAccess } = config
  parseBaseUrl(config.baseUrl)
  if (paths !== undefined) {
    if (!isRecord(paths)) invalid('Request paths must be an object.')
    for (const key of ['generate', 'stream', 'models']) {
      if (paths[key] === undefined) continue
      if (!nonempty(paths[key])) invalid('Enter a valid AI request path.')
      endpointUrl(config, paths[key], 'model')
    }
  }
  if (!isRecord(auth) || !['none', 'bearer', 'x-api-key', 'header', 'query'].includes(auth.kind)) {
    invalid('Select an AI authentication method.')
  }
  if (auth.kind === 'header' && (typeof auth.name !== 'string' || !headerName.test(auth.name))) invalid('Enter a valid authentication header name.')
  if (auth.kind === 'header' && auth.prefix !== undefined) validateHeaderValue(auth.prefix)
  if (auth.kind === 'query' && !nonempty(auth.name)) invalid('Enter an authentication query parameter name.')
  if (headers !== undefined) {
    if (!Array.isArray(headers)) invalid('Custom headers must be a list.')
    for (const header of headers) {
      if (!isRecord(header) || typeof header.name !== 'string' || !headerName.test(header.name)) invalid('Enter a valid custom header name.')
      if (Object.hasOwn(header, 'secretRef')) {
        if (typeof header.secretRef !== 'string' || !secretName.test(header.secretRef) || Object.hasOwn(header, 'value')) {
          invalid('Use a secret reference for the custom header.')
        }
      } else {
        validateHeaderValue(header.value)
      }
    }
  }
  if (extraBody !== undefined && (!isRecord(extraBody) || !jsonValue(extraBody))) invalid('Extra request parameters must be a JSON object.')
  if (model !== undefined && typeof model !== 'string') invalid('Enter a valid model name.')
  if ([stream, anthropicDirectBrowserAccess].some((value) => value !== undefined && typeof value !== 'boolean')
    || (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1))
    || (retries !== undefined && (!Number.isSafeInteger(retries) || retries < 0))) {
    invalid('Check the stream, timeout and retry settings.')
  }
  validateGeneration(generation)
}

export function validateCredentialPatch(patch) {
  if (patch === undefined) return
  if (!isRecord(patch) || (patch.apiKey !== undefined && patch.apiKey !== null && !nonempty(patch.apiKey))) {
    invalid('Enter an API key, or use null to remove it.')
  }
  if (patch.headerSecrets !== undefined) {
    if (!isRecord(patch.headerSecrets)) invalid('Header secrets must be an object.')
    for (const [name, value] of Object.entries(patch.headerSecrets)) {
      if (!secretName.test(name) || (value !== null && !nonempty(value))) invalid('Enter a value for each header secret.')
    }
  }
}

export function requestHeaders(config, credentials, url, { browser = false, json = false, stream = false } = {}) {
  const headers = new Headers({ accept: stream ? 'text/event-stream' : 'application/json' })
  if (json) headers.set('content-type', 'application/json')
  if (config.protocol === 'anthropic-messages') {
    headers.set('anthropic-version', '2023-06-01')
    if (browser && config.anthropicDirectBrowserAccess) headers.set('anthropic-dangerous-direct-browser-access', 'true')
  }
  for (const header of config.headers ?? []) {
    let value = header.value
    if ('secretRef' in header) {
      const secrets = credentials.headerSecrets ?? {}
      if (!Object.hasOwn(secrets, header.secretRef)) invalid('A configured custom header is missing its secret.')
      value = secrets[header.secretRef]
    }
    validateHeaderValue(value)
    headers.set(header.name, value)
  }
  const { auth } = config
  if (auth.kind === 'none') return headers
  if (!nonempty(credentials.apiKey)) invalid('Enter an API key for this AI profile.')
  if (auth.kind === 'query') {
    url.searchParams.set(auth.name, credentials.apiKey)
  } else {
    const name = auth.kind === 'bearer' ? 'authorization' : auth.kind === 'x-api-key' ? 'x-api-key' : auth.name
    const prefix = auth.kind === 'bearer' ? 'Bearer ' : auth.prefix ?? ''
    validateHeaderValue(prefix + credentials.apiKey)
    headers.set(name, prefix + credentials.apiKey)
  }
  return headers
}

export function mergeJson(base, extras) {
  const entries = new Map(Object.entries(base))
  for (const [key, value] of Object.entries(extras ?? {})) {
    const previous = entries.get(key)
    entries.set(key, isRecord(previous) && isRecord(value) ? mergeJson(previous, value) : value)
  }
  return Object.fromEntries(entries)
}
