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

export type BuiltinFeature = 'ask' | 'polish' | 'proofread' | 'bookSummary'
export type Feature = BuiltinFeature | `extension:${string}`

export type Route = {
  feature: Feature
  profileId?: string
  expectedProfileRevision?: string
}

export type GenerateRequest = CompletionRequest & Route

export interface AiRun {
  id: string
  events: AsyncIterable<RunEvent>
  cancel(): void
}

export type ProfileRecord = { id: string; config: ProfileConfig }

export type SavedProfile = ProfileRecord & {
  hasApiKey: boolean
  savedSecretRefs: string[]
  rememberCredentials: boolean
}

export type Routing = {
  defaultProfileId: string | null
  byFeature: Partial<Record<Feature, string | null>>
}

export type ConfigFile = {
  format: 'new-world-ai-providers'
  version: 1
  profiles: ProfileRecord[]
  routing: Routing
}

export type ConfigState = Omit<ConfigFile, 'profiles'> & {
  profiles: SavedProfile[]
  credentialStorage: 'system' | 'web'
}

export type SaveProfileInput = {
  id?: string
  config: ProfileConfig
  credentials?: CredentialPatch
  rememberCredentials?: boolean
}

export type ConnectionTarget =
  | { profileId: string }
  | { draft: ProfileConfig; credentials?: CredentialPatch; reuseCredentialsFrom?: string }

export type ConnectionTestOptions = { stream?: boolean }

export type SplitRequest = Route & {
  text: string
  reservedPromptTokens?: number
  reservedOutputTokens?: number
}

export type TextChunk = {
  text: string
  start: number
  end: number
  estimatedTokens: number
}

type SummaryRoute = Route & { profileId: string; expectedProfileRevision: string }

export type ChapterSummaryPlan =
  | { hit: true; summary: string }
  | { hit: false; route: SummaryRoute; chunks: TextChunk[]; cacheToken: string }

export interface SummaryApi {
  splitText(request: SplitRequest): Promise<Result<TextChunk[]>>
  prepareChapterSummary(request: SplitRequest & { promptVersion: string }): Promise<Result<ChapterSummaryPlan>>
  readCachedBookSummaries(request: Route & {
    bookTitle: string
    chapters: readonly string[]
    chapterPromptVersion: string
    bookPromptVersion: string
  }): Promise<Result<{ chapters: (string | undefined)[]; book?: string; bookCacheToken: string }>>
  saveChapterSummary(cacheToken: string, summary: string): Promise<Result<void>>
  clearSummaryCache(): Promise<Result<void>>
}

export type ResolvedProfile = {
  id: string
  revision: string
  config: ProfileConfig
}

export interface AiProviderApi extends SummaryApi {
  getConfig(): Promise<Result<ConfigState>>
  resolveProfile(route: Route): Promise<Result<ResolvedProfile>>
  saveProfile(input: SaveProfileInput): Promise<Result<SavedProfile>>
  deleteProfile(id: string): Promise<Result<void>>
  setRouting(routing: Routing): Promise<Result<void>>
  listPresets(): readonly ProfileRecord[]
  exportConfig(): Promise<Result<ConfigFile>>
  importConfig(file: unknown): Promise<Result<{ profiles: SavedProfile[]; routing: Routing }>>

  generate(request: GenerateRequest): AiRun
  testConnection(target: ConnectionTarget, options?: ConnectionTestOptions): Promise<ConnectionTest>
  listModels(target: ConnectionTarget, cursor?: string): Promise<Result<ModelPage>>
}

export type ProviderMethods = Omit<AiProviderApi, 'generate' | 'listPresets' | keyof SummaryApi>

export interface AiProviderDesktopBridge {
  call<M extends keyof ProviderMethods>(method: M, ...args: Parameters<ProviderMethods[M]>): ReturnType<ProviderMethods[M]>
  start(id: string, request: GenerateRequest): Promise<boolean>
  next(id: string): Promise<RunEvent | null>
  cancel(id: string): void
  release(id: string): void
}
