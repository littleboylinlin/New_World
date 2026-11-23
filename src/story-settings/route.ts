import type { StoryChapter, StoryWork } from './model'

export const storyRoutePrefix = '#/story-settings/'

const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const cardQuery = 'card=([a-zA-Z0-9%*+._-]{1,2300})'
const storyRoutePattern = new RegExp(`^#/story-settings/(original|reference)/(${uuid})(?:\\?edition=(${uuid})&chapter=(${uuid})(?:&${cardQuery})?|\\?${cardQuery})?$`)

export function parseStoryRoute(hash: string): (StoryWork & { chapter?: StoryChapter; cardId?: string }) | undefined {
  const scope = storyRoutePattern.exec(hash)
  if (!scope) return
  const encodedCard = scope[5] ?? scope[6]
  const cardId = encodedCard ? new URLSearchParams(`card=${encodedCard}`).get('card') : null
  if (cardId && (cardId.length > 255 || /[\x00-\x1f]/.test(cardId))) return
  return {
    library: scope[1] === 'original' ? 'original' : 'reference', bookId: scope[2],
    ...(scope[3] ? { chapter: { editionId: scope[3], chapterId: scope[4] } } : {}),
    ...(cardId ? { cardId } : {}),
  }
}

export function storyRoute({ library, bookId }: StoryWork, chapter?: StoryChapter, cardId?: string) {
  const query = new URLSearchParams()
  if (chapter) { query.set('edition', chapter.editionId); query.set('chapter', chapter.chapterId) }
  if (cardId) query.set('card', cardId)
  return `${storyRoutePrefix}${library}/${bookId}${query.size ? `?${query}` : ''}`
}

/**
 * Opens the work's story settings, or brings back the window already showing them. On the web the
 * tab is named after the work, so the editor reuses it instead of opening one per click.
 */
export async function openStorySettings(work: StoryWork, chapter?: StoryChapter, cardId?: string) {
  const hash = storyRoute(work, chapter, cardId)
  if (window.newWorldDesktop?.openStorySettings) return window.newWorldDesktop.openStorySettings(hash)
  window.open(new URL(hash, location.href), `new-world-story-${work.library}-${work.bookId}`)?.focus()
}

/** A new story window can have another story window as its immediate opener. */
export function storyEditorWindow() {
  try {
    let opener: Window | null = window.opener
    while (opener && !opener.closed && opener.location.origin === location.origin) {
      if (!opener.location.hash.startsWith(storyRoutePrefix)) return opener
      opener = opener.opener
    }
  } catch { /* The opener may have navigated away. */ }
}
