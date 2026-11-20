import type { CompletionRequest, ConnectionTest, ModelPage, ProviderTarget, Result, RunEvent } from './types.mjs'

export function createProviderClient(options?: {
  fetch?: typeof fetch
  browserOrigin?: string
}): {
  generate(target: ProviderTarget, request: CompletionRequest, signal: AbortSignal): AsyncIterable<RunEvent>
  testConnection(target: ProviderTarget, stream?: boolean): Promise<ConnectionTest>
  listModels(target: ProviderTarget, cursor?: string): Promise<Result<ModelPage>>
}
