export type Locale = 'zh-CN' | 'en'
export interface LanguagePack { schema: 1; locale: Locale; messages: Record<string, string> }
export interface LanguageManifest {
  schema: number
  version: string
  keys: string[]
  packs: Record<Locale, { file: string; size: number; sha256: string }>
}
export const supportedLocales: Locale[]
export function systemLocale(value: unknown): Locale
export function isLocale(value: unknown): value is Locale
export function parseLanguagePack(bytes: Uint8Array, manifest: LanguageManifest, locale: Locale): LanguagePack
export function formatMessage(messages: Record<string, string>, key: string, values?: unknown[]): string
