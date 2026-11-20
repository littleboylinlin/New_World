import { createProviderClient } from '../../shared/ai-provider/client.mjs'
import { publicError, ProviderFailure } from '../../shared/ai-provider/errors.mjs'
import { listPresets } from '../../shared/ai-provider/presets.mjs'
import { createProviderService } from '../../shared/ai-provider/service.mjs'
import type {
  AiProviderApi, AiProviderDesktopBridge, AiRun, GenerateRequest, ProviderMethods, RunEvent,
} from '../../shared/ai-provider/types.mjs'
import { createWebStore } from './web-store'
export type * from '../../shared/ai-provider/types.mjs'

async function* desktopEvents(
  bridge: AiProviderDesktopBridge, request: GenerateRequest, id: string, signal: AbortSignal,
): AsyncIterable<RunEvent> {
  if (!await bridge.start(id, request)) throw new ProviderFailure('forbidden')
  const cancel = () => bridge.cancel(id)
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  try {
    for (;;) {
      const event = await bridge.next(id)
      if (!event) return
      yield event
      if (event.type !== 'delta') return
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    bridge.release(id)
  }
}

type RunSource = (request: GenerateRequest, id: string, signal: AbortSignal) => AsyncIterable<RunEvent>

function run(source: RunSource, request: GenerateRequest): AiRun {
  const id = crypto.randomUUID()
  const controller = new AbortController()
  const { signal } = controller

  async function* events(): AsyncIterable<RunEvent> {
    try {
      if (!signal.aborted) {
        for await (const event of source(request, id, signal)) {
          if (signal.aborted) break
          yield event
          if (event.type !== 'delta') return
        }
      }
      yield signal.aborted ? { type: 'cancelled' } : { type: 'error', error: publicError(null, 'invalid_response') }
    } catch (error) {
      yield signal.aborted ? { type: 'cancelled' } : { type: 'error', error: publicError(error) }
    } finally {
      controller.abort()
    }
  }

  return { id, events: events(), cancel: () => controller.abort() }
}

function desktopApi(bridge: AiProviderDesktopBridge): AiProviderApi {
  const call = <M extends keyof ProviderMethods>(method: M) =>
    (...args: Parameters<ProviderMethods[M]>) => bridge.call(method, ...args)
  return {
    getConfig: call('getConfig'),
    saveProfile: call('saveProfile'),
    deleteProfile: call('deleteProfile'),
    setRouting: call('setRouting'),
    exportConfig: call('exportConfig'),
    importConfig: call('importConfig'),
    testConnection: call('testConnection'),
    listModels: call('listModels'),
    listPresets,
    generate: (request) => run((input, id, signal) => desktopEvents(bridge, input, id, signal), request),
  }
}

function webApi(): AiProviderApi {
  const service = createProviderService(createWebStore(), createProviderClient({ browserOrigin: location.origin }))
  return {
    ...service,
    listPresets,
    generate: (request) => run((input, _id, signal) => service.generate(input, signal), request),
  }
}

const desktop = window.newWorldDesktop
export const ai: AiProviderApi = desktop ? desktopApi(desktop.aiProvider) : webApi()
