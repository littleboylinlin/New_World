// What the web pane's address bar does with what is typed: a web address opens as it is, anything
// else is searched with the engine chosen in Settings. Nothing typed is remembered.

export const searchEngines = {
  bing: { name: '必应 Bing', url: 'https://www.bing.com/search?q=' },
  baidu: { name: '百度', url: 'https://www.baidu.com/s?wd=' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
} as const

export type SearchEngine = keyof typeof searchEngines

const engineKey = 'new-world:web-search'
const linkKey = 'new-world:web-keep-link'

export function readSearchEngine(): SearchEngine {
  try {
    const value = localStorage.getItem(engineKey)
    if (value && Object.hasOwn(searchEngines, value)) return value as SearchEngine
  } catch { /* Falls back to the default. */ }
  return 'bing'
}

export function saveSearchEngine(engine: SearchEngine) {
  try { localStorage.setItem(engineKey, engine) } catch { /* Only a convenience. */ }
}

/** Whether a kept passage carries the page's address; off until the writer turns it on. */
export function readKeepLink() {
  try { return localStorage.getItem(linkKey) === '1' } catch { return false }
}

export function saveKeepLink(on: boolean) {
  try { localStorage.setItem(linkKey, on ? '1' : '0') } catch { /* Only a convenience. */ }
}

export const isWebUrl = (value: string) => {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch { return false }
}

const scheme = /^[a-z][a-z0-9+.-]*:/i
const local = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i
const domain = /^[^\s/?#]+\.[a-z¡-￿]{2,}(:\d+)?([/?#].*)?$/i

/**
 * Turns what was typed into the page to open. Other schemes (file:, javascript:, app links) are
 * refused rather than searched, so they can never be opened by typing them.
 */
export function addressFor(input: string, engine = readSearchEngine()): { url: string } | { blocked: string } | undefined {
  const text = input.trim()
  if (!text) return undefined
  if (scheme.test(text) && !/^[^\s:]+:\d+(\/|$)/.test(text)) {
    return isWebUrl(text) ? { url: new URL(text).href } : { blocked: text }
  }
  if (!/\s/.test(text) && local.test(text)) return { url: new URL(`http://${text}`).href }
  if (!/\s/.test(text) && domain.test(text)) {
    try { return { url: new URL(`https://${text}`).href } } catch { /* Searched instead. */ }
  }
  return { url: searchEngines[engine].url + encodeURIComponent(text) }
}
