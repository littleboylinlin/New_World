import type { StoryWork } from './model'

const changes = new EventTarget()
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('new-world-story-settings') : undefined

function receive(work?: StoryWork) {
  changes.dispatchEvent(new CustomEvent('change', { detail: work }))
}

export function announceStoryChange(work?: StoryWork) {
  const scope = work && { library: work.library, bookId: work.bookId }
  receive(scope)
  channel?.postMessage(scope)
}

channel?.addEventListener('message', (event: MessageEvent<StoryWork | undefined>) => receive(event.data))

export function watchStoryChanges(work: StoryWork | undefined, refresh: () => void, signal: AbortSignal) {
  changes.addEventListener('change', (event) => {
    const changed = (event as CustomEvent<StoryWork | undefined>).detail
    if (!work || !changed || (changed.library === work.library && changed.bookId === work.bookId)) refresh()
  }, { signal })
}
