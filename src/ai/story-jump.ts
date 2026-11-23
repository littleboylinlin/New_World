import { t } from '../i18n'
import type { StoryWork } from '../story-settings/model'
import { storyEditorWindow, storyRoutePrefix } from '../story-settings/route'
import { bookPath, element } from '../ui'
import type { StoryConflict } from './story-analysis'
import type { StoryAnchor, StorySource } from './story-manuscript'
import { storyQuoteOffsets } from './story-manuscript'

export interface StoryJump extends StoryWork {
  chapterId: string
  chapterTitle: string
  anchor: StoryAnchor
  previewSection?: number
  fix?: { replacement: string; reason: string; profileName: string }
}

const jumpKey = 'new-world:story-jump'
const jumpSuffix = /\?storyJump=([0-9a-f-]{36})$/

export function storyJumpFor(work: StoryWork, conflict: StoryConflict, profileName: string, fix: boolean): StoryJump {
  return {
    ...work, chapterId: conflict.chapter.id, chapterTitle: conflict.chapter.title,
    anchor: conflict.anchor, previewSection: conflict.chapter.previewSection,
    ...(fix ? { fix: { replacement: conflict.replacement, reason: conflict.reason, profileName } } : {}),
  }
}

export async function openStoryTarget(hash: string) {
  if (!location.hash.startsWith(storyRoutePrefix)) {
    location.hash = hash
    return
  }
  if (window.newWorldDesktop?.openStoryEditor) return window.newWorldDesktop.openStoryEditor(hash)
  const editor = storyEditorWindow()
  if (editor) {
    editor.location.hash = hash
    editor.focus()
    return
  }
  window.open(new URL(hash, location.href), 'new-world-story-editor')?.focus()
}

export async function openStoryJump(source: StorySource, jump: StoryJump) {
  const target = source.kind === 'edition' ? bookPath(jump.library, jump.bookId, source.edition.id)
    : bookPath(jump.library, source.book.id, 'original')
  const token = crypto.randomUUID()
  localStorage.setItem(jumpKey, JSON.stringify({ token, target, time: Date.now(), jump }))
  await openStoryTarget(`${target}?storyJump=${token}`)
}

/** Keeps quoted manuscript text in local storage until the requested route has passed the leave guard. */
export function takeStoryJump(hash: string): { hash: string; jump?: StoryJump } {
  const match = jumpSuffix.exec(hash)
  if (!match) return { hash }
  const destination = hash.slice(0, match.index)
  try {
    const item = JSON.parse(localStorage.getItem(jumpKey) ?? 'null')
    if (item && item.token === match[1] && item.target === destination) {
      localStorage.removeItem(jumpKey)
      if (Date.now() - item.time < 5 * 60_000) return { hash: destination, jump: item.jump }
    }
  } catch { /* The normal reader still opens if the jump expired. */ }
  return { hash: destination }
}

export function revealOriginalQuote(host: HTMLElement, text: HTMLElement, jump: StoryJump) {
  const manuscript = text.textContent ?? ''
  const { quote, before, after, total, occurrence } = jump.anchor
  const offsets = storyQuoteOffsets(manuscript, quote)
  const matches = offsets.filter((index) => manuscript.slice(0, index).endsWith(before) && manuscript.startsWith(after, index + quote.length))
  const index = matches.length === 1 ? matches[0] : offsets.length === total ? offsets[occurrence] : undefined
  const mark = element('mark', 'story-ai-quote', quote)
  if (index !== undefined) {
    mark.dataset.previewHighlight = ''
    text.replaceChildren(document.createTextNode(manuscript.slice(0, index)), mark, document.createTextNode(manuscript.slice(index + quote.length)))
  } else {
    // Some read-only previews are raster pages or use a different text representation.
    const excerpt = element('aside', 'story-ai-excerpt')
    excerpt.setAttribute('aria-label', t('storyAi.originalExcerpt'))
    excerpt.append(element('strong', '', jump.chapterTitle), element('p'))
    excerpt.lastElementChild!.append(before, mark, after)
    host.prepend(excerpt)
  }
  mark.scrollIntoView({ block: 'center' })
}
