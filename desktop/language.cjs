const { createHash, randomUUID } = require('node:crypto')
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { cleanLanguageCache } = require('./cleanup.cjs')
let formatMessage = (messages, key) => messages[key] ?? key

/** Where a release's language pack can be downloaded, in the order to try. */
const languagePackUrls = (version, file) => [
  `https://dl.writenewworld.com/v${version}/${file}`,
  `https://github.com/littleboylinlin/New_World/releases/download/v${version}/${file}`,
]

let activeMessages = {}
const t = (key, values) => formatMessage(activeMessages, key, values)

async function writeAtomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, value, { flag: 'wx', mode: 0o600 })
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

async function createLanguageStore({ root, manifest, request, developmentRoot }) {
  const helpers = await import('../shared/language-packs.mjs')
  const { isLocale, parseLanguagePack, systemLocale } = helpers
  formatMessage = helpers.formatMessage
  const preferences = join(root, 'language.json')
  const cache = join(root, 'packs', manifest.version)
  let current
  let changing = false

  function verify(bytes, locale) {
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.packs[locale].sha256) throw new Error('Invalid language pack checksum')
    return parseLanguagePack(bytes, manifest, locale)
  }

  async function fetchPack(url, metadata) {
    const response = await request(url, {
      redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok || !response.body) throw new Error('Language pack download failed')
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > metadata.size) {
        await response.body.cancel().catch(() => {})
        throw new Error('Language pack exceeds expected size')
      }
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  // The mirror first, which mainland China reaches quickly, then GitHub. Each copy must pass the checksum.
  async function download(metadata, locale) {
    let failure
    for (const url of languagePackUrls(manifest.version, metadata.file)) {
      try {
        const bytes = await fetchPack(url, metadata)
        verify(bytes, locale)
        return bytes
      } catch (error) {
        failure = error
      }
    }
    throw failure ?? new Error('Language pack download failed')
  }

  async function prepare(locale) {
    if (!isLocale(locale)) throw new Error('Unsupported language')
    const metadata = manifest.packs[locale]
    const file = join(cache, `${locale}.json`)
    try {
      return verify(await readFile(file), locale)
    } catch { /* Missing or damaged packs are downloaded again. */ }
    let bytes
    if (developmentRoot) {
      bytes = await readFile(join(developmentRoot, metadata.file))
    } else {
      bytes = await download(metadata, locale)
    }
    const pack = verify(bytes, locale)
    await mkdir(cache, { recursive: true })
    await writeAtomic(file, bytes)
    return pack
  }

  async function activate(locale) {
    if (changing) throw new Error('Language change in progress')
    changing = true
    try {
      const pack = await prepare(locale)
      await mkdir(root, { recursive: true })
      await writeAtomic(preferences, JSON.stringify({ locale }) + '\n')
      current = pack
      activeMessages = pack.messages
      return pack
    } finally {
      changing = false
    }
  }

  async function initialize(osLocale) {
    let locale = systemLocale(osLocale)
    try {
      const saved = JSON.parse(await readFile(preferences, 'utf8'))
      if (isLocale(saved.locale)) locale = saved.locale
    } catch { /* A first installation follows the operating system language. */ }
    return activate(locale)
  }

  return { initialize, activate, prepare, cleanup: () => cleanLanguageCache(root, manifest.version), get current() { return current } }
}

module.exports = { t, createLanguageStore, languagePackUrls }
