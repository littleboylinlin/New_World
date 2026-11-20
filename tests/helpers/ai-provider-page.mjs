import { createServer } from 'vite'
import { test as base } from '@playwright/test'

export { expect } from '@playwright/test'

export const test = base.extend({
  providerPageUrl: [async ({}, use) => {
    const server = await createServer({
      configFile: false,
      server: { host: '127.0.0.1', port: 0, hmr: false },
      plugins: [{
        name: 'provider-test-page',
        configureServer(server) {
          server.middlewares.use('/__ai-provider-test', (_request, response) => {
            response.setHeader('content-type', 'text/html')
            response.end('<!doctype html><html lang="en"><title>Test API</title></html>')
          })
        },
      }],
    })
    await server.listen()
    try {
      await use(`http://127.0.0.1:${server.httpServer.address().port}/__ai-provider-test`)
    } finally {
      await server.close()
    }
  }, { scope: 'worker' }],
})
