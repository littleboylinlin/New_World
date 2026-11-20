import type { createProviderClient } from './client.mjs'
import type { Credentials, GenerateRequest, ProfileRecord, ProviderMethods, Routing, RunEvent } from './types.mjs'

export type StoredProfile<Entry> = ProfileRecord & {
  revision: string
  rememberCredentials: boolean
  credentialEntry?: Entry
}

export type StoredState<Entry> = { profiles: StoredProfile<Entry>[]; routing: Routing }

type CredentialInfo = { hasApiKey: boolean; savedSecretRefs: string[] }

export interface Vault<Entry> {
  read(profile: StoredProfile<Entry>): Credentials
  info(profile: StoredProfile<Entry>): CredentialInfo
  write(profile: StoredProfile<Entry>, credentials: Credentials): void
  remove(profile: StoredProfile<Entry>): void
}

export interface ProviderStore<Entry> {
  kind: 'system' | 'web'
  read<T>(operation: (state: StoredState<Entry>, vault: Vault<Entry>) => T): Promise<T>
  update<T>(operation: (state: StoredState<Entry>, vault: Vault<Entry>) => T): Promise<T>
}

export function credentialInfo(credentials: Credentials): CredentialInfo
export function emptyState<T>(): StoredState<T>
export function createProviderService<Entry>(store: ProviderStore<Entry>, client?: ReturnType<typeof createProviderClient>): ProviderMethods & {
  generate(request: GenerateRequest, signal: AbortSignal): AsyncIterable<RunEvent>
}
