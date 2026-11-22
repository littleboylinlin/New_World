import type { ChapterRecord, Edition } from '../documents/model'
import type { Book, LibraryId, TrashEntry } from '../library'

export interface StoryWork { library: LibraryId; bookId: string }
export interface StoryChapter { editionId: string; chapterId: string }
export interface StoryState extends StoryChapter { text: string }
export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export interface StoryView extends Point { zoom: number }
export interface StoryTag { id: string; name: string; color: string }

export interface StoryCardInput {
  name: string
  aliases: string[]
  tagIds: string[]
  fields: { key: string; value: string }[]
  body: string
  chapters: StoryChapter[]
  states: StoryState[]
}

interface StoryItem extends Rect { id: string }
export interface StoryCard extends StoryItem, StoryCardInput { kind: 'card' }
export interface StoryText extends StoryItem { kind: 'text'; text: string }
export interface StoryGroup extends StoryItem { kind: 'group'; name: string }
export interface StoryImage extends StoryItem { kind: 'image'; src: string; name: string }
export type StoryNode = StoryCard | StoryText | StoryGroup | StoryImage

/** An arrow end glued to the outline of a card, text or image. It follows the object when it moves or resizes. */
export interface NodeEndpoint { nodeId: string }
/** An arrow end glued to another arrow, at a fraction of that arrow's length from its start. */
export interface EdgeEndpoint { edgeId: string; at: number }
/** A loose arrow end in canvas coordinates. */
export interface PointEndpoint { x: number; y: number }
export type StoryEndpoint = NodeEndpoint | EdgeEndpoint | PointEndpoint
export const storyDirections = ['forward', 'back', 'both', 'none'] as const
export const storyStrokes = ['solid', 'dash', 'dot'] as const
export const maxStoryBend = 100_000
export interface StoryEdge {
  id: string
  from: StoryEndpoint
  to: StoryEndpoint
  name: string
  direction: typeof storyDirections[number]
  stroke: typeof storyStrokes[number]
  color: string
  /** Signed distance of the curve's middle from the straight line, perpendicular to from → to. */
  bend: number
}

export const isNodeEnd = (end: StoryEndpoint): end is NodeEndpoint => 'nodeId' in end
export const isEdgeEnd = (end: StoryEndpoint): end is EdgeEndpoint => 'edgeId' in end
/** The ids an arrow refers to: the nodes or arrows its ends are glued to. */
export const storyEndRefs = (edge: StoryEdge) => [edge.from, edge.to].flatMap((end) => isNodeEnd(end) ? [end.nodeId] : isEdgeEnd(end) ? [end.edgeId] : [])

export interface StoryScene {
  nodes: StoryNode[]
  edges: StoryEdge[]
  tags: StoryTag[]
}
export interface StoryBoard extends StoryWork {
  scene: StoryScene
  view: StoryView
  revision: string
}

export const minZoom = .15
export const maxZoom = 4
export const maxStoryName = 255
export const maxStoryImage = 4 * 1024 * 1024
const maxSceneCharacters = 20 * 1024 * 1024
export const defaultStoryColor = '#64748b'

export const storyChapterKey = ({ editionId, chapterId }: StoryChapter) => JSON.stringify([editionId, chapterId])
export const storyWorkKey = ({ library, bookId }: StoryWork) => JSON.stringify([library, bookId])

export function emptyStoryBoard(work: StoryWork): StoryBoard {
  return { ...work, scene: { tags: [], nodes: [], edges: [] }, view: { x: 0, y: 0, zoom: 1 }, revision: '' }
}

export function blankStoryCard(chapter?: StoryChapter): StoryCardInput {
  return { name: '', aliases: [], tagIds: [], fields: [], body: '', chapters: chapter ? [chapter] : [], states: [] }
}

export function cardInput({ name, aliases, tagIds, fields, body, chapters, states }: StoryCard): StoryCardInput {
  return { name, aliases, tagIds, fields, body, chapters, states }
}

export function storyCards(scene: StoryScene) {
  return scene.nodes.filter((node): node is StoryCard => node.kind === 'card')
}

const normalized = (value: string) => value.trim().normalize('NFKC').toLowerCase()

