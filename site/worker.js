const CANONICAL_HOST = 'writenewworld.com'

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
