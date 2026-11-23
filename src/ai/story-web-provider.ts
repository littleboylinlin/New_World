import { ai } from '../ai-provider'
import type { GenerateRequest } from '../ai-provider'
import { parseStoryRoute, storyEditorWindow, storyRoutePrefix } from '../story-settings/route'
import { collect } from './review'
import type { Outcome } from './review'

const requestType = 'new-world:story-analysis'
const cancelled: Outcome = { ok: false, cancelled: true }
const unavailable: Outcome = { ok: false, error: { code: 'network', message: '' } }

async function localRequest(request: GenerateRequest, signal: AbortSignal) {
  if (signal.aborted) return cancelled
  const run = ai.generate(request)
  const cancel = () => run.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try { return await collect(run) } finally { signal.removeEventListener('abort', cancel) }
}

/** Only story analysis is relayed. Web keys that were kept in memory stay in the editor tab. */
export function handleStoryWebRequests() {
  if (window.newWorldDesktop) return
  window.addEventListener('message', (event) => {
    const request: GenerateRequest | undefined = event.data?.request
    if (event.origin !== location.origin || event.data?.type !== requestType || event.ports.length !== 1
      || (request?.feature !== 'extension:storyExtract' && request?.feature !== 'extension:storyCheck')) return
    try {
      const sender = event.source as Window | null
      if (!sender || sender.location.pathname !== location.pathname || !parseStoryRoute(sender.location.hash)) return
    } catch { return }
    const [port] = event.ports
    const controller = new AbortController()
    const dispose = () => { controller.abort(); port.postMessage({ result: cancelled }); port.close() }
    window.addEventListener('pagehide', dispose, { once: true, signal: controller.signal })
    port.onmessage = ({ data }) => { if (data === 'cancel') controller.abort() }
    port.postMessage({ ready: true })
    void localRequest(request, controller.signal).then((result) => {
      port.postMessage({ result })
    }, () => {
      port.postMessage({ result: unavailable })
    }).finally(() => { controller.abort(); port.close() })
  })
}

export function requestStoryAnalysis(request: GenerateRequest, signal: AbortSignal): Promise<Outcome> {
  const editor = !window.newWorldDesktop && location.hash.startsWith(storyRoutePrefix) ? storyEditorWindow() : undefined
  if (!editor) return localRequest(request, signal)
  if (signal.aborted) return Promise.resolve(cancelled)
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    const finish = (result: Outcome, cancel = false) => {
      if (cancel) port1.postMessage('cancel')
      port1.close()
      clearTimeout(waiting)
      clearInterval(watching)
      signal.removeEventListener('abort', abort)
      resolve(result)
    }
    const abort = () => finish(cancelled, true)
    const waiting = setTimeout(() => finish(unavailable, true), 5000)
    const watching = setInterval(() => { if (editor.closed) finish(unavailable) }, 1000)
    signal.addEventListener('abort', abort, { once: true })
    port1.onmessage = ({ data }) => {
      if (data?.ready) clearTimeout(waiting)
      else if (data?.result) finish(data.result)
    }
    try { editor.postMessage({ type: requestType, request }, location.origin, [port2]) }
    catch { finish(unavailable) }
  })
}
