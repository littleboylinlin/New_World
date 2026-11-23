import type { StoryChapter, StoryWork } from './model'

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

// The editor tells open story windows which chapter it shows, so new cards there can follow it.
const context = typeof BroadcastChannel === 'function' ? new BroadcastChannel('new-world-story-context') : undefined
const contextEvents = new EventTarget()
interface ChapterMessage extends StoryWork { chapter: StoryChapter }
context?.addEventListener('message', (event: MessageEvent<ChapterMessage>) => contextEvents.dispatchEvent(new CustomEvent('chapter', { detail: event.data })))

export function announceEditorChapter(work: StoryWork, chapter: StoryChapter) {
  const message: ChapterMessage = { library: work.library, bookId: work.bookId, chapter: { editionId: chapter.editionId, chapterId: chapter.chapterId } }
  context?.postMessage(message)
}

export function watchEditorChapter(work: StoryWork, change: (chapter: StoryChapter) => void, signal: AbortSignal) {
  contextEvents.addEventListener('chapter', (event) => {
    const message = (event as CustomEvent<ChapterMessage>).detail
    if (message?.library === work.library && message.bookId === work.bookId && message.chapter) change(message.chapter)
  }, { signal })
}
