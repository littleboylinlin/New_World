import { t, locale } from '../i18n'
import { committed, openDatabase, resultOf } from '../library'
import type { LibraryId } from '../library'

/**
 * A writing style: a carefully written instruction the AI follows when it polishes, rewrites or
 * continues text. It describes how to write; it is not a source to copy from.
 */
export interface WritingStyle {
  id: string
  name: string
  /** Where it came from: modelled on an author, on the user's own chapters, or written by hand. */
  kind: 'author' | 'own' | 'custom'
  summary: string
  vocabulary: string
  rhythm: string
  perspective: string
  /** Short passages that show the feel of the style. */
  samples: string[]
  /** Who or what it is modelled on, e.g. an author's name or the chapters it was drawn from. */
  basis?: string
  createdAt: number
  updatedAt: number
}

export type StyleInput = Omit<WritingStyle, 'id' | 'createdAt' | 'updatedAt'>

/** Rows of the `writingStyles` store: styles, and which style each work uses by default. */
type StyleRow =
  | ({ type: 'style' } & WritingStyle)
  | { type: 'workDefault'; id: string; library: LibraryId; bookId: string; styleId: string }

export const styleStore = 'writingStyles'
export const styleChanges = new EventTarget()
export const maxSamples = 5
const maxField = 4000
const maxSample = 800

const builtinPrefix = 'builtin:'

const builtinZh: StyleInput[] = [
  {
    name: '冷峻白描', kind: 'custom',
    summary: '克制、冷静的叙述，靠动作和细节说话，很少直接抒情或评价。',
    vocabulary: '用词朴素准确，多用具体名词和动词，少用形容词和成语；句子以短句为主，偶尔用一个长句收束。',
    rhythm: '节奏紧凑，段落短，情绪在留白处；关键处用一句独立成段的短句。',
    perspective: '第三人称有限视角，只写人物看到、听到、做到的，不替人物解释内心。',
    samples: [
      '雨下到半夜才停。他把伞靠在门边，水顺着伞尖淌到地上，汇成一小摊。屋里没有开灯。',
      '她没回头，只把手里的钥匙放在桌上，推过去。',
    ],
  },
  {
    name: '古典章回', kind: 'custom',
    summary: '带说书人口吻的白话小说笔法，叙事从容，讲究对仗与收束。',
    vocabulary: '半文半白，适度使用四字短语和传统称谓；对话前常加「道」「笑道」；避免现代网络用语。',
    rhythm: '起承转合分明，场景交代完整；段落末尾常以一句评点或悬念收住。',
    perspective: '全知叙述，叙述者可以点评人物，偶尔直接对读者说话。',
    samples: [
      '话说那日天色将晚，城门口来了一个挑担的汉子，衣衫虽旧，眉目间却自有一股英气。',
      '那掌柜的听了，笑道：「客官说笑了，小店哪有这等好酒？」',
    ],
  },
  {
    name: '轻快口语', kind: 'custom',
    summary: '轻松活泼的口语化叙述，像朋友在讲故事，适合日常和轻喜剧。',
    vocabulary: '多用口语词和语气词，句式灵活，可以有自问自答和吐槽式的插话。',
    rhythm: '节奏明快，对话多，段落短；笑点和反转放在句尾。',
    perspective: '第一人称或贴近主角的第三人称，叙述带主角的情绪和小心思。',
    samples: [
      '我盯着那碗面看了三秒，决定原谅它——毕竟它是今天唯一没让我失望的东西。',
      '「你确定这是近路？」「确定啊，」他理直气壮，「地图上看着可近了。」',
    ],
  },
  {
    name: '细腻抒情', kind: 'custom',
    summary: '细腻的感官描写和内心刻画，语言有韵律感，适合情感与回忆的段落。',
    vocabulary: '用词柔和有画面感，善用比喻和通感；长短句交错，偶用排比。',
    rhythm: '舒缓，允许在一个画面上停留；情绪层层推进，结尾留余味。',
    perspective: '贴近人物内心的第三人称或第一人称，常在现实与回忆之间转换。',
    samples: [
      '傍晚的光从窗缝里斜斜地漏进来，落在旧书的封面上，像谁轻轻按住了一段不肯翻过去的日子。',
    ],
  },
]

