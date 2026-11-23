import { ai } from '../ai-provider'
import type { ConfigState, Feature, ProfileRecord, ResolvedProfile, SavedProfile } from '../ai-provider'
import { t } from '../i18n'
import { confirmDialog } from '../dialogs'
import { profileFor } from './features'
import { describeAiError } from './errors'
import { showNotice } from '../undo'

export { confirmDialog }

const consentKey = 'new-world:ai-consent'
const bookConsentKey = 'new-world:ai-book-consent'
export const aiSettingsHash = '#/settings/ai'

/** Reads the configuration without throwing, whatever the platform bridge does. */
export async function readAiConfig(): Promise<ConfigState | null> {
  try {
    const result = await ai.getConfig()
    return result.ok ? result.data : null
  } catch {
    return null
  }
}

function originOf(profile: ProfileRecord) {
  try { return new URL(profile.config.baseUrl).origin } catch { return profile.config.baseUrl }
}

function consents(key: string): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/** Whether the user already agreed to send text to this profile's current address. */
export function hasConsent(profile: SavedProfile) {
  return consents(consentKey)[profile.id] === originOf(profile)
}

async function requestedProfile(feature: Feature): Promise<SavedProfile | null> {
  const state = await readAiConfig()
  const found = state ? profileFor(state, feature) : { ok: false as const, reason: 'not_configured' as const }
  if (!found.ok) {
    const disabled = found.reason === 'disabled'
    const go = await confirmDialog(
      disabled ? t('aiAccess.disabledTitle') : t('aiAccess.setupTitle'),
      [disabled ? t('aiAccess.disabledCopy') : t('aiAccess.setupCopy')],
      t('aiAccess.openSettings'),
    )
    if (go) location.hash = aiSettingsHash
    return null
  }
  return found.profile
}

async function approveSend(profile: ProfileRecord, key: string, copy: string) {
  if (consents(key)[profile.id] === originOf(profile)) return true
  let host = profile.config.baseUrl
  try { host = new URL(profile.config.baseUrl).host } catch { /* Shown as typed. */ }
  const skip = { label: t('aiAccess.dontAskAgain'), checked: true }
  const agreed = await confirmDialog(t('aiAccess.consentTitle'), [
    t(copy, [host, profile.config.name]),
    t('aiAccess.consentRelay'),
  ], t('aiAccess.consentAction'), false, skip)
  if (agreed && skip.checked) {
    try { localStorage.setItem(key, JSON.stringify({ ...consents(key), [profile.id]: originOf(profile) })) } catch { /* Asked again next time. */ }
  }
  return agreed
}

/** Offers setup or first-use consent before a feature sends text to its provider. */
export async function requireAi(feature: Feature): Promise<SavedProfile | null> {
  const profile = await requestedProfile(feature)
  return profile && await approveSend(profile, consentKey, 'aiAccess.consentCopy') ? profile : null
}

/** Book context needs its own consent and uses the approved configuration for the entire request. */
export async function requireBookAi(): Promise<ResolvedProfile | null> {
  const saved = await requestedProfile('ask')
  if (!saved) return null
  const resolved = await ai.resolveProfile({ feature: 'ask', profileId: saved.id })
  if (!resolved.ok) { showNotice(describeAiError(resolved.error)); return null }
  return await approveSend(resolved.data, bookConsentKey, 'aiAccess.bookConsentCopy') ? resolved.data : null
}
