import type { CardAddition, CardDraft } from '../ai/story-payload'
import type { StoryManuscriptChapter, StorySource } from '../ai/story-manuscript'
import { t } from '../i18n'
import { bounds, overlaps } from './geometry'
import { blankStoryCard, defaultStoryColor, storyCards, uniqueAliases } from './model'
import type { Point, Rect, StoryCard, StoryCardInput, StoryScene } from './model'

export type ExtractionProposal = CardDraft & { cardId?: string; target?: string | null; picked: boolean }

const normalized = (value: string) => value.trim().normalize('NFKC').toLowerCase()

function fieldsWithAdditions(current: StoryCardInput['fields'], additions: StoryCardInput['fields']) {
  const taken = new Set(current.map(({ key }) => normalized(key)))
  return [...current, ...additions.flatMap(({ key, value }) => {
    const identity = normalized(key)
    if (!identity || taken.has(identity) || !value.trim()) return []
    taken.add(identity)
    return [{ key: key.trim(), value }]
  })]
}

export function extractionMatches(proposal: Pick<CardDraft, 'name' | 'aliases'>, cards: StoryCard[]) {
  const names = new Set([proposal.name, ...proposal.aliases].map(normalized).filter(Boolean))
  return cards.filter((card) => [card.name, ...card.aliases].some((name) => names.has(normalized(name))))
}

export function extractionProposals(scene: StoryScene, drafts: CardDraft[], additions: CardAddition[]) {
  const existing = storyCards(scene)
  const proposals: ExtractionProposal[] = []
  // Merge repeated discoveries across chunks. Keep their combined appearance list.
  for (const draft of drafts) {
    const matches = new Set([draft.name, ...draft.aliases].map(normalized))
    const same = proposals.find((item) => [item.name, ...item.aliases].some((name) => matches.has(normalized(name))))
    if (same) {
      same.aliases = uniqueAliases(same.name, [...same.aliases, draft.name, ...draft.aliases])
      same.tags = uniqueAliases('', [...same.tags, ...draft.tags])
      same.fields = fieldsWithAdditions(same.fields, draft.fields)
      if (draft.body.trim() && !same.body.includes(draft.body.trim())) same.body = [same.body, draft.body].filter(Boolean).join('\n\n')
      same.chapters = [...new Set([...same.chapters, ...draft.chapters])].sort((a, b) => a - b)
    } else proposals.push({ ...draft, name: draft.name.trim(), fields: fieldsWithAdditions([], draft.fields), picked: true })
  }
  for (const addition of additions) {
    const card = existing.find(({ id }) => id === addition.cardId)
    if (!card) continue
    const same = proposals.find(({ cardId }) => cardId === card.id)
    if (same) {
      same.aliases = uniqueAliases(card.name, [...same.aliases, ...addition.aliases])
      same.fields = fieldsWithAdditions(same.fields, addition.fields)
    } else proposals.push({
      ...addition, name: card.name, tags: [], body: '', chapters: [], picked: true,
      aliases: uniqueAliases(card.name, addition.aliases), fields: fieldsWithAdditions([], addition.fields),
    })
  }
  return proposals
}

function* cardSlots(origin: Point) {
  const width = 206
  const height = 104
  for (let radius = 0; radius <= 10; radius++) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== radius) continue
        yield { x: Math.round(origin.x + x * (width + 24)), y: Math.round(origin.y + y * (height + 24)), width, height }
      }
    }
  }
}

const positionLimit = 100_000_000

export function applyExtraction(scene: StoryScene, proposals: ExtractionProposal[], source: StorySource, chapters: StoryManuscriptChapter[], origin: Point) {
  const nodes = [...scene.nodes]
  const tags = [...scene.tags]
  const changed = new Set<string>()
  const slots = cardSlots(origin)
  const newRect = (): Rect => {
    const free = (candidate: Rect) => Math.abs(candidate.x) <= positionLimit && Math.abs(candidate.y) <= positionLimit
      && !nodes.some((node) => overlaps(node, candidate))
    for (let next = slots.next(); !next.done; next = slots.next()) if (free(next.value)) return next.value
    const occupied = bounds(nodes)
    const size = { width: 206, height: 104 }
    if (occupied) {
      const { x, y, width, height } = occupied
      const edges = [
        { x: 0, y: y + height + 24 }, { x: 0, y: y - size.height - 24 },
        { x: x + width + 24, y: 0 }, { x: x - size.width - 24, y: 0 },
      ]
      for (const point of edges) if (free({ ...point, ...size })) return { ...point, ...size }
    }
    throw new Error(t('storyAi.noCanvasRoom'))
  }
  for (const proposal of proposals) {
    if (!proposal.picked) continue
    const existing = storyCards({ ...scene, nodes })
    const target = proposal.cardId ?? (proposal.target === undefined ? extractionMatches(proposal, existing)[0]?.id : proposal.target)
    if (target) {
      const card = existing.find(({ id }) => id === target)
      if (!card) throw new Error(t('story.conflict'))
      const aliases = uniqueAliases(card.name, [...card.aliases, ...(proposal.cardId ? [] : [proposal.name]), ...proposal.aliases])
      const fields = fieldsWithAdditions(card.fields, proposal.fields)
      if (aliases.length === card.aliases.length && fields.length === card.fields.length) continue
      nodes[nodes.indexOf(card)] = { ...card, aliases, fields }
      changed.add(card.id)
      continue
    }
    const tagIds = uniqueAliases('', proposal.tags).map((name) => {
      const found = tags.find((tag) => normalized(tag.name) === normalized(name))
      if (found) return found.id
      const id = crypto.randomUUID()
      tags.push({ id, name, color: defaultStoryColor })
      return id
    })
    const card: StoryCard = {
      ...newRect(), kind: 'card', id: crypto.randomUUID(), ...blankStoryCard(),
      name: proposal.name, aliases: uniqueAliases(proposal.name, proposal.aliases), tagIds,
      fields: fieldsWithAdditions([], proposal.fields), body: proposal.body,
      chapters: source.kind === 'edition' ? chapters.filter(({ number }) => proposal.chapters.includes(number))
        .map(({ id }) => ({ editionId: source.edition.id, chapterId: id })) : [],
    }
    nodes.push(card)
    changed.add(card.id)
  }
  return { scene: { ...scene, nodes, tags }, changed: [...changed] }
}
