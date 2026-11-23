const { createProviderService } = require('../shared/ai-provider/service.mjs')
const { failureResult, ProviderFailure } = require('../shared/ai-provider/errors.mjs')
const { createDesktopProviderStore } = require('./ai-provider-store.cjs')

const methods = new Set([
  'getConfig', 'saveProfile', 'deleteProfile', 'setRouting', 'exportConfig', 'importConfig', 'testConnection', 'listModels', 'resolveProfile',
])

const storyFeatures = new Set(['extension:storyExtract', 'extension:storyCheck'])

function installAiProvider({ ipcMain, profile, safeStorage, trustedMainRenderer, trustedStoryRenderer = () => false }) {
  const service = createProviderService(createDesktopProviderStore(profile, safeStorage))
  const bySender = new WeakMap()
  const watched = new WeakSet()
  const trustedSender = (event) => trustedMainRenderer(event) || trustedStoryRenderer(event)

  function release(runs, id) {
    const run = runs?.get(id)
    if (!run) return
    runs.delete(id)
    run.controller.abort()
    void run.iterator.return().catch(() => {})
  }

  function watch(sender) {
    if (watched.has(sender)) return
    watched.add(sender)
    const clear = () => {
      const runs = bySender.get(sender)
      if (runs) for (const id of runs.keys()) release(runs, id)
    }
    sender.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) clear()
    })
    sender.on('render-process-gone', clear)
    sender.once('destroyed', clear)
  }

  ipcMain.handle('new-world:ai-provider-call', (event, method, args) => {
    const storyRead = method === 'getConfig' || (method === 'resolveProfile'
      && (storyFeatures.has(args?.[0]?.feature) || args?.[0]?.feature === 'bookSummary'))
    if (!trustedMainRenderer(event) && !(storyRead && trustedStoryRenderer(event))) return failureResult(new ProviderFailure('forbidden'))
    if (!methods.has(method) || !Array.isArray(args)) return failureResult(new ProviderFailure('invalid_config'))
    return service[method](...args)
  })

  ipcMain.handle('new-world:ai-provider-start', (event, id, request) => {
    const allowed = trustedMainRenderer(event) || (storyFeatures.has(request?.feature) && trustedStoryRenderer(event))
    if (!allowed || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return false
    const sender = event.sender
    watch(sender)
    let runs = bySender.get(sender)
    if (!runs) bySender.set(sender, runs = new Map())
    if (runs.has(id)) return false
    const controller = new AbortController()
    runs.set(id, { controller, iterator: service.generate(request, controller.signal) })
    return true
  })

  ipcMain.handle('new-world:ai-provider-next', async (event, id) => {
    if (!trustedSender(event)) return null
    const runs = bySender.get(event.sender)
    const run = runs?.get(id)
    if (!run) return null
    const { value, done } = await run.iterator.next()
    if (done || value.type !== 'delta') release(runs, id)
    return value ?? null
  })

  ipcMain.on('new-world:ai-provider-cancel', (event, id) => {
    if (trustedSender(event)) bySender.get(event.sender)?.get(id)?.controller.abort()
  })

  ipcMain.on('new-world:ai-provider-release', (event, id) => {
    if (trustedSender(event)) release(bySender.get(event.sender), id)
  })
}

module.exports = { installAiProvider }
