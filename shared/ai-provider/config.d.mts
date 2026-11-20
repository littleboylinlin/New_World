import type { CredentialPatch, GenerationOptions, ProfileConfig } from './types.mjs'
export function isRecord(value: unknown): value is Record<string, unknown>
export function nonempty(value: unknown): value is string
export function parseBaseUrl(value: string): URL
export function endpointUrl(config: Pick<ProfileConfig, 'baseUrl' | 'protocol'>, path: string, model?: string): URL
export function validateProfile(config: unknown): asserts config is ProfileConfig
export function validateCredentialPatch(patch: unknown): asserts patch is CredentialPatch | undefined
export function validateGeneration(options: unknown): asserts options is GenerationOptions | undefined
