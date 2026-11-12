import manifestData from '../public/locales/manifest.json'
import { formatMessage, isLocale, parseLanguagePack, systemLocale } from '../shared/language-packs.mjs'
import type { LanguageManifest, LanguagePack, Locale } from '../shared/language-packs.mjs'

const manifest = manifestData as LanguageManifest
const preference = 'new-world:language'
let messages: Record<string, string> = {}
export let locale: Locale = 'en'

export function t(key: string, values?: unknown[]) {
  return formatMessage(messages, key, values)
}

async function verify(bytes: Uint8Array, selected: Locale) {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
  const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
  if (hash !== manifest.packs[selected].sha256) throw new Error('Invalid language pack checksum')
  return parseLanguagePack(bytes, manifest, selected)
}

function cached(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}

async function webPack(selected: Locale) {
  const key = `new-world:pack:${manifest.version}:${selected}`
  const stored = cached(key)
  if (stored) {
    try { return await verify(new TextEncoder().encode(stored), selected) } catch { /* Fetch a fresh copy if the cache is damaged. */ }
  }
  const metadata = manifest.packs[selected]
  const response = await fetch(new URL(`./locales/${metadata.file}`, document.baseURI), {
    credentials: 'omit', signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok || !response.body) throw new Error('Language pack download failed')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > metadata.size) throw new Error('Language pack exceeds expected size')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const pack = await verify(bytes, selected)
  try { localStorage.setItem(key, new TextDecoder().decode(bytes)) } catch { /* Reading remains available when the browser cannot cache data. */ }
  return pack
}

function usePack(pack: LanguagePack) {
  if (!isLocale(pack.locale) || manifest.keys.some((key) => typeof pack.messages?.[key] !== 'string')) throw new Error('Invalid language pack')
  locale = pack.locale
  messages = pack.messages
  document.documentElement.lang = locale
}

export async function initializeLanguage() {
  const desktop = window.newWorldDesktop
  if (desktop?.getLanguage) {
    usePack(await desktop.getLanguage())
    return
  }
  const saved = cached(preference)
  const selected = isLocale(saved) ? saved : systemLocale(navigator.language)
  usePack(await webPack(selected))
  if (!isLocale(saved)) {
    try { localStorage.setItem(preference, selected) } catch { /* The browser may disallow persistent storage. */ }
  }
}

export async function changeLanguage(selected: Locale) {
  if (!isLocale(selected)) throw new Error('Unsupported language')
  const desktop = window.newWorldDesktop
  const pack = desktop?.setLanguage ? await desktop.setLanguage(selected) : await webPack(selected)
  if (!desktop?.setLanguage) localStorage.setItem(preference, selected)
  usePack(pack)
}
