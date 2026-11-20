import { createProviderClient } from './client.mjs'
import { isRecord, nonempty, parseBaseUrl, validateCredentialPatch, validateProfile } from './config.mjs'
import { failureResult, invalid, ProviderFailure, publicError } from './errors.mjs'

const format = 'new-world-ai-providers'
const builtinFeatures = ['ask', 'polish', 'proofread', 'bookSummary']
const credentialHeaders = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'x-goog-api-key', 'api-key'])
const profileFields = ['name', 'protocol', 'baseUrl', 'model', 'extraBody', 'stream', 'timeoutMs', 'retries', 'anthropicDirectBrowserAccess']

function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(object, key) && object[key] !== undefined).map((key) => [key, object[key]]))
}

function cleanConfig(input) {
  validateProfile(input)
  const config = pick(input, profileFields)
  const { auth } = input
  config.auth = auth.kind === 'header' ? pick(auth, ['kind', 'name', 'prefix'])
    : auth.kind === 'query' ? { kind: auth.kind, name: auth.name } : { kind: auth.kind }
  if (input.paths) config.paths = pick(input.paths, ['generate', 'stream', 'models'])
  if (input.generation) config.generation = pick(input.generation, [
    'temperature', 'topP', 'maxOutputTokens', 'contextTokens', 'reasoningEffort', 'thinkingBudgetTokens',
  ])
  if (input.headers) {
    config.headers = input.headers.map((header) => {
      if (Object.hasOwn(header, 'secretRef')) return pick(header, ['name', 'secretRef'])
      if (credentialHeaders.has(header.name.toLowerCase()) || (
        input.auth.kind === 'header' && header.name.toLowerCase() === input.auth.name.toLowerCase()
      )) {
        invalid('Save authentication header values as credentials or secret references.')
      }
      return pick(header, ['name', 'value'])
    })
  }
  if (input.auth.kind === 'query') {
    const name = input.auth.name
    const urls = [parseBaseUrl(config.baseUrl), ...Object.values(config.paths ?? {}).map((path) => new URL(path, config.baseUrl))]
    if (urls.some((url) => url.searchParams.has(name))) invalid('Save the authentication query value as an API key.')
  }
  return structuredClone(config)
}

export function emptyState() {
  return { profiles: [], routing: { defaultProfileId: null, byFeature: {} } }
}

export function credentialInfo(credentials) {
  return { hasApiKey: Boolean(credentials.apiKey), savedSecretRefs: Object.keys(credentials.headerSecrets ?? {}) }
}

function validFeature(value) {
  return typeof value === 'string' && (builtinFeatures.includes(value) || /^extension:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value))
}

function routingFrom(value, ids) {
  if (!isRecord(value) || !isRecord(value.byFeature)
    || (value.defaultProfileId !== null && !ids.has(value.defaultProfileId))) invalid('Select an available default AI profile.')
  for (const [feature, profileId] of Object.entries(value.byFeature)) {
    if (!validFeature(feature) || (profileId !== null && !ids.has(profileId))) invalid('Select valid feature and AI profile bindings.')
  }
  return { defaultProfileId: value.defaultProfileId, byFeature: { ...value.byFeature } }
}

function getProfile(state, id) {
  const profile = state.profiles.find((item) => item.id === id)
  if (!profile) throw new ProviderFailure('not_configured')
  return profile
}

function resolveRoute(state, route) {
  if (!isRecord(route) || !validFeature(route.feature)
    || (route.profileId !== undefined && !nonempty(route.profileId))
    || (route.expectedProfileRevision !== undefined && !nonempty(route.expectedProfileRevision))) {
    invalid('Select a valid AI feature and profile.')
  }
  const feature = state.routing.byFeature[route.feature]
  const profile = getProfile(state, route.profileId ?? (feature === undefined ? state.routing.defaultProfileId : feature))
  if (route.expectedProfileRevision !== undefined && route.expectedProfileRevision !== profile.revision) {
    throw new ProviderFailure('profile_changed')
  }
  return profile
}

function applyCredentials(previous, patch) {
  validateCredentialPatch(patch)
  const apiKey = patch?.apiKey === undefined ? previous.apiKey : patch.apiKey
  const headers = { ...previous.headerSecrets, ...patch?.headerSecrets }
  const headerSecrets = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== null))
  return {
    ...(apiKey === undefined || apiKey === null ? {} : { apiKey }),
    ...(Object.keys(headerSecrets).length ? { headerSecrets } : {}),
  }
}

function sameOrigin(a, b) {
  return parseBaseUrl(a.baseUrl).origin === parseBaseUrl(b.baseUrl).origin
}

