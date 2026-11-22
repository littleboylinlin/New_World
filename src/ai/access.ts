import { ai } from '../ai-provider'
import type { ConfigState, Feature, SavedProfile } from '../ai-provider'
import { t } from '../i18n'
import { confirmDialog } from '../dialogs'
import { profileFor } from './features'

export { confirmDialog }

const consentKey = 'new-world:ai-consent'
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

function originOf(profile: SavedProfile) {
  try { return new URL(profile.config.baseUrl).origin } catch { return profile.config.baseUrl }
}

function consents(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(consentKey) ?? '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/** Whether the user already agreed to send text to this profile's current address. */
export function hasConsent(profile: SavedProfile) {
  return consents()[profile.id] === originOf(profile)
}

function remember(profile: SavedProfile) {
  try { localStorage.setItem(consentKey, JSON.stringify({ ...consents(), [profile.id]: originOf(profile) })) } catch { /* Asked again next time. */ }
}

/**
 * Call before an AI feature sends the user's text. Without a profile it offers the settings page;
 * the first time a profile is used (or after its address changes) it says where the text goes.
 * Resolves to the profile that will be used, or null when the user stays put.
 */
export async function requireAi(feature: Feature): Promise<SavedProfile | null> {
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
  const profile = found.profile
  if (hasConsent(profile)) return profile
  let host = profile.config.baseUrl
  try { host = new URL(profile.config.baseUrl).host } catch { /* Shown as typed. */ }
  const skip = { label: t('aiAccess.dontAskAgain'), checked: true }
  const agreed = await confirmDialog(t('aiAccess.consentTitle'), [
    t('aiAccess.consentCopy', [host, profile.config.name]),
    t('aiAccess.consentRelay'),
  ], t('aiAccess.consentAction'), false, skip)
  if (!agreed) return null
  if (skip.checked) remember(profile)
  return profile
}