const builtinEn: StyleInput[] = [
  {
    name: 'Spare and cool', kind: 'custom',
    summary: 'Restrained, calm narration that lets actions and details carry the feeling; it rarely comments or emotes.',
    vocabulary: 'Plain, exact words; concrete nouns and verbs, few adjectives or idioms. Mostly short sentences, now and then one long sentence to close.',
    rhythm: 'Tight pacing and short paragraphs; emotion lives in what is left out. Key moments get a one-line paragraph.',
    perspective: 'Close third person: only what the character sees, hears and does, without explaining their mind.',
    samples: ['The rain stopped after midnight. He leaned the umbrella by the door and water ran off its tip into a small pool. No lights were on.'],
  },
  {
    name: 'Old-fashioned storyteller', kind: 'custom',
    summary: 'A leisurely narrator who addresses the reader, with balanced phrasing and neat endings to each scene.',
    vocabulary: 'Slightly formal, period-flavoured diction; traditional forms of address; no modern slang.',
    rhythm: 'Clear build-up and turn in each scene; paragraphs often end on a remark or a hook.',
    perspective: 'Omniscient narrator who may comment on the characters and speak to the reader.',
    samples: ['Now, on the evening in question, a man with a carrying pole came to the city gate; his coat was worn, but there was a certain pride in his bearing.'],
  },
  {
    name: 'Light and chatty', kind: 'custom',
    summary: 'Breezy, conversational narration, like a friend telling a story; suits everyday life and light comedy.',
    vocabulary: 'Colloquial words, asides and rhetorical questions; flexible sentence shapes.',
    rhythm: 'Quick, with plenty of dialogue and short paragraphs; jokes and twists land at the end of sentences.',
    perspective: 'First person, or a third person that shares the main character\'s moods and little schemes.',
    samples: ['I stared at the bowl of noodles for three seconds and decided to forgive it. It was the only thing all day that hadn\'t let me down.'],
  },
  {
    name: 'Tender and lyrical', kind: 'custom',
    summary: 'Delicate sensory detail and inner life in rhythmic language; suits emotional scenes and memories.',
    vocabulary: 'Soft, vivid words; metaphor and synaesthesia; long and short sentences in turn.',
    rhythm: 'Unhurried, lingering on an image; feeling builds layer by layer and ends with an aftertaste.',
    perspective: 'Close to a character\'s heart, often moving between the present and memory.',
    samples: ['The evening light slipped through the gap in the curtains and settled on the old book\'s cover, as if someone were gently holding down a day that would not turn over.'],
  },
]

/** The examples that come with the app. They can be copied and changed, not edited in place. */
export function builtinStyles(): WritingStyle[] {
  return (locale === 'zh-CN' ? builtinZh : builtinEn).map((style, index) => ({
    ...style, samples: [...style.samples], id: `${builtinPrefix}${index + 1}`, createdAt: 0, updatedAt: 0,
  }))
}

export const isBuiltin = (id: string) => id.startsWith(builtinPrefix)

function text(value: unknown, limit = maxField) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

/** Checks and tidies a style from a form, a file or an AI reply. */
export function cleanStyle(value: unknown): StyleInput {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const name = text(record.name, 80)
  if (!name) throw new Error(t('styles.needName'))
  const kind = record.kind === 'author' || record.kind === 'own' ? record.kind : 'custom'
  const samples = (Array.isArray(record.samples) ? record.samples : [])
    .map((sample) => text(sample, maxSample)).filter(Boolean).slice(0, maxSamples)
  const basis = text(record.basis, 200)
  return {
    name, kind,
    summary: text(record.summary), vocabulary: text(record.vocabulary), rhythm: text(record.rhythm),
    perspective: text(record.perspective), samples, ...(basis ? { basis } : {}),
  }
}

// ——— Storage (inside the library database, so backups carry it) ———

async function rows(): Promise<StyleRow[]> {
  const db = await openDatabase()
  return resultOf(db.transaction(styleStore).objectStore(styleStore).getAll())
}

