const CANONICAL_HOST = 'writenewworld.com'

// /download/<platform> sends a visitor to the current release's file: visitors in mainland China
// (Cloudflare's request.cf.country, nothing else) to the mirror on dl.writenewworld.com, everyone
// else to GitHub Releases. ?from=mirror or ?from=github picks the source instead. Nothing about the
// visitor is logged or stored.
const MIRROR = 'https://dl.writenewworld.com/'
const GITHUB_DOWNLOADS = 'https://github.com/littleboylinlin/New_World/releases/download/'
const RELEASES = 'https://github.com/littleboylinlin/New_World/releases'
const PLATFORMS = {
  windows: 'windows-x64',
  'windows-online': 'windows-x64-online',
  'macos-arm64': 'macos-arm64',
  'macos-x64': 'macos-x64',
  'lang-zh-CN': 'lang-zh-CN',
  'lang-en': 'lang-en',
}
const STABLE_TAG = /^v\d+\.\d+\.\d+$/
const FILE_NAME = /^New-World-[A-Za-z0-9.-]+\.(exe|dmg|json)$/

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.hostname === `www.${CANONICAL_HOST}`) {
      url.hostname = CANONICAL_HOST
      return Response.redirect(url.toString(), 301)
    }
    if (url.pathname === '/download' || url.pathname.startsWith('/download/')) return download(request, env, url)
    const response = await env.ASSETS.fetch(request)
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
    if (url.pathname === '/latest.json') {
      headers.set('Cache-Control', 'public, max-age=300')
      headers.set('Access-Control-Allow-Origin', '*')
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
}

/** Where a release file lives on each source, or nothing when latest.json does not name it. */
export function downloadTargets(latest, key) {
  const asset = latest?.assets?.[key]
  const tag = latest?.tag
  if (!asset || typeof tag !== 'string' || !STABLE_TAG.test(tag) || typeof asset.name !== 'string' || !FILE_NAME.test(asset.name)) return undefined
  const github = `${GITHUB_DOWNLOADS}${tag}/${asset.name}`
  // latest.json's own link is used when it is the same GitHub file; anything else is ignored.
  return { mirror: `${MIRROR}${tag}/${asset.name}`, github: asset.url === github ? asset.url : github }
}

/** Which source a request goes to: the one asked for, else the mirror for mainland China only. */
export function pickSource(request, url) {
  const asked = url.searchParams.get('from')
  if (asked === 'mirror' || asked === 'github') return asked
  return request.cf?.country === 'CN' ? 'mirror' : 'github'
}

async function download(request, env, url) {
  const key = PLATFORMS[url.pathname.slice('/download/'.length).replace(/\/$/, '')]
  let latest
  if (key) {
    try {
      const response = await env.ASSETS.fetch(new Request(new URL('/latest.json', url)))
      if (response.ok) latest = await response.json()
    } catch { /* Treated as nothing to download. */ }
  }
  const targets = key && downloadTargets(latest, key)
  if (!targets) return notFound()
  const headers = new Headers({ Location: targets[pickSource(request, url)], 'Cache-Control': 'no-store' })
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
  return new Response(null, { status: 302, headers })
}

function notFound() {
  const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>没有找到这个下载 · New World</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.7 system-ui,sans-serif;color:#1d1a17;background:#fbf7ef}
main{max-width:34rem;padding:32px 24px}h1{font-size:1.4rem;margin:0 0 8px}p{margin:0 0 10px;color:#5c554d}a{color:#c8261c}</style></head>
<body><main>
<h1>当前版本没有这个下载</h1>
<p>这个平台的安装包或语言包在最新版本里暂时没有。可以在 <a href="${RELEASES}">全部版本</a> 里找，或回到 <a href="/">首页</a>。</p>
<p lang="en">This download isn't part of the latest release. Look in <a href="${RELEASES}">all releases</a>, or go back to the <a href="/">home page</a>.</p>
</main></body></html>
`
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
  return new Response(page, { status: 404, headers })
}
