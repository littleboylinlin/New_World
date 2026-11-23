import type { StoryChapter, StoryWork } from './model'

export const storyRoutePrefix = '#/story-settings/'

const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const storyRoutePattern = new RegExp(`^#/story-settings/(original|reference)/(${uuid})(?:\\?edition=(${uuid})&chapter=(${uuid}))?$`)

export function parseStoryRoute(hash: string): (StoryWork & { chapter?: StoryChapter }) | undefined {
  const scope = storyRoutePattern.exec(hash)
  if (!scope) return
  return {
    library: scope[1] === 'original' ? 'original' : 'reference', bookId: scope[2],
    ...(scope[3] ? { chapter: { editionId: scope[3], chapterId: scope[4] } } : {}),
  }
}

export function storyRoute({ library, bookId }: StoryWork, chapter?: StoryChapter) {
  return `${storyRoutePrefix}${library}/${bookId}${chapter ? `?edition=${chapter.editionId}&chapter=${chapter.chapterId}` : ''}`
}

/**
 * Opens the work's story settings, or brings back the window already showing them. On the web the
 * tab is named after the work, so the editor reuses it instead of opening one per click.
 */
export async function openStorySettings(work: StoryWork, chapter: StoryChapter) {
  const hash = storyRoute(work, chapter)
  if (window.newWorldDesktop?.openStorySettings) return window.newWorldDesktop.openStorySettings(hash)
  window.open(new URL(hash, location.href), `new-world-story-${work.library}-${work.bookId}`)?.focus()
}
