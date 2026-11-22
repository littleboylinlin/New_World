import type { StoryWork } from './model'

export const storyRoutePrefix = '#/story-settings/'

export function parseStoryRoute(hash: string): StoryWork | undefined {
  const scope = /^#\/story-settings\/(original|reference)\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.exec(hash)
  if (!scope) return
  return { library: scope[1] === 'original' ? 'original' : 'reference', bookId: scope[2] }
}

export async function openStorySettings({ library, bookId }: StoryWork) {
  const hash = `${storyRoutePrefix}${library}/${bookId}`
  if (window.newWorldDesktop?.openStorySettings) return window.newWorldDesktop.openStorySettings(hash)
  window.open(new URL(hash, location.href), '_blank', 'noopener')
}
