const { createHash, randomUUID } = require('node:crypto')
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { cleanLanguageCache } = require('./cleanup.cjs')
let formatMessage = (messages, key) => messages[key] ?? key

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
      const response = await request(`https://github.com/littleboylinlin/New_World/releases/download/v${manifest.version}/${metadata.file}`, {
        redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30_000),
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
      bytes = Buffer.concat(chunks)
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

module.exports = { t, createLanguageStore }