function resolveConnection(state, vault, target) {
  if (!isRecord(target)) invalid('Select an AI profile or provide a draft.')
  if (Object.hasOwn(target, 'profileId')) {
    const profile = getProfile(state, target.profileId)
    return { config: profile.config, credentials: vault.read(profile) }
  }
  const config = cleanConfig(target.draft)
  let previous = {}
  if (target.reuseCredentialsFrom !== undefined) {
    const profile = getProfile(state, target.reuseCredentialsFrom)
    if (!sameOrigin(profile.config, config)) invalid('Enter credentials for the new AI service origin.')
    previous = vault.read(profile)
  }
  return { config, credentials: applyCredentials(previous, target.credentials) }
}

function publicProfile({ id, config, rememberCredentials }, info) {
  return { id, config, rememberCredentials, ...info }
}

function configFile(state) {
  return { format, version: 1, profiles: state.profiles.map(({ id, config }) => ({ id, config })), routing: state.routing }
}

async function result(operation) {
  try {
    return { ok: true, data: await operation() }
  } catch (error) {
    return failureResult(error)
  }
}

export function createProviderService(store, client = createProviderClient()) {
  const system = store.kind === 'system'

  return {
    getConfig: () => result(() => store.read((state, vault) => ({
      ...configFile(state),
      credentialStorage: store.kind,
      profiles: state.profiles.map((profile) => publicProfile(profile, vault.info(profile))),
    }))),

    saveProfile: (input) => result(() => store.update((state, vault) => {
      if (!isRecord(input) || (input.rememberCredentials !== undefined && typeof input.rememberCredentials !== 'boolean')) {
        invalid('Provide a valid AI profile and credential storage setting.')
      }
      const config = cleanConfig(input.config)
      const previous = input.id === undefined ? undefined : getProfile(state, input.id)
      const profile = {
        id: previous?.id ?? crypto.randomUUID(),
        revision: crypto.randomUUID(),
        config,
        rememberCredentials: system || (input.rememberCredentials ?? previous?.rememberCredentials ?? false),
      }
      const credentials = applyCredentials(previous && sameOrigin(previous.config, config) ? vault.read(previous) : {}, input.credentials)
      vault.write(profile, credentials)
      if (previous) state.profiles[state.profiles.indexOf(previous)] = profile
      else state.profiles.push(profile)
      return publicProfile(profile, credentialInfo(credentials))
    })),

    deleteProfile: (id) => result(() => store.update((state, vault) => {
      const profile = getProfile(state, id)
      state.profiles.splice(state.profiles.indexOf(profile), 1)
      vault.remove(profile)
      if (state.routing.defaultProfileId === id) state.routing.defaultProfileId = null
      for (const feature of Object.keys(state.routing.byFeature)) {
        if (state.routing.byFeature[feature] === id) state.routing.byFeature[feature] = null
      }
    })),

    setRouting: (routing) => result(() => store.update((state) => {
      state.routing = routingFrom(routing, new Set(state.profiles.map((profile) => profile.id)))
    })),

    exportConfig: () => result(() => store.read(configFile)),

    importConfig: (file) => result(() => store.update((state) => {
      if (!isRecord(file) || file.format !== format || file.version !== 1 || !Array.isArray(file.profiles)) {
        invalid('Choose a supported New World AI configuration file.')
      }
      const ids = new Map()
      const profiles = file.profiles.map((entry) => {
        if (!isRecord(entry) || !nonempty(entry.id) || ids.has(entry.id)) invalid('AI profile IDs in the file must be unique.')
        const profile = {
          id: crypto.randomUUID(),
          revision: crypto.randomUUID(),
          config: cleanConfig(entry.config),
          rememberCredentials: system,
        }
        ids.set(entry.id, profile.id)
        return profile
      })
      const original = routingFrom(file.routing, ids)
      const remap = (id) => id === null ? null : ids.get(id)
      const routing = {
        defaultProfileId: remap(original.defaultProfileId),
        byFeature: Object.fromEntries(Object.entries(original.byFeature).map(([feature, id]) => [feature, remap(id)])),
      }
      state.profiles.push(...profiles)
      return { profiles: profiles.map((profile) => publicProfile(profile, credentialInfo({}))), routing }
    })),

    async *generate(request, signal) {
      try {
        if (!signal.aborted) {
          const target = await store.read((state, vault) => {
            const profile = resolveRoute(state, request)
            return { config: profile.config, credentials: vault.read(profile) }
          })
          if (!signal.aborted) {
            yield* client.generate(target, request, signal)
            return
          }
        }
        yield { type: 'cancelled' }
      } catch (error) {
        yield signal.aborted ? { type: 'cancelled' } : { type: 'error', error: publicError(error) }
      }
    },

    async testConnection(target, options) {
      try {
        const resolved = await store.read((state, vault) => resolveConnection(state, vault, target))
        return await client.testConnection(resolved, options?.stream)
      } catch (error) {
        return failureResult(error)
      }
    },

    async listModels(target, cursor) {
      try {
        const resolved = await store.read((state, vault) => resolveConnection(state, vault, target))
        return await client.listModels(resolved, cursor)
      } catch (error) {
        return failureResult(error)
      }
    },
  }
}
