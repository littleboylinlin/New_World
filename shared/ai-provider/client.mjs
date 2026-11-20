import { endpointUrl, requestHeaders, validateCredentialPatch, validateProfile } from './config.mjs'
import { invalid, ProviderFailure, failureResult, publicError, upstreamFailure } from './errors.mjs'
import { adapters, generationPath, requestBody } from './protocols.mjs'
import { readSse } from './sse.mjs'

const defaults = { stream: true, timeoutMs: 120_000, retries: 0 }
const requestOptions = { credentials: 'omit', redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer' }

function parseJson(text) {
  try { return JSON.parse(text) } catch { return undefined }
}

function prepare(target, url, transport, settings) {
  return {
    url, transport,
    init: {
      ...requestOptions,
      method: settings.body === undefined ? 'GET' : 'POST',
      headers: requestHeaders(target.config, target.credentials, url, {
        browser: Boolean(transport.origin), json: settings.body !== undefined, stream: settings.stream,
      }),
      body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
    },
  }
}

function generateRequest(target, request, stream, transport, probe = false) {
  validateProfile(target.config)
  validateCredentialPatch(target.credentials)
  const url = endpointUrl(target.config, generationPath(target.config, stream), target.config.model?.trim())
  return prepare(target, url, transport, { stream, body: requestBody(target.config, request, stream, probe) })
}

async function fetchResponse({ url, init, transport }, signal, diagnose = false) {
  let response
  try {
    response = await transport.fetch(url, { ...init, signal })
  } catch (error) {
    signal.throwIfAborted()
    const corsPossible = Boolean(transport.origin && url.origin !== transport.origin && error instanceof TypeError)
    if (diagnose && corsPossible) {
      // An opaque response only establishes reachability. It carries no status,
      // credentials or user data and is never used as a generation response.
      // Browsers require follow mode for an anonymous no-cors fetch.
      const probe = await transport.fetch(new URL(url.origin), {
        ...requestOptions, redirect: 'follow', method: 'HEAD', mode: 'no-cors', signal,
      }).catch(() => undefined)
      if (probe?.type === 'opaque' || probe?.ok) throw new ProviderFailure('cors')
      signal.throwIfAborted()
    }
    throw new ProviderFailure('network', undefined, { transient: !corsPossible, corsPossible: corsPossible || undefined })
  }
  if (response.type === 'opaqueredirect') throw new ProviderFailure('http_error', 'The AI service redirected the request.')
  if (!response.ok) {
    const text = await response.text()
    throw upstreamFailure(parseJson(text), response.status, text, response.headers.get('retry-after'))
  }
  return response
}

function statusFailure(error, response) {
  if (error instanceof ProviderFailure && error.error.httpStatus === undefined) error.error.httpStatus = response.status
  return error
}

async function readJsonResponse(response, read) {
  const raw = await response.text()
  const value = parseJson(raw)
  if (value?.error != null || value?.status === 'failed') {
    throw upstreamFailure(value, response.status, raw, response.headers.get('retry-after'))
  }
  try {
    return read(value)
  } catch (error) {
    throw statusFailure(error, response)
  }
}

async function* streamResponse(response, adapter) {
  if (!response.body) throw new ProviderFailure('invalid_response', undefined, { httpStatus: response.status })
  let finishReason
  let canEnd = false
  try {
    for await (const { event, data } of readSse(response.body)) {
      const value = data === '[DONE]' ? {} : parseJson(data)
      if (!value || typeof value !== 'object') throw new ProviderFailure('invalid_response')
      const type = data === '[DONE]' ? 'done' : value.type ?? event
      if (type === 'error' || value.error != null) throw upstreamFailure(value, response.status, data, response.headers.get('retry-after'))
      const update = adapter.stream(value, type)
      if (update.error) throw upstreamFailure(update.error, response.status, data, response.headers.get('retry-after'))
      if (typeof update.text === 'string' && update.text) yield { text: update.text }
      if (typeof update.finishReason === 'string') finishReason = update.finishReason
      if (update.end) {
        yield { end: true, finishReason }
        return
      }
      canEnd ||= update.canEnd === true
    }
    if (!canEnd) throw new ProviderFailure('invalid_response')
    yield { end: true, finishReason }
  } catch (error) {
    throw statusFailure(error, response)
  }
}

function requestFailure(error, timeout) {
  if (timeout.aborted) return new ProviderFailure('timeout', undefined, { transient: true })
  if (error instanceof ProviderFailure) return error
  if (error instanceof TypeError) return new ProviderFailure('network', undefined, { transient: true })
  return new ProviderFailure('invalid_response')
}

function waitBeforeRetry(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

export function createProviderClient(options = {}) {
  const transport = { fetch: options.fetch ?? globalThis.fetch.bind(globalThis), origin: options.browserOrigin }

  async function* generate(target, request, signal) {
    let prepared, stream
    const config = target.config
    const adapter = adapters[config.protocol]
    try {
      stream = request.stream ?? config.stream ?? defaults.stream
      if (typeof stream !== 'boolean') invalid('The stream option must be a boolean.')
      prepared = generateRequest(target, request, stream, transport)
    } catch (error) {
      yield { type: 'error', error: publicError(error, 'invalid_config') }
      return
    }
    const retries = config.retries ?? defaults.retries
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (signal.aborted) break
      const timeout = AbortSignal.timeout(config.timeoutMs ?? defaults.timeoutMs)
      const current = AbortSignal.any([signal, timeout])
      const pieces = []
      let finishReason
      try {
        const response = await fetchResponse(prepared, current)
        if (stream) {
          for await (const update of streamResponse(response, adapter)) {
            current.throwIfAborted()
            if (update.end) {
              finishReason = update.finishReason
            } else {
              pieces.push(update.text)
              yield { type: 'delta', text: update.text }
            }
          }
        } else {
          const result = await readJsonResponse(response, adapter.result)
          pieces.push(result.text)
          finishReason = result.finishReason
        }
        current.throwIfAborted()
        yield { type: 'done', text: pieces.join(''), finishReason }
        return
      } catch (error) {
        if (signal.aborted) break
        const failure = requestFailure(error, timeout)
        if (pieces.length || !failure.transient || attempt >= retries) {
          yield { type: 'error', error: failure.error }
          return
        }
        await waitBeforeRetry(Math.max(failure.error.retryAfterMs ?? 0, Math.min(250 * 2 ** attempt, 4000)), signal)
      }
    }
    yield { type: 'cancelled' }
  }

  async function testConnection(target, stream) {
    let timeout, httpStatus
    try {
      stream ??= target.config.stream ?? defaults.stream
      if (typeof stream !== 'boolean') invalid('The stream option must be a boolean.')
      const prepared = generateRequest(target, { messages: [{ role: 'user', text: 'ping' }] }, stream, transport, true)
      timeout = AbortSignal.timeout(target.config.timeoutMs ?? defaults.timeoutMs)
      const adapter = adapters[target.config.protocol]
      const response = await fetchResponse(prepared, timeout, true)
      httpStatus = response.status
      if (stream) {
        for await (const _update of streamResponse(response, adapter)) { /* read through the terminal event */ }
      } else {
        await readJsonResponse(response, adapter.result)
      }
      return { ok: true, httpStatus }
    } catch (error) {
      const failure = timeout ? requestFailure(error, timeout) : error
      return {
        ...failureResult(failure, 'invalid_config'),
        httpStatus: failure?.error?.httpStatus ?? httpStatus,
        rawErrorBody: failure?.rawErrorBody,
      }
    }
  }

  async function listModels(target, cursor) {
    let timeout
    try {
      const { config } = target
      validateProfile(config)
      validateCredentialPatch(target.credentials)
      const adapter = adapters[config.protocol]
      const url = endpointUrl(config, config.paths?.models ?? 'models', config.model?.trim())
      if (cursor !== undefined) {
        if (typeof cursor !== 'string' || !cursor) invalid('Enter a valid model list cursor.')
        url.searchParams.set(adapter.cursorParam ?? 'after', cursor)
      }
      const prepared = prepare(target, url, transport, {})
      timeout = AbortSignal.timeout(config.timeoutMs ?? defaults.timeoutMs)
      const response = await fetchResponse(prepared, timeout)
      return { ok: true, data: await readJsonResponse(response, adapter.models) }
    } catch (error) {
      return failureResult(timeout ? requestFailure(error, timeout) : error, 'invalid_config')
    }
  }

  return { generate, testConnection, listModels }
}
