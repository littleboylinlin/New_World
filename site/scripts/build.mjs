import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { LICENSE_URL, RELEASES_URL, REPO_URL, SITE_URL, WEB_APP_URL } from '../config.mjs'
import { latestRelease } from './latest.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = `${root}src/`
const dist = `${root}dist/`

const exists = (path) => stat(path).then(() => true, () => false)
const text = (name) => readFile(`${src}${name}`, 'utf-8')

const latest = await latestRelease()
await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

const [style, langScript, icon] = await Promise.all([text('styles.css'), text('lang.js'), readFile(`${src}icon-64.png`)])
const data = { latest, webAppUrl: WEB_APP_URL }
const values = {
  STYLE: style,
  LANG_SCRIPT: langScript,
  DATA: JSON.stringify(data).replaceAll('<', '\\u003c'),
  ICON_DATA: `data:image/png;base64,${icon.toString('base64')}`,
  SITE_URL,
  REPO_URL,
  RELEASES_URL,
  RELEASE_URL: latest.releaseUrl,
  LICENSE_URL,
  WEB_APP_URL,
  VERSION: latest.version,
  YEAR: String(new Date().getUTCFullYear()),
}
const fill = (template) => template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
  if (!(key in values)) throw new Error(`Unknown placeholder ${match}`)
  return values[key]
})

for (const page of ['index.html', 'notice.html', '404.html', 'robots.txt']) {
  await writeFile(`${dist}${page}`, fill(await text(page)))
}
await Promise.all([
  cp(`${src}main.js`, `${dist}main.js`),
  cp(`${src}icon-64.png`, `${dist}icon-64.png`),
  cp(`${src}og.png`, `${dist}og.png`),
  cp(`${root}../public/app-icon.png`, `${dist}app-icon.png`),
  writeFile(`${dist}latest.json`, `${JSON.stringify(latest, null, 2)}\n`),
  writeFile(`${dist}sitemap.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE_URL}/</loc></url></urlset>\n`),
])

// The deploy workflow builds the App's web version first; local builds skip it.
const appDist = process.env.APP_DIST
if (appDist) {
  if (!await exists(`${appDist}/index.html`)) throw new Error(`APP_DIST has no index.html: ${appDist}`)
  await cp(appDist, `${dist}${WEB_APP_URL.replace(/^\/|\/$/g, '')}`, { recursive: true })
}

console.log(`Built site for ${latest.tag}${appDist ? ' with the web app' : ''}`)
