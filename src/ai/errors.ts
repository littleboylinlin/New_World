import type { AiError } from '../ai-provider'
import { t } from '../i18n'

/** A short, friendly sentence for an AI error; the provider's own wording stays in `detail`. */
export function describeAiError(error: AiError): string {
  switch (error.code) {
    case 'unauthorized': return t('aiError.unauthorized')
    case 'forbidden': return t('aiError.forbidden')
    case 'quota_exceeded': return t('aiError.quota')
    case 'rate_limited':
      return error.retryAfterMs ? t('aiError.rateLimitedWait', [Math.max(1, Math.ceil(error.retryAfterMs / 1000))]) : t('aiError.rateLimited')
    case 'timeout': return t('aiError.timeout')
    case 'cors': return t('aiError.cors')
    case 'network': return error.corsPossible ? t('aiError.networkMaybeCors') : t('aiError.network')
    case 'http_error': return error.httpStatus ? t('aiError.httpStatus', [error.httpStatus]) : t('aiError.http')
    case 'invalid_response': return t('aiError.invalidResponse')
    case 'not_configured': return t('aiError.notConfigured')
    case 'profile_changed': return t('aiError.profileChanged')
    case 'invalid_config': return t('aiError.invalidConfig')
    case 'keychain_unavailable': return t('aiError.keychain')
    case 'storage': return t('aiError.storage')
    case 'cache_token_expired': return t('aiError.cacheExpired')
    default: return t('aiError.unknown')
  }
}

/** Whether the browser probably blocked the reply, so the user should hear about CORS fixes. */
export function mayBeCors(error: AiError) {
  return error.code === 'cors' || (error.code === 'network' && Boolean(error.corsPossible))
}
