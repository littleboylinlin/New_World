import { failureResult, invalid, ProviderFailure } from '../../shared/ai-provider/errors.mjs'
import { chapterCacheKey, splitChapterText } from '../../shared/ai-provider/summary.mjs'
import type { ChapterSummaryPlan, ProviderMethods, ResolvedProfile, Result, Route, SummaryApi } from '../../shared/ai-provider/types.mjs'
import { localTransaction, summaryStore } from './local-db'

const epochKey = 'epoch'
const firstEpoch = 'initial'
const writeToken = /^([a-f0-9]{64}):(initial|[a-f0-9-]{36})$/

function withEpoch<T>(
  mode: IDBTransactionMode, work: (store: IDBObjectStore, epoch: string, finish: (value: T) => void) => void,
): Promise<T> {
  return localTransaction(summaryStore, mode, (store, finish, fail) => {
    const request = store.get(epochKey)
    request.onsuccess = () => {
      try {
        work(store, request.result ?? firstEpoch, finish)
      } catch (error) {
        fail(error)
      }
    }
  })
}

function findSummary(key: string): Promise<{ summary?: string; epoch: string }> {
  return withEpoch('readonly', (store, epoch, finish) => {
    const request = store.get(key)
    request.onsuccess = () => finish({ summary: request.result, epoch })
  })
}

export function createSummaryApi(resolveProfile: ProviderMethods['resolveProfile']): SummaryApi {
  async function withProfile<T>(request: Route, action: (profile: ResolvedProfile) => T | Promise<T>): Promise<Result<T>> {
    try {
      const { feature, profileId, expectedProfileRevision } = request
      const resolved = await resolveProfile({ feature, profileId, expectedProfileRevision })
      if (!resolved.ok) return resolved
      return { ok: true, data: await action(resolved.data) }
    } catch (error) {
      return failureResult(error)
    }
  }

  return {
    splitText: (request) => withProfile(request, ({ config }) => splitChapterText(config, request)),

    prepareChapterSummary: (request) => withProfile<ChapterSummaryPlan>(request, async ({ id, revision, config }) => {
      const key = await chapterCacheKey(config, request.text, request.promptVersion)
      const { summary, epoch } = await findSummary(key)
      if (summary !== undefined) return { hit: true, summary }
      return {
        hit: false,
        cacheToken: `${key}:${epoch}`,
        route: { feature: request.feature, profileId: id, expectedProfileRevision: revision },
        chunks: splitChapterText(config, request),
      }
    }),

    readCachedBookSummaries: (request) => withProfile(request, async ({ config }) => {
      const chapterKeys: string[] = []
      for (const text of request.chapters) chapterKeys.push(await chapterCacheKey(config, text, request.chapterPromptVersion))
      const bookKey = await chapterCacheKey(config, JSON.stringify([request.bookTitle, chapterKeys]), request.bookPromptVersion)
      return withEpoch('readonly', (store, epoch, finish) => {
        const chapters = chapterKeys.map((key) => store.get(key))
        const book = store.get(bookKey)
        book.onsuccess = () => finish({
          chapters: chapters.map(({ result }) => result as string | undefined),
          book: book.result,
          bookCacheToken: `${bookKey}:${epoch}`,
        })
      })
    }),

    async saveChapterSummary(cacheToken, summary) {
      try {
        const token = typeof cacheToken === 'string' && writeToken.exec(cacheToken)
        if (!token || typeof summary !== 'string') invalid('Provide a chapter summary and its cache token.')
        const [, key, expectedEpoch] = token
        await withEpoch<void>('readwrite', (store, epoch, finish) => {
          if (epoch !== expectedEpoch) throw new ProviderFailure('cache_token_expired')
          store.put(summary, key)
          finish()
        })
        return { ok: true, data: undefined }
      } catch (error) {
        return failureResult(error)
      }
    },

    async clearSummaryCache() {
      try {
        await localTransaction<void>(summaryStore, 'readwrite', (store, finish) => {
          store.clear()
          store.put(crypto.randomUUID(), epochKey)
          finish()
        })
        return { ok: true, data: undefined }
      } catch (error) {
        return failureResult(error)
      }
    },
  }
}
