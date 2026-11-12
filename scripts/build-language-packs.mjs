import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { supportedLocales } from '../shared/language-packs.mjs'

const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const manifest = { schema: 1, version, keys: [], packs: {} }
await mkdir('public/locales', { recursive: true })
const placeholders = (message) => [...new Set(message.match(/\{\d+\}/g) ?? [])].sort().join(',')
let reference
for (const locale of supportedLocales) {
  const messages = JSON.parse(await readFile(`locales/${locale}.json`, 'utf8'))
  const keys = Object.keys(messages).sort()
  if (reference && (keys.join('\n') !== manifest.keys.join('\n')
    || keys.some((key) => typeof messages[key] !== 'string' || placeholders(messages[key]) !== placeholders(reference[key])))) {
    throw new Error(`Language keys or placeholders do not match: ${locale}`)
  }
  reference ??= messages
  manifest.keys = keys
  const file = `New-World-lang-${locale}.json`
  const bytes = Buffer.from(JSON.stringify({ schema: 1, locale, messages }) + '\n')
  if (bytes.length > 256 * 1024) throw new Error(`Language pack is too large: ${locale}`)
  manifest.packs[locale] = { file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  await writeFile(`public/locales/${file}`, bytes)
}
await writeFile('public/locales/manifest.json', JSON.stringify(manifest, null, 2) + '\n')
console.log(`Built ${supportedLocales.length} independent language packs for v${version}`)
