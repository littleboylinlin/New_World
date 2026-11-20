export type Protocol =
  | 'openai-chat' | 'openai-responses'
  | 'anthropic-messages' | 'gemini-generate-content'

export type Json = null | boolean | number | string | Json[] | JsonObject
export type JsonObject = { [key: string]: Json }

export type Auth =
  | { kind: 'none' | 'bearer' | 'x-api-key' }
  | { kind: 'header'; name: string; prefix?: string }
  | { kind: 'query'; name: string }

export type Header =
  | { name: string; value: string }
  | { name: string; secretRef: string }

export interface GenerationOptions {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  contextTokens?: number
  reasoningEffort?: string
  thinkingBudgetTokens?: number
}

export interface ProfileConfig {
  name: string
  protocol: Protocol
  baseUrl: string
  paths?: { generate?: string; stream?: string; models?: string }
  auth: Auth
  headers?: Header[]
  extraBody?: JsonObject
  model?: string
  generation?: GenerationOptions
  stream?: boolean
  timeoutMs?: number
  retries?: number
  anthropicDirectBrowserAccess?: boolean
}

export interface CredentialPatch {
  apiKey?: string | null
  headerSecrets?: Record<string, string | null>
}

export interface Credentials {
  apiKey?: string
  headerSecrets?: Record<string, string>
}

export interface ProviderTarget {
  config: ProfileConfig
  credentials: Credentials
}

export interface CompletionRequest {
  messages: { role: 'system' | 'user' | 'assistant'; text: string }[]
  generation?: GenerationOptions
  stream?: boolean
}

export type AiErrorCode =
  | 'invalid_config' | 'not_configured' | 'profile_changed'
  | 'storage' | 'keychain_unavailable' | 'cache_token_expired'
  | 'unauthorized' | 'forbidden' | 'rate_limited' | 'quota_exceeded'
  | 'timeout' | 'cors' | 'network' | 'http_error' | 'invalid_response'

export type AiError = {
  code: AiErrorCode
  message: string
  httpStatus?: number
  providerCode?: string
  retryAfterMs?: number
  corsPossible?: boolean
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AiError }

export type RunEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; finishReason?: string }
  | { type: 'cancelled' }
  | { type: 'error'; error: AiError }

export type ConnectionTest =
  | { ok: true; httpStatus: number }
  | { ok: false; httpStatus?: number; rawErrorBody?: string; error: AiError }

export interface ModelPage {
  models: { id: string; displayName?: string }[]
  nextCursor?: string
}
