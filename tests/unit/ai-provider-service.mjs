import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDesktopProviderStore } from '../../desktop/ai-provider-store.cjs'
import { installAiProvider } from '../../desktop/ai-provider.cjs'
import { createProviderService } from '../../shared/ai-provider/service.mjs'
import { fakeAiService, fakeText } from '../helpers/fake-ai.mjs'

// The app supplies Electron safeStorage. Simulate its interface for tests without an OS keychain.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0xa7)),
  decryptString: (bytes) => Buffer.from([...bytes].map((byte) => byte ^ 0xa7)).toString(),
}

const config = { name: 'Local', protocol: 'openai-chat', baseUrl: 'https://first.invalid/v1', auth: { kind: 'bearer' } }
const messages = [{ role: 'user', text: 'chapter' }]

async function setup(t, settings = safeStorage) {
  const profile = await mkdtemp(join(tmpdir(), 'new-world-providers-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const fake = await fakeAiService()
  t.after(fake.close)
  const store = createDesktopProviderStore(profile, settings)
  return { service: createProviderService(store), store, profile, fake }
}

test('desktop config writes are atomic, export strips secrets, and feature routing is explicit', async (t) => {
  const { service, profile, fake } = await setup(t)
  const header = { name: 'X-Relay-Secret', secretRef: 'relay' }
  const saved = await Promise.all([
    service.saveProfile({
      config: { ...config, baseUrl: fake.url, headers: [header], apiKey: 'not-a-config-field' },
      credentials: { apiKey: 'private-key-123', headerSecrets: { relay: 'private-extra-456' } },
    }),
    service.saveProfile({ config: { ...config, baseUrl: fake.url, model: 'example', name: 'Other', auth: { kind: 'none' } } }),
  ])
  assert.ok(saved.every((item) => item.ok))
  const [first, second] = saved.map((item) => item.data.id)
  const disk = await readFile(join(profile, 'NewWorld-ai-providers.json'), 'utf8')
  assert.doesNotMatch(disk, /private-key-123|private-extra-456|not-a-config-field/)
  assert.equal(saved[0].data.hasApiKey, true)
  assert.deepEqual(saved[0].data.savedSecretRefs, ['relay'])
  const bound = await service.setRouting({ defaultProfileId: second, byFeature: { proofread: first, 'extension:translate': second } })
  assert.equal(bound.ok, true)
  const file = (await service.exportConfig()).data
  assert.doesNotMatch(JSON.stringify(file), /private-key-123|private-extra-456|hasApiKey|rememberCredentials/)
  assert.deepEqual(file.profiles[0].config.headers, [header])

  const imported = await service.importConfig(file)
  assert.equal(imported.ok, true)
  assert.notEqual(imported.data.profiles[0].id, first)
  assert.equal(imported.data.routing.byFeature.proofread, imported.data.profiles[0].id)
  assert.equal((await service.getConfig()).data.routing.byFeature.proofread, first)
  assert.equal((await service.importConfig({ ...file, profiles: [...file.profiles, file.profiles[0]] })).ok, false)
  assert.equal((await service.getConfig()).data.profiles.length, 4)
  const request = { messages, feature: 'extension:translate' }
  assert.equal((await Array.fromAsync(service.generate(request, new AbortController().signal))).at(-1).text, fakeText)
  await service.deleteProfile(first)
  assert.equal((await service.getConfig()).data.routing.byFeature.proofread, null)
  const disabled = await Array.fromAsync(service.generate({ ...request, feature: 'proofread' }, new AbortController().signal))
  assert.equal(disabled[0].error.code, 'not_configured')
})

test('drafts can reuse same-origin credentials and switching origins clears credentials', async (t) => {
  const { service, fake } = await setup(t)
  const draft = { ...config, baseUrl: fake.url, model: 'example' }
  const { data } = await service.saveProfile({ config: draft, credentials: { apiKey: 'draft-secret' } })
  const connected = await service.testConnection({ draft, reuseCredentialsFrom: data.id }, { stream: false })
  assert.equal(connected.ok, true)
  assert.equal(fake.requests[0].headers.authorization, 'Bearer draft-secret')
  const refused = await service.testConnection({ draft: config, reuseCredentialsFrom: data.id }, { stream: false })
  assert.equal(refused.error.code, 'invalid_config')
  const moved = await service.saveProfile({ id: data.id, config })
  assert.equal(moved.data.hasApiKey, false)
})

test('a missing keychain returns a typed error without saving the key', async (t) => {
  const { service } = await setup(t, { ...safeStorage, isEncryptionAvailable: () => false })
  const result = await service.saveProfile({ config, credentials: { apiKey: 'not-written' } })
  assert.equal(result.error.code, 'keychain_unavailable')
  assert.deepEqual((await service.getConfig()).data.profiles, [])
})

test('IPC rejects foreign frames, isolates runs and cancels outstanding requests on navigation', async (t) => {
  const { profile, fake } = await setup(t)
  const handlers = new Map()
  const events = new Map()
  const ipcMain = { handle: (key, fn) => handlers.set(key, fn), on: (key, fn) => events.set(key, fn) }
  const sender = new EventEmitter()
  const trusted = { sender }
  installAiProvider({ ipcMain, profile, safeStorage, trustedMainRenderer: (event) => event === trusted })
  const invoke = (action, ...args) => handlers.get('new-world:ai-provider-' + action)(trusted, ...args)
  assert.equal(handlers.get('new-world:ai-provider-call')({ sender }, 'getConfig', []).error.code, 'forbidden')
  const { data } = await invoke('call', 'saveProfile', [{
    config: { ...config, baseUrl: fake.url + '/hang/v1', auth: { kind: 'none' }, model: 'example' },
  }])
  const id = crypto.randomUUID()
  assert.equal(invoke('start', id, { feature: 'ask', profileId: data.id, messages }), true)
  assert.equal((await invoke('next', id)).type, 'delta')
  const next = invoke('next', id)
  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  assert.equal((await next).type, 'cancelled')
  assert.equal(await invoke('next', id), null)
  assert.ok(events.has('new-world:ai-provider-cancel'))
})
