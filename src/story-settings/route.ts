import type { StoryChapter, StoryWork } from './model'

export const storyRoutePrefix = '#/story-settings/'

const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const storyRoute = new RegExp(`^#/story-settings/(original|reference)/(${uuid})(?:\\?edition=(${uuid})&chapter=(${uuid}))?$`)

export function parseStoryRoute(hash: string): (StoryWork & { chapter?: StoryChapter }) | undefined {
  const scope = storyRoute.exec(hash)
  if (!scope) return
  return {
    library: scope[1] === 'original' ? 'original' : 'reference', bookId: scope[2],
    ...(scope[3] ? { chapter: { editionId: scope[3], chapterId: scope[4] } } : {}),
  }
}

export async function openStorySettings({ library, bookId }: StoryWork, chapter: StoryChapter) {
  const hash = `${storyRoutePrefix}${library}/${bookId}?edition=${chapter.editionId}&chapter=${chapter.chapterId}`
  if (window.newWorldDesktop?.openStorySettings) return window.newWorldDesktop.openStorySettings(hash)
  window.open(new URL(hash, location.href), '_blank', 'noopener')
}
