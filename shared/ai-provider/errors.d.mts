import type { AiError, AiErrorCode, Result } from './types.mjs'

export class ProviderFailure extends Error {
  constructor(code: AiErrorCode, message?: string, details?: Omit<AiError, 'code' | 'message'> & {
    rawErrorBody?: string
    transient?: boolean
  })
  error: AiError
  rawErrorBody?: string
  transient: boolean
}

export function publicError(error: unknown, fallback?: AiErrorCode): AiError
export function failureResult(error: unknown, fallback?: AiErrorCode): Extract<Result<never>, { ok: false }>
export function invalid(message: string): never