export function uniqueAliases(name: string, aliases: string[]) {
  const seen = new Set([normalized(name), ''])
  return aliases.map((alias) => alias.trim()).filter((alias) => {
    const key = normalized(alias)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function matchesStoryCard(card: Pick<StoryCardInput, 'name' | 'aliases'>, query: string) {
  const term = normalized(query)
  return !term || [card.name, ...card.aliases].some((name) => normalized(name).includes(term))
}

/** States use the edition's current order, stopping at the requested chapter. */
export function storyStateAt(card: Pick<StoryCardInput, 'states'>, edition: Pick<Edition, 'id' | 'chapters'>, chapterId: string) {
  const states = new Map(card.states.filter((state) => state.editionId === edition.id).map((state) => [state.chapterId, state]))
  let state: StoryState | undefined
  for (const chapter of edition.chapters) {
    state = states.get(chapter.id) ?? state
    if (chapter.id === chapterId) return state
  }
  return undefined
}

const plain = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
const text = (value: unknown): value is string => typeof value === 'string'
const line = (value: unknown): value is string => text(value) && !!value && value.length <= maxStoryName && value === value.trim() && !/[\x00-\x1f]/.test(value)
const color = (value: unknown): value is string => text(value) && /^#[0-9a-f]{6}$/i.test(value)
const bounded = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && value >= min && value <= max

function uniqueList<T>(value: unknown, valid: (item: unknown) => boolean, key: (item: T) => string): value is T[] {
  if (!Array.isArray(value)) return false
  const seen = new Set<string>()
  for (const item of value) {
    if (!valid(item)) return false
    const identity = key(item)
    if (seen.has(identity)) return false
    seen.add(identity)
  }
  return true
}

function validChapter(value: unknown, state: boolean) {
  return plain(value) && keys(value, state ? ['editionId', 'chapterId', 'text'] : ['editionId', 'chapterId'])
    && line(value.editionId) && line(value.chapterId) && (!state || (text(value.text) && !!value.text.trim()))
}

const geometry = ['id', 'kind', 'x', 'y', 'width', 'height']
const validPosition = (value: Record<string, unknown>) => bounded(value.x, -100_000_000, 100_000_000) && bounded(value.y, -100_000_000, 100_000_000)
const validRect = (value: Record<string, unknown>) => validPosition(value)
  && bounded(value.width, 32, 100_000) && bounded(value.height, 32, 100_000)

export function isStoryCard(value: unknown): value is StoryCard {
  if (!plain(value)) return false
  const { name, aliases } = value
  return value.kind === 'card' && validRect(value) && line(value.id)
    && keys(value, [...geometry, 'name', 'aliases', 'tagIds', 'fields', 'body', 'chapters', 'states'])
    && line(name) && uniqueList<string>(aliases, line, normalized)
    && !aliases.some((alias) => normalized(alias) === normalized(name))
    && uniqueList<string>(value.tagIds, line, (tag) => tag)
    && Array.isArray(value.fields) && value.fields.every((field) => plain(field) && keys(field, ['key', 'value']) && text(field.key) && text(field.value))
    && text(value.body)
    && uniqueList<StoryChapter>(value.chapters, (chapter) => validChapter(chapter, false), storyChapterKey)
    && uniqueList<StoryState>(value.states, (state) => validChapter(state, true), storyChapterKey)
}

/** Restrict inline image sources to raster payloads the app can render without a network request. */
export function isStoryImageSource(value: unknown): value is string {
  if (!text(value) || value.length > maxStoryImage * 4 / 3 + 40) return false
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([a-zA-Z0-9+/]+={0,2})$/.exec(value)
  if (!match || match[2].length < 16 || match[2].length % 4) return false
  const prefix = atob(match[2].slice(0, 16))
  const signatures: Record<string, boolean> = {
    png: prefix.startsWith('\x89PNG\r\n\x1a\n'), jpeg: prefix.startsWith('\xff\xd8\xff'),
    gif: /^GIF8[79]a/.test(prefix), webp: prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP',
  }
  return signatures[match[1]] && match[2].length * .75 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) <= maxStoryImage
}

function isNode(value: unknown) {
  if (!plain(value) || !line(value.id) || !validRect(value)) return false
  switch (value.kind) {
    case 'card': return isStoryCard(value)
    case 'text': return keys(value, [...geometry, 'text']) && text(value.text)
    case 'group': return keys(value, [...geometry, 'name']) && text(value.name)
    case 'image': return keys(value, [...geometry, 'src', 'name']) && isStoryImageSource(value.src) && text(value.name)
    default: return false
  }
}
const isTag = (value: unknown) => plain(value) && keys(value, ['id', 'name', 'color'])
  && line(value.id) && line(value.name) && color(value.color)
const isEndpoint = (value: unknown) => plain(value) && (
  (keys(value, ['nodeId']) && line(value.nodeId))
  || (keys(value, ['edgeId', 'at']) && line(value.edgeId) && bounded(value.at, 0, 1))
  || (keys(value, ['x', 'y']) && validPosition(value)))

function isEdge(value: unknown) {
  return plain(value) && keys(value, ['id', 'from', 'to', 'name', 'direction', 'stroke', 'color', 'bend'])
    && line(value.id) && text(value.name) && color(value.color) && isEndpoint(value.from) && isEndpoint(value.to)
    && bounded(value.bend, -maxStoryBend, maxStoryBend)
    && storyDirections.some((direction) => direction === value.direction) && storyStrokes.some((stroke) => stroke === value.stroke)
}

/** Rejects an arrow glued to itself, both ends on one node, and arrows that hang on each other in a loop. */
export function validStoryEdges(edges: readonly StoryEdge[]) {
  const byId = new Map(edges.map((edge) => [edge.id, edge]))
  const state = new Map<string, 'open' | 'done'>()
  function visit(edge: StoryEdge): boolean {
    const mark = state.get(edge.id)
    if (mark) return mark === 'done'
    state.set(edge.id, 'open')
    for (const end of [edge.from, edge.to]) {
      const target = isEdgeEnd(end) ? byId.get(end.edgeId) : undefined
      if (target && !visit(target)) return false
    }
    state.set(edge.id, 'done')
    return true
  }
  return edges.every((edge) => {
    const { from, to } = edge
    if (isNodeEnd(from) && isNodeEnd(to) && from.nodeId === to.nodeId) return false
    if ((isEdgeEnd(from) && from.edgeId === edge.id) || (isEdgeEnd(to) && to.edgeId === edge.id)) return false
    return visit(edge)
  })
}

export function isStoryScene(value: unknown): value is StoryScene {
  if (!plain(value) || !keys(value, ['nodes', 'edges', 'tags'])
    || !uniqueList<StoryNode>(value.nodes, isNode, (node) => node.id)
    || !uniqueList<StoryEdge>(value.edges, isEdge, (edge) => edge.id)
    || !uniqueList<StoryTag>(value.tags, isTag, (tag) => tag.id)) return false
  const scene = { nodes: value.nodes, edges: value.edges, tags: value.tags }
  const tags = new Set(scene.tags.map((tag) => tag.id))
  const ids = [...scene.nodes, ...scene.edges, ...scene.tags].map(({ id }) => id)
  return new Set(ids).size === ids.length && storyCards(scene).every((card) => card.tagIds.every((id) => tags.has(id)))
    && validStoryEdges(scene.edges) && new TextEncoder().encode(JSON.stringify(scene)).length <= maxSceneCharacters
}

export function isStoryView(value: unknown): value is StoryView {
  return plain(value) && keys(value, ['x', 'y', 'zoom']) && validPosition(value) && bounded(value.zoom, minZoom, maxZoom)
}

function isBoard(value: unknown): value is StoryBoard {
  return plain(value) && keys(value, ['library', 'bookId', 'revision', 'scene', 'view'])
    && (value.library === 'original' || value.library === 'reference')
    && line(value.bookId) && (value.revision === '' || line(value.revision)) && isStoryView(value.view) && isStoryScene(value.scene)
}

/** Checks ownership and identities across the live boards and the recycle bin. */
export function validStoryRows(boards: unknown, books: Book[], chapters: ChapterRecord[], trash: (Omit<TrashEntry, 'files'> & { files: unknown[] })[]): boards is StoryBoard[] {
  if (!Array.isArray(boards) || trash.some((entry) => !entry)) return false
  if (!boards.length && trash.every((entry) => entry.kind !== 'storyCard' && entry.storyBoard === undefined && entry.storyCard === undefined)) return true
  const active = new Set(books.filter((book) => !book.workId).map(({ library, id }) => storyWorkKey({ library, bookId: id })))
  const knownChapters = new Map<string, Set<string>>()
  for (const chapter of [...chapters, ...trash.flatMap((entry) => Array.isArray(entry.chapters) ? entry.chapters : [])]) {
    if (!chapter) return false
    const owners = knownChapters.get(chapter.id) ?? new Set<string>()
    owners.add(JSON.stringify([chapter.library, chapter.bookId, chapter.editionId]))
    knownChapters.set(chapter.id, owners)
  }
  const seenWorks = new Set<string>()
  const seenNodes = new Map<string, Set<string>>()
  const add = (owner: StoryWork, node: StoryNode | StoryEdge) => {
    const key = storyWorkKey(owner)
    const seen = seenNodes.get(key) ?? new Set<string>()
    if (seen.has(node.id)) return false
    seen.add(node.id)
    seenNodes.set(key, seen)
    if (!('kind' in node) || node.kind !== 'card') return true
    return [...node.chapters, ...node.states].every(({ editionId, chapterId }) => {
      const owners = knownChapters.get(chapterId)
      return !owners || owners.has(JSON.stringify([owner.library, owner.bookId, editionId]))
    })
  }
  const addBoard = (board: unknown, owner?: StoryWork) => {
    if (!isBoard(board)) return false
    const key = storyWorkKey(board)
    if ((owner ? key !== storyWorkKey(owner) : !active.has(key)) || seenWorks.has(key)) return false
    seenWorks.add(key)
    return [...board.scene.nodes, ...board.scene.edges].every((node) => add(board, node))
  }
  return boards.every((board) => addBoard(board)) && trash.every((entry) => {
    if (entry.kind === 'book' && entry.storyBoard !== undefined) {
      return entry.storyCard === undefined && Array.isArray(entry.books) && entry.books.some((book) => book?.id === entry.bookId && book.library === entry.library && !book.workId)
        && addBoard(entry.storyBoard, entry)
    }
    if (entry.kind === 'storyCard') {
      return entry.storyBoard === undefined && isStoryCard(entry.storyCard) && add(entry, entry.storyCard)
        && !entry.position && entry.ideas === undefined
        && [entry.books, entry.files, entry.editions, entry.chapters].every((value) => Array.isArray(value) && !value.length)
    }
    return entry.storyBoard === undefined && entry.storyCard === undefined
  })
}
