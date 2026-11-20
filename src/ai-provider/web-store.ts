import { credentialInfo, emptyState } from '../../shared/ai-provider/service.mjs'
import type { ProviderStore, StoredProfile, StoredState, Vault } from '../../shared/ai-provider/service.mjs'
import type { Credentials } from '../../shared/ai-provider/types.mjs'

import { configStore, localTransaction } from './local-db'

type SessionKey = { revision: string; credentials: Credentials }

function sessionVault(session: Map<string, SessionKey>): Vault<Credentials> {
  function read(profile: StoredProfile<Credentials>): Credentials {
    if (profile.rememberCredentials) return profile.credentialEntry ?? {}
    const entry = session.get(profile.id)
    return entry?.revision === profile.revision ? entry.credentials : {}
  }
  return {
    read,
    info: (profile) => credentialInfo(read(profile)),
    write(profile, credentials) {
      session.delete(profile.id)
      if (!Object.keys(credentials).length) return
      if (profile.rememberCredentials) profile.credentialEntry = credentials
      else session.set(profile.id, { revision: profile.revision, credentials })
    },
    remove: (profile) => { session.delete(profile.id) },
  }
}

export function createWebStore(): ProviderStore<Credentials> {
  let memory = new Map<string, SessionKey>()
  let pending: Promise<unknown> = Promise.resolve()

  function access<T>(mode: 'readonly' | 'readwrite', work: (state: StoredState<Credentials>, vault: Vault<Credentials>) => T): Promise<T> {
    const task = pending.then(async () => {
      const staged = new Map(memory)
      const value = await localTransaction<T>(configStore, mode, (store, finish, fail) => {
        const request = store.get('state')
        request.onsuccess = () => {
          try {
            const state: StoredState<Credentials> = request.result ?? emptyState()
            for (const [id, entry] of staged) {
              if (!state.profiles.some((profile) => profile.id === id && profile.revision === entry.revision)) staged.delete(id)
            }
            const result = work(state, sessionVault(staged))
            if (mode === 'readwrite') store.put(state, 'state')
            finish(result)
          } catch (error) {
            fail(error)
          }
        }
      })
      memory = staged
      return value
    })
    pending = task.catch(() => {})
    return task
  }

  return {
    kind: 'web',
    read: (operation) => access('readonly', operation),
    update: (operation) => access('readwrite', operation),
  }
}
