const messages = {
  invalid_config: 'Check the AI profile or request settings.',
  not_configured: 'Select an AI profile for this feature.',
  profile_changed: 'The AI profile changed. Prepare the request again.',
  storage: 'The local AI storage is unavailable.',
  keychain_unavailable: 'The system keychain is unavailable.',
  cache_token_expired: 'Prepare the chapter again before saving its summary.',
  unauthorized: 'The AI service rejected the credentials.',
  forbidden: 'The AI service denied access.',
  rate_limited: 'The AI service is rate limiting requests.',
  quota_exceeded: 'The AI service reports insufficient quota or credit.',
  timeout: 'The AI request timed out.',
  cors: 'The browser may have blocked this cross-origin request.',
  network: 'The AI service could not be reached.',
  http_error: 'The AI service returned an error.',
  invalid_response: 'The AI service returned an unexpected or incomplete response.',
}

export class ProviderFailure extends Error {
  constructor(code, message = messages[code], { rawErrorBody, transient, ...details } = {}) {
    super(message)
    this.error = { code, message, ...details }
    this.rawErrorBody = rawErrorBody
    this.transient = transient === true
  }
}

export function publicError(error, fallback = 'storage') {
  return (error instanceof ProviderFailure ? error : new ProviderFailure(fallback)).error
}

export function failureResult(error, fallback) {
  return { ok: false, error: publicError(error, fallback) }
}

export function invalid(message) {
  throw new ProviderFailure('invalid_config', message)
}

function retryAfterMs(value) {
  if (!value) return undefined
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  if (Number.isFinite(ms)) return Math.max(0, ms)
}

export function upstreamFailure(payload, httpStatus, rawErrorBody, retryAfter) {
  const error = payload?.error ?? payload
  const codes = [error?.code, error?.type, error?.status].filter((value) => typeof value === 'string')
  const codeText = codes.join(' ').toLowerCase()
  const message = typeof error === 'string' ? error : String(error?.message ?? '')
  const quotaDetails = Array.isArray(error?.details) ? error.details : []
  const dailyQuota = quotaDetails.some((detail) => Array.isArray(detail?.violations)
    && detail.violations.some((violation) => /per.?day|daily/i.test(violation?.quotaId ?? '')))
  let code = 'http_error'
  if (httpStatus === 402 || dailyQuota
    || /insufficient_quota|quota_exceeded|billing_hard_limit|credit_balance_too_low|insufficient_balance|payment_required/.test(codeText)
    || /credit balance is too low|insufficient (?:credits?|quota|balance)|quota (?:has been )?exhausted|当前余额不足|额度不足|余额不足/i.test(message || rawErrorBody || '')) {
    code = 'quota_exceeded'
  } else if (httpStatus === 401 || /authentication_error|invalid_api_key|unauthenticated/.test(codeText)) {
    code = 'unauthorized'
  } else if (httpStatus === 403 || /permission_error|permission_denied/.test(codeText)) {
    code = 'forbidden'
  } else if (httpStatus === 429 || /rate_limit|resource_exhausted/.test(codeText)) {
    code = 'rate_limited'
  } else if (httpStatus === 408 || httpStatus === 504) {
    code = 'timeout'
  }
  const transient = code === 'rate_limited' || code === 'timeout'
    || (code === 'http_error' && (httpStatus >= 500 || /overloaded|server_error/.test(codeText)))
  // Codes are for display only. Never include arbitrary upstream messages in regular errors.
  const providerCode = codes.find((value) => /^[a-zA-Z0-9_.-]{1,100}$/.test(value))
  return new ProviderFailure(code, undefined, {
    httpStatus, providerCode, retryAfterMs: retryAfterMs(retryAfter), rawErrorBody, transient,
  })
}
