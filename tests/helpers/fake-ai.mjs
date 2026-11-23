import { createServer } from 'node:http'

const text = '你好，New World'
export const fakeText = text
export const unauthorizedBody = '{ "error": { "code": "invalid_api_key", "message": "fake key rejected" } }\n'

function protocolFor(path) {
  if (path.includes('chat/completions') || path.includes('custom-stream')) return 'chat'
  if (path.includes('/responses')) return 'responses'
  if (path.includes(':generateContent') || path.includes(':streamGenerateContent')) return 'gemini'
  return 'anthropic'
}

function jsonResponse(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(typeof value === 'string' ? value : JSON.stringify(value))
}

const responsesFor = (text) => ({
  chat: { choices: [{ message: { content: text }, finish_reason: 'stop' }] },
  responses: { status: 'completed', error: null, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] },
  anthropic: { content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  gemini: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] },
})

const eventsFor = (text) => ({
  chat: [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'],
  responses: [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: { status: 'completed' } }],
  anthropic: [
    { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ],
  gemini: [{ candidates: [{ content: { parts: [{ text: 'private reasoning', thought: true }, { text }] }, finishReason: 'STOP' }] }],
})

function encode(value) {
  if (typeof value === 'string') return `data: ${value}\r\n\r\n`
  const event = value.type ? `event: ${value.type}\r\n` : ''
  return `${event}data: ${JSON.stringify(value)}\r\n\r\n`
}

/** `reply` may choose the text for each generate request (default: the fixed fake text). */
export async function fakeAiService({ reply } = {}) {
  const requests = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.includes('/cors/')) {
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
      res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] ?? '*')
      res.setHeader('access-control-expose-headers', 'retry-after')
    }
    if (req.method === 'OPTIONS' || req.method === 'HEAD') {
      res.writeHead(204).end()
      return
    }
    const chunks = []
    try {
      for await (const chunk of req) chunks.push(chunk)
    } catch {
      return
    }
    const raw = Buffer.concat(chunks).toString()
    const request = { url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : undefined, closed: false }
    res.once('close', () => { request.closed = true })
    requests.push(request)
    const path = url.pathname

    if (path.includes('/timeout/')) return
    if (path.includes('/unauthorized/')) return jsonResponse(res, unauthorizedBody, 401)
    if (path.includes('/quota/')) {
      return jsonResponse(res, { error: { code: 'insufficient_quota', message: 'fake quota' } }, 429)
    }
    if (path.includes('/billing/')) {
      return jsonResponse(res, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low.' } }, 400)
    }
    if (path.includes('/daily/')) {
      return jsonResponse(res, { error: { status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDay' }] }] } }, 429)
    }
    if (path.includes('/rate/') || (path.includes('/retry/') && requests.filter((record) => record.url.pathname === path).length === 1)) {
      res.setHeader('retry-after', '0')
      return jsonResponse(res, { error: { type: 'rate_limit_error', message: 'fake rate limit' } }, 429)
    }
    if (path.includes('/redirect/')) {
      res.writeHead(307, { location: 'https://unused.invalid/never-send' }).end()
      return
    }
    if (req.method === 'GET') {
      if (path.includes('/no-models/')) return jsonResponse(res, { error: 'no model API' }, 404)
      if (path.includes('/gemini/')) {
        return jsonResponse(res, {
          models: [
            { name: 'models/example', displayName: 'Example', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
          ],
          nextPageToken: url.searchParams.has('pageToken') ? undefined : 'cursor',
        })
      }
      return jsonResponse(res, { data: [{ id: 'example', display_name: 'Example' }], has_more: true, last_id: 'cursor' })
    }

    const protocol = protocolFor(path)
    const answer = await reply?.(request) ?? text
    if (res.destroyed) return
    if (request.body?.stream !== true && !path.includes(':streamGenerateContent')) return jsonResponse(res, responsesFor(answer)[protocol])
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const frames = eventsFor(answer)[protocol].map(encode)
    const prefix = Buffer.from(`: comment\r\n\r\n${frames[0]}`)
    const middle = prefix.indexOf(Buffer.from('你')) + 1
    res.write(prefix.subarray(0, middle))
    res.write(prefix.subarray(middle, prefix.length - 1))
    setTimeout(() => {
      res.write(prefix.subarray(prefix.length - 1))
      if (path.includes('/hang/')) return
      if (path.includes('/partial-error/')) {
        res.end(encode({ type: 'error', error: { type: 'overloaded_error', message: 'fake overload' } }))
        return
      }
      if (path.includes('/truncated/')) return res.end()
      if (path.includes('/stream-error/')) {
        res.end(encode({ type: 'error', error: { code: 'insufficient_quota', message: 'stream quota' } }))
        return
      }
      res.end(frames.slice(1).join(''))
    }, 5)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    }),
  }
}
