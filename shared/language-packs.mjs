export const supportedLocales = ['zh-CN', 'en']

export function systemLocale(value) {
  return typeof value === 'string' && /^zh(?:-|_|$)/i.test(value) ? 'zh-CN' : 'en'
}

export function isLocale(value) {
  return supportedLocales.includes(value)
}

export function parseLanguagePack(bytes, manifest, locale) {
  if (!isLocale(locale) || bytes.byteLength !== manifest.packs[locale]?.size || bytes.byteLength > 256 * 1024) {
    throw new Error('Invalid language pack size')
  }
  const pack = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (pack.schema !== 1 || pack.locale !== locale || !pack.messages || typeof pack.messages !== 'object'
    || Object.keys(pack.messages).length !== manifest.keys.length
    || manifest.keys.some((key) => typeof pack.messages[key] !== 'string')) {
    throw new Error('Invalid language pack content')
  }
  return pack
}

export function formatMessage(messages, key, values = []) {
  return (messages[key] ?? key).replace(/\{(\d+)\}/g, (match, index) => String(values[Number(index)] ?? match))
}