/** The user's styles, newest first. */
export async function listStyles(): Promise<WritingStyle[]> {
  return (await rows()).filter((row): row is { type: 'style' } & WritingStyle => row.type === 'style')
    .map(({ type: _type, ...style }) => style)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Built-in and own styles together, for pickers. */
export async function allStyles(): Promise<WritingStyle[]> {
  return [...await listStyles(), ...builtinStyles()]
}

export async function findStyle(id: string): Promise<WritingStyle | undefined> {
  if (isBuiltin(id)) return builtinStyles().find((style) => style.id === id)
  const db = await openDatabase()
  const row: StyleRow | undefined = await resultOf(db.transaction(styleStore).objectStore(styleStore).get(id))
  if (row?.type !== 'style') return undefined
  const { type: _type, ...style } = row
  return style
}

function announce() {
  styleChanges.dispatchEvent(new Event('change'))
}

export async function saveStyle(input: StyleInput, id?: string): Promise<WritingStyle> {
  const clean = cleanStyle(input)
  const previous = id && !isBuiltin(id) ? await findStyle(id) : undefined
  const now = Date.now()
  const style: WritingStyle = { ...clean, id: previous?.id ?? crypto.randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now }
  const db = await openDatabase()
  const tx = db.transaction(styleStore, 'readwrite', { durability: 'strict' })
  tx.objectStore(styleStore).put({ type: 'style', ...style } satisfies StyleRow)
  await committed(tx)
  announce()
  return style
}

/** Removes a style; works that used it by default go back to none. */
export async function deleteStyle(id: string) {
  const all = await rows()
  const db = await openDatabase()
  const tx = db.transaction(styleStore, 'readwrite', { durability: 'strict' })
  const store = tx.objectStore(styleStore)
  store.delete(id)
  for (const row of all) if (row.type === 'workDefault' && row.styleId === id) store.delete(row.id)
  await committed(tx)
  announce()
}

const workKey = (library: LibraryId, bookId: string) => `work:${library}:${bookId}`

/** The style a work uses unless another is chosen; undefined when it has none or it was removed. */
export async function workStyle(library: LibraryId, bookId: string): Promise<WritingStyle | undefined> {
  const db = await openDatabase()
  const row: StyleRow | undefined = await resultOf(db.transaction(styleStore).objectStore(styleStore).get(workKey(library, bookId)))
  return row?.type === 'workDefault' ? findStyle(row.styleId) : undefined
}

export async function setWorkStyle(library: LibraryId, bookId: string, styleId: string | null) {
  const db = await openDatabase()
  const tx = db.transaction(styleStore, 'readwrite', { durability: 'strict' })
  const store = tx.objectStore(styleStore)
  if (styleId) store.put({ type: 'workDefault', id: workKey(library, bookId), library, bookId, styleId } satisfies StyleRow)
  else store.delete(workKey(library, bookId))
  await committed(tx)
  announce()
}

// ——— Files ———

export const styleFileFormat = 'new-world-writing-styles'

export async function exportStyles(ids?: readonly string[]) {
  const styles = (await allStyles()).filter((style) => ids ? ids.includes(style.id) : !isBuiltin(style.id))
  return {
    format: styleFileFormat, version: 1,
    styles: styles.map(({ id: _id, createdAt: _created, updatedAt: _updated, ...rest }) => rest),
  }
}

/** Adds every style in a file as a new style; returns how many were added. */
export async function importStyles(file: unknown) {
  const record = (file && typeof file === 'object' ? file : {}) as Record<string, unknown>
  if (record.format !== styleFileFormat || record.version !== 1 || !Array.isArray(record.styles)) throw new Error(t('styles.importFormat'))
  const styles = record.styles.map(cleanStyle)
  for (const style of styles) await saveStyle(style)
  return styles.length
}

// ——— Prompts ———

/**
 * The instructions a style adds to a request. It asks for the manner only, never the words: the
 * samples are there to catch the feel, and nothing from them or any published work is to be copied.
 */
export function styleInstructions(style: WritingStyle) {
  const zh = locale === 'zh-CN'
  const parts = zh
    ? [
      `写作时采用这种文风「${style.name}」：`,
      style.summary && `整体：${style.summary}`,
      style.vocabulary && `词汇与句式：${style.vocabulary}`,
      style.rhythm && `节奏：${style.rhythm}`,
      style.perspective && `叙事视角：${style.perspective}`,
      style.samples.length ? `示例片段（只用来体会语感）：\n${style.samples.map((sample) => `「${sample}」`).join('\n')}` : '',
      '只模仿文风，不要照搬示例片段或任何已发表作品中的句子和段落；视角、人称要服从原文。',
    ]
    : [
      `Write in this style, "${style.name}":`,
      style.summary && `Overall: ${style.summary}`,
      style.vocabulary && `Vocabulary and sentences: ${style.vocabulary}`,
      style.rhythm && `Rhythm: ${style.rhythm}`,
      style.perspective && `Point of view: ${style.perspective}`,
      style.samples.length ? `Samples (only to catch the feel):\n${style.samples.map((sample) => `"${sample}"`).join('\n')}` : '',
      'Imitate the manner only: do not copy sentences or passages from the samples or from any published work; keep the original text\'s point of view and person.',
    ]
  return parts.filter(Boolean).join('\n')
}
