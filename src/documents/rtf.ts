import { t } from '../i18n'
import type { JSONContent } from '@tiptap/core'
import type { DocumentContent } from './model'

const destinations = new Set('fonttbl colortbl stylesheet info pict object objdata header headerl headerr footer footerl footerr footnote annotation listtable listoverridetable fldinst datastore themedata colorschememapping'.split(' '))
const codepages: Record<number, string> = { 932: 'shift_jis', 936: 'gb18030', 949: 'euc-kr', 950: 'big5', 65001: 'utf-8' }
const markNames = { b: 'bold', i: 'italic', ul: 'underline', strike: 'strike' } as const
const punctuation: Record<string, string> = { emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”' }

export async function readRtf(blob: Blob): Promise<DocumentContent> {
  if (blob.size > 8 * 1024 * 1024) throw new Error(t('rtf.theRtfExceedsThe8MibConversionLimit'))
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32_768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)))
  const source = chunks.join('').trim()
  if (!/^\{\\rtf1\b/i.test(source)) throw new Error(t('rtf.theFileDoesNotHaveAValidRtf'))

  const token = /\\([a-z]+)(-?\d+)? ?|\\'([0-9a-f]{2})|\\([^a-z])|[{}]|[^{}\\]+/igy
  const paragraphs: JSONContent[] = []
  let runs: JSONContent[] = []
  let state = { skip: false, fallback: 1, page: 1252, b: false, i: false, ul: false, strike: false }
  const groups: typeof state[] = []
  let pending: number[] = []
  let skip = 0

  function append(text: string) {
    if (!text) return
    const marks = (Object.keys(markNames) as (keyof typeof markNames)[]).filter((mark) => state[mark]).map((mark) => ({ type: markNames[mark] }))
    const last = runs.at(-1)
    if (last?.type === 'text' && last.marks?.length === marks.length && marks.every((mark, i) => last.marks?.[i].type === mark.type)) last.text += text
    else runs.push({ type: 'text', text, marks })
  }

  function flush() {
    if (!pending.length) return
    const encoding = codepages[state.page] ?? (state.page >= 1250 && state.page <= 1258 ? `windows-${state.page}` : undefined)
    try {
      if (!encoding && pending.some((byte) => byte >= 128)) throw new Error()
      append(new TextDecoder(encoding ?? 'utf-8', { fatal: true }).decode(Uint8Array.from(pending)))
    } catch {
      throw new Error(t('rtf.theRtfUsesATextEncodingThatCannot'))
    }
    pending = []
  }

  function byte(value: number) {
    if (skip) skip--
    else pending.push(value)
  }

  function endParagraph() {
    paragraphs.push({ type: 'paragraph', content: runs })
    runs = []
  }

  let offset = 0
  while (offset < source.length) {
    token.lastIndex = offset
    const match = token.exec(source)
    if (!match) throw new Error(t('rtf.anRtfControlSequenceIsDamaged'))
    offset = token.lastIndex
    const [value, control, param, hex, symbol] = match
    if (value === '{') {
      flush()
      if (groups.length >= 256) throw new Error(t('rtf.theRtfGroupsAreNestedTooDeeply'))
      groups.push(state)
      state = { ...state }
    } else if (value === '}') {
      flush()
      const parent = groups.pop()
      if (!parent || (!groups.length && offset < source.length)) throw new Error(t('rtf.theRtfGroupStructureIsDamaged'))
      state = parent
      skip = 0
    } else if (control === 'bin') {
      const count = Number(param)
      if (!Number.isSafeInteger(count) || count < 0 || count > source.length - offset) throw new Error(t('rtf.anRtfBinaryPartIsDamaged'))
      offset += count
    } else if (!state.skip) {
      if (hex) byte(Number.parseInt(hex, 16))
      else if (symbol && /[{}\\]/.test(symbol)) byte(symbol.charCodeAt(0))
      else if (!control && !symbol) {
        for (let i = 0; i < value.length; i++) if (value[i] !== '\r' && value[i] !== '\n') byte(value.charCodeAt(i))
      } else {
        flush()
        if (symbol === '*' || destinations.has(control)) state.skip = true
        else if (control === 'ansicpg') state.page = Number(param)
        else if (control === 'uc') state.fallback = Math.max(0, Math.min(10, Number(param) || 0))
        else if (control === 'u' && param !== undefined) {
          append(String.fromCharCode(Number(param) & 0xffff))
          skip = state.fallback
        } else if (control === 'par' || control === 'page') endParagraph()
        else if (control === 'line') runs.push({ type: 'hardBreak' })
        else if (control === 'tab') append('\t')
        else if (Object.hasOwn(markNames, control)) state[control as keyof typeof markNames] = param !== '0'
        else if (control === 'ulnone') state.ul = false
        else if (control === 'plain') state.b = state.i = state.ul = state.strike = false
        else if (Object.hasOwn(punctuation, control)) append(punctuation[control])
        else if (symbol === '~' || symbol === '_') append(symbol === '~' ? '\u00a0' : '\u2011')
      }
    }
  }

  if (groups.length) throw new Error(t('rtf.theRtfGroupStructureIsDamaged'))
  endParagraph()
  if (!paragraphs.some((paragraph) => paragraph.content?.some((node) => node.text?.trim()))) throw new Error(t('rtf.noReadableTextWasFoundInTheRtf'))
  return { type: 'doc', content: paragraphs }
}
