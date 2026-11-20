// A TextDecoder preserves UTF-8 code points split between network chunks.
// A trailing CR is held back until the next chunk so CRLF is one delimiter.
async function* lines(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let match
      while ((match = /\r\n|\r|\n/.exec(pending))) {
        if (!done && match[0] === '\r' && match.index === pending.length - 1) break
        yield pending.slice(0, match.index)
        pending = pending.slice(match.index + match[0].length)
      }
      if (done) {
        if (pending) yield pending
        return
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function* readSse(body) {
  let event
  let data = []
  for await (const line of lines(body)) {
    if (line === '') {
      if (data.length) yield { event, data: data.join('\n') }
      event = undefined
      data = []
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''))
    } else if (line.startsWith('event:')) {
      event = line.slice(6).replace(/^ /, '')
    }
  }
  if (data.length) yield { event, data: data.join('\n') }
}
