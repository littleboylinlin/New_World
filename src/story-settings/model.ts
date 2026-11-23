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
  /** The card holds for the whole work, in every chapter; `chapters` is then empty. */
  wholeBook: boolean
  /** The chapters the card is linked to, when it is not for the whole work. Empty means no link. */
  chapters: StoryChapter[]
  states: StoryState[]
}

/** Where a card applies: the whole work, some chapters, or (no chapters, not whole) nowhere in particular. */
export interface StoryLink { wholeBook: boolean; chapters: StoryChapter[] }

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

export function blankStoryCard(link: StoryLink = { wholeBook: false, chapters: [] }): StoryCardInput {
  return { name: '', aliases: [], tagIds: [], fields: [], body: '', wholeBook: link.wholeBook, chapters: link.wholeBook ? [] : [...link.chapters], states: [] }
}

export function cardInput({ name, aliases, tagIds, fields, body, wholeBook, chapters, states }: StoryCard): StoryCardInput {
  return { name, aliases, tagIds, fields, body, wholeBook, chapters, states }
}

/** Whether a card is in effect in a chapter: a whole-work card is in effect everywhere. */
export function storyCardApplies(card: Pick<StoryCardInput, 'wholeBook' | 'chapters'>, chapter: StoryChapter) {
  return card.wholeBook || card.chapters.some((ref) => ref.editionId === chapter.editionId && ref.chapterId === chapter.chapterId)
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
    && keys(value, [...geometry, 'name', 'aliases', 'tagIds', 'fields', 'body', 'wholeBook', 'chapters', 'states'])
    && typeof value.wholeBook === 'boolean' && !(value.wholeBook && Array.isArray(value.chapters) && value.chapters.length)
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

/** Why a scene cannot be saved, pointing at the object to fix when there is one. */
export type StoryProblem =
  | { kind: 'cardName' | 'aliases' | 'fields' | 'tagMissing'; id: string; name: string }
  | { kind: 'chapter' | 'state'; id: string; name: string; chapter?: StoryChapter }
  | { kind: 'tag'; id: string; name: string }
  | { kind: 'node' | 'edge' | 'cycle' | 'duplicate'; id: string }
  | { kind: 'size'; bytes: number; limit: number }
  | { kind: 'format' }

/** An arrow that is part of a loop of arrows glued to each other. */
function loopedEdge(edges: readonly StoryEdge[]) {
  const byId = new Map(edges.map((edge) => [edge.id, edge]))
  const state = new Map<string, 'open' | 'done'>()
  const visit = (edge: StoryEdge): string | undefined => {
    if (state.get(edge.id) === 'open') return edge.id
    if (state.get(edge.id) === 'done') return
    state.set(edge.id, 'open')
    for (const end of [edge.from, edge.to]) {
      const next = isEdgeEnd(end) ? byId.get(end.edgeId) : undefined
      const found = next && visit(next)
      if (found) return found
    }
    state.set(edge.id, 'done')
  }
  for (const edge of edges) {
    const found = visit(edge)
    if (found) return found
  }
  return edges.find((edge) => isNodeEnd(edge.from) && isNodeEnd(edge.to) && edge.from.nodeId === edge.to.nodeId)?.id
}

const listOf = (value: unknown) => Array.isArray(value) ? value : undefined

/** The first reason a card is invalid, or undefined. */
function cardProblem(value: Record<string, unknown>, tags: ReadonlySet<string>): StoryProblem | undefined {
  const id = text(value.id) ? value.id : ''
  const name = text(value.name) ? value.name : ''
  if (!line(value.name)) return { kind: 'cardName', id, name }
  const aliases = listOf(value.aliases)
  if (!uniqueList<string>(aliases, line, normalized) || aliases.some((alias) => normalized(alias) === normalized(name))) return { kind: 'aliases', id, name }
  const tagIds = listOf(value.tagIds)
  if (!uniqueList<string>(tagIds, line, (tag) => tag) || tagIds.some((tag) => !tags.has(tag))) return { kind: 'tagMissing', id, name }
  if (!listOf(value.fields)?.every((field) => plain(field) && keys(field, ['key', 'value']) && text(field.key) && text(field.value)) || !text(value.body)) {
    return { kind: 'fields', id, name }
  }
  // A whole-work card names no chapters; without a chapter the message speaks of an invalid link.
  if (typeof value.wholeBook !== 'boolean' || (value.wholeBook && listOf(value.chapters)?.length)) return { kind: 'chapter', id, name }
  for (const state of [false, true]) {
    const refs = listOf(state ? value.states : value.chapters)
    const seen = new Set<string>()
    for (const ref of refs ?? [undefined]) {
      if (!validChapter(ref, state)) return { kind: state ? 'state' : 'chapter', id, name, ...(plain(ref) && line(ref.editionId) && line(ref.chapterId) ? { chapter: { editionId: ref.editionId, chapterId: ref.chapterId } } : {}) }
      const key = storyChapterKey(ref as StoryChapter)
      if (seen.has(key)) return { kind: state ? 'state' : 'chapter', id, name, chapter: ref as StoryChapter }
      seen.add(key)
    }
  }
  return isStoryCard(value) ? undefined : { kind: 'node', id }
}

/** Checks a scene in the order a person can act on: cards first, then other objects, links, and size. */
export function storySceneProblem(value: unknown): StoryProblem | undefined {
  if (!plain(value) || !keys(value, ['nodes', 'edges', 'tags'])) return { kind: 'format' }
  const nodes = listOf(value.nodes), edges = listOf(value.edges), tagRows = listOf(value.tags)
  if (!nodes || !edges || !tagRows) return { kind: 'format' }
  const seen = new Set<string>()
  const unique = (id: unknown): StoryProblem | undefined => {
    if (!line(id)) return { kind: 'format' }
    if (seen.has(id)) return { kind: 'duplicate', id }
    seen.add(id)
  }
  for (const tag of tagRows) {
    if (!isTag(tag)) return { kind: 'tag', id: plain(tag) && text(tag.id) ? tag.id : '', name: plain(tag) && text(tag.name) ? tag.name : '' }
    const clash = unique((tag as StoryTag).id)
    if (clash) return clash
  }
  const tags = new Set((tagRows as StoryTag[]).map(({ id }) => id))
  for (const node of nodes) {
    if (!plain(node)) return { kind: 'format' }
    const clash = unique(node.id)
    if (clash) return clash
    const problem = node.kind === 'card' ? cardProblem(node, tags) : isNode(node) ? undefined : { kind: 'node' as const, id: String(node.id) }
    if (problem) return problem
  }
  for (const edge of edges) {
    if (!plain(edge)) return { kind: 'format' }
    const clash = unique(edge.id)
    if (clash) return clash
    if (!isEdge(edge)) return { kind: 'edge', id: String(edge.id) }
  }
  if (!validStoryEdges(edges as StoryEdge[])) return { kind: 'cycle', id: loopedEdge(edges as StoryEdge[]) ?? '' }
  const bytes = new TextEncoder().encode(JSON.stringify({ nodes, edges, tags: tagRows })).length
  if (bytes > maxSceneCharacters) return { kind: 'size', bytes, limit: maxSceneCharacters }
}

export function isStoryScene(value: unknown): value is StoryScene {
  return !storySceneProblem(value)
}

/** A scene a save refused, with the reason the window explains to the writer. */
export class StorySceneError extends Error {
  readonly problem: StoryProblem
  constructor(problem: StoryProblem, message: string) {
    super(message)
    this.name = 'StorySceneError'
    this.problem = problem
  }
}

export interface StoryRepair {
  scene: StoryScene
  /** Links dropped because an end no longer exists, or because they formed a loop. */
  removedEdges: number
  /** Objects other than cards that could not be read at all. */
  removedNodes: number
  /** Cards whose fields were brought back into shape; their content stays. */
  repairedCards: number
  changed: boolean
}

const finite = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
const cleanLine = (value: unknown) => text(value) ? value.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, maxStoryName).trim() : ''
const newId = () => crypto.randomUUID()
/** JSON with object keys sorted, so key order alone never counts as a change. */
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : plain(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null'

function repairChapters(value: unknown, state: boolean) {
  const seen = new Set<string>()
  return (listOf(value) ?? []).flatMap((ref) => {
    if (!plain(ref) || !line(ref.editionId) || !line(ref.chapterId)) return []
    const chapter = { editionId: ref.editionId, chapterId: ref.chapterId }
    const key = storyChapterKey(chapter)
    if (seen.has(key) || (state && (!text(ref.text) || !ref.text.trim()))) return []
    seen.add(key)
    return [state ? { ...chapter, text: ref.text as string } : chapter]
  })
}

/** Keeps every card: fills missing fields, drops unknown tags and duplicate chapter links, keeps the text. */
function repairCard(value: Record<string, unknown>, tags: ReadonlySet<string>, untitled: string): StoryCard {
  const name = cleanLine(value.name) || untitled
  const aliases = uniqueAliases(name, (listOf(value.aliases) ?? []).map(cleanLine)).filter(Boolean)
  return {
    id: line(value.id) ? value.id : newId(), kind: 'card',
    x: finite(value.x, 0, -100_000_000, 100_000_000), y: finite(value.y, 0, -100_000_000, 100_000_000),
    width: finite(value.width, 168, 32, 100_000), height: finite(value.height, 60, 32, 100_000),
    name, aliases,
    tagIds: [...new Set((listOf(value.tagIds) ?? []).filter((id): id is string => text(id) && tags.has(id)))],
    fields: (listOf(value.fields) ?? []).flatMap((field) => plain(field) && (text(field.key) || text(field.value))
      ? [{ key: text(field.key) ? field.key : '', value: text(field.value) ? field.value : '' }] : []),
    body: text(value.body) ? value.body : '',
    wholeBook: value.wholeBook === true, chapters: value.wholeBook === true ? [] : repairChapters(value.chapters, false),
    states: repairChapters(value.states, true) as StoryState[],
  }
}

/** Reads an arrow end in this or the previous canvas format ({ nodeId, side }), or returns undefined. */
function repairEnd(value: unknown): StoryEndpoint | undefined {
  if (!plain(value)) return
  if (line(value.nodeId)) return { nodeId: value.nodeId }
  if (line(value.edgeId) && typeof value.at === 'number' && Number.isFinite(value.at)) return { edgeId: value.edgeId, at: Math.min(1, Math.max(0, value.at)) }
  if (typeof value.x === 'number' && typeof value.y === 'number' && validPosition(value)) return { x: value.x, y: value.y }
}

/**
 * Brings a stored scene up to the current format without losing cards. Links in the previous format
 * are converted; links whose ends are gone (not on the board and not a card in the recycle bin), or
 * that loop, are dropped. Other unreadable objects are dropped too, and counted.
 */
export function repairStoryScene(value: unknown, options: { trashedCards?: ReadonlySet<string>; untitled: string }): StoryRepair {
  const raw = plain(value) ? value : {}
  const ids = new Set<string>()
  const claim = (id: string) => { if (ids.has(id)) return false; ids.add(id); return true }
  const tags = (listOf(raw.tags) ?? []).filter((tag): tag is StoryTag => isTag(tag) && claim((tag as StoryTag).id))
  const tagIds = new Set(tags.map(({ id }) => id))
  let removedNodes = 0, repairedCards = 0
  const nodes: StoryNode[] = []
  for (const node of listOf(raw.nodes) ?? []) {
    if (plain(node) && node.kind === 'card') {
      let card = repairCard(node, tagIds, options.untitled)
      if (!claim(card.id)) { card = { ...card, id: newId() }; claim(card.id) }
      if (canonical(card) !== canonical(node)) repairedCards++
      nodes.push(card)
    } else if (isNode(node) && claim((node as StoryNode).id)) nodes.push(node as StoryNode)
    else removedNodes++
  }
  const endpoints = new Set(nodes.filter((node) => node.kind !== 'group').map(({ id }) => id))
  const kept = (end: StoryEndpoint) => !isNodeEnd(end) || endpoints.has(end.nodeId) || Boolean(options.trashedCards?.has(end.nodeId))
  let removedEdges = 0
  let edges: StoryEdge[] = []
  for (const edge of listOf(raw.edges) ?? []) {
    const from = plain(edge) ? repairEnd(edge.from) : undefined
    const to = plain(edge) ? repairEnd(edge.to) : undefined
    if (!plain(edge) || !line(edge.id) || !from || !to || !kept(from) || !kept(to) || ids.has(edge.id)) { removedEdges++; continue }
    if (isNodeEnd(from) && isNodeEnd(to) && from.nodeId === to.nodeId) { removedEdges++; continue }
    const direction = storyDirections.find((item) => item === edge.direction) ?? 'forward'
    const stroke = storyStrokes.find((item) => item === edge.stroke) ?? 'solid'
    edges.push({
      id: edge.id, from, to, name: text(edge.name) ? edge.name : '', direction, stroke,
      color: color(edge.color) ? edge.color : defaultStoryColor, bend: finite(edge.bend, 0, -maxStoryBend, maxStoryBend),
    })
    ids.add(edge.id)
  }
  // Drop links glued to links that are gone, then break any loop one link at a time.
  for (let changed = true; changed;) {
    const present = new Set(edges.map(({ id }) => id))
    const next = edges.filter((edge) => [edge.from, edge.to].every((end) => !isEdgeEnd(end) || (present.has(end.edgeId) && end.edgeId !== edge.id)))
    changed = next.length !== edges.length
    removedEdges += edges.length - next.length
    edges = next
  }
  while (!validStoryEdges(edges)) {
    const looped = loopedEdge(edges)
    edges = edges.filter((edge) => edge.id !== looped)
    removedEdges++
    const present = new Set(edges.map(({ id }) => id))
    const before = edges.length
    edges = edges.filter((edge) => [edge.from, edge.to].every((end) => !isEdgeEnd(end) || present.has(end.edgeId)))
    removedEdges += before - edges.length
  }
  const scene = { nodes, edges, tags }
  return { scene, removedEdges, removedNodes, repairedCards, changed: canonical(scene) !== canonical({ nodes: raw.nodes, edges: raw.edges, tags: raw.tags }) }
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

interface StoryRows<E> { boards: StoryBoard[]; trash: E[] }
/**
 * Repairs every stored board and recycled card or work before an export, so one board left over from an
 * earlier build never blocks a backup or project file. Links to cards in the recycle bin are kept.
 */
export function repairStoryRows<E extends { kind: string; library: string; bookId: string; storyBoard?: StoryBoard; storyCard?: StoryCard }>(
  boards: StoryBoard[], trash: E[], untitled: string,
): StoryRows<E> {
  const trashed = new Map<string, Set<string>>()
  for (const entry of trash) if (entry.storyCard) {
    const key = JSON.stringify([entry.library, entry.bookId])
    trashed.set(key, (trashed.get(key) ?? new Set()).add(entry.storyCard.id))
  }
  const fix = (board: StoryBoard): StoryBoard => {
    if (!plain(board) || !plain(board.scene)) return board
    const repair = repairStoryScene(board.scene, { trashedCards: trashed.get(JSON.stringify([board.library, board.bookId])), untitled })
    return repair.changed ? { ...board, scene: repair.scene } : board
  }
  return {
    boards: boards.map(fix),
    trash: trash.map((entry) => {
      if (entry.storyBoard) return { ...entry, storyBoard: fix(entry.storyBoard) }
      if (entry.storyCard && !isStoryCard(entry.storyCard)) {
        const card = entry.storyCard as unknown as Record<string, unknown>
        return { ...entry, storyCard: repairCard(card, new Set(listOf(card.tagIds)?.filter(line) ?? []), untitled) }
      }
      return entry
    }),
  }
}

