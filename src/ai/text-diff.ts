/**
 * Plain-text diff for AI suggestions. It knows nothing about the editor: offsets are UTF-16
 * positions in the original text, and a hunk replaces `[from, to)` of it with `insert`.
 */
export interface TextHunk {
  from: number
  to: number
  insert: string
}

type Op = { kind: 'equal' | 'delete' | 'insert'; text: string }

/**
 * Splits text into the units a diff works on: each Han, kana or other ideograph on its own,
 * runs of letters and digits as words, runs of spaces, and every other character alone.
 */
export function tokenize(text: string): string[] {
  return text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][\p{M}︀-️]*|[\p{L}\p{N}_'’\p{M}]+|\s+|\p{Extended_Pictographic}(?:‍\p{Extended_Pictographic}|[️\p{M}])*|[\s\S]/gu) ?? []
}

/** Myers' O(ND) shortest edit script over two token lists. */
function myers(a: string[], b: string[]): Op[] {
  // Common ends first: most suggestions change little of a long text.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const x0 = a.slice(head, a.length - tail)
  const y0 = b.slice(head, b.length - tail)
  const ops: Op[] = []
  const push = (kind: Op['kind'], text: string) => {
    if (!text) return
    const last = ops[ops.length - 1]
    if (last?.kind === kind) last.text += text
    else ops.push({ kind, text })
  }
  push('equal', a.slice(0, head).join(''))

  const n = x0.length
  const m = y0.length
  if (!n) push('insert', y0.join(''))
  else if (!m) push('delete', x0.join(''))
  else {
    const max = n + m
    const offset = max
    const v = new Int32Array(2 * max + 2)
    const trace: Int32Array[] = []
    let found = false
    for (let d = 0; d <= max && !found; d++) {
      trace.push(v.slice())
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
        let y = x - k
        while (x < n && y < m && x0[x] === y0[y]) { x++; y++ }
        v[offset + k] = x
        if (x >= n && y >= m) { found = true; break }
      }
    }
    // Walk back through the saved frontiers to recover the script.
    const steps: Op[] = []
    let x = n
    let y = m
    for (let d = trace.length - 1; d >= 0; d--) {
      const frontier = trace[d]!
      const k = x - y
      const prevK = k === -d || (k !== d && frontier[offset + k - 1]! < frontier[offset + k + 1]!) ? k + 1 : k - 1
      const prevX = d === 0 ? 0 : frontier[offset + prevK]!
      const prevY = prevX - prevK
      while (x > prevX && y > prevY) { steps.push({ kind: 'equal', text: x0[x - 1]! }); x--; y-- }
      if (d > 0) {
        if (x === prevX) steps.push({ kind: 'insert', text: y0[y - 1]! })
        else steps.push({ kind: 'delete', text: x0[x - 1]! })
      }
      x = prevX
      y = prevY
    }
    for (const step of steps.reverse()) push(step.kind, step.text)
  }
  push('equal', a.slice(a.length - tail).join(''))
  return ops
}

function opsToHunks(ops: Op[], mergeGap: number, boundaries: readonly number[]): TextHunk[] {
  const hunks: TextHunk[] = []
  let position = 0
  let open: TextHunk | null = null
  let gap = ''
  for (const op of ops) {
    if (op.kind === 'equal') {
      if (open) {
        // A one-character island between two changes reads better as part of one change, unless
        // that would join text of two formats.
        const start = open.from
        const end = position + op.text.length
        if (op.text.length <= mergeGap && !boundaries.some((at) => at > start && at <= end)) {
          gap = op.text
          position = end
          continue
        }
        hunks.push(open)
        open = null
      }
      position += op.text.length
      continue
    }
    if (open && gap) {
      open.to += gap.length
      open.insert += gap
    }
    gap = ''
    open ??= { from: position, to: position, insert: '' }
    if (op.kind === 'delete') {
      open.to += op.text.length
      position += op.text.length
    } else open.insert += op.text
  }
  if (open) hunks.push(open)
  return hunks
}

/**
 * The changes that turn `before` into `after`. Changes a short island apart are joined, but never
 * across one of `boundaries` (offsets where the format of `before` changes).
 */
export function diffText(before: string, after: string, { mergeGap = 1, boundaries = [] as readonly number[] } = {}): TextHunk[] {
  if (before === after) return []
  return opsToHunks(myers(tokenize(before), tokenize(after)), mergeGap, boundaries)
}

/**
 * Cuts a hunk wherever the original text changes format (for example from bold to plain), so each
 * piece replaces text of one format and keeps it. The inserted text is shared out by a character
 * diff: each inserted character goes with the original character it follows.
 */
export function splitAtBoundaries(before: string, hunk: TextHunk, boundaries: readonly number[]): TextHunk[] {
  const cuts = boundaries.filter((at) => at > hunk.from && at < hunk.to)
  if (!cuts.length) return [hunk]
  const old = before.slice(hunk.from, hunk.to)
  const ops = myers([...old], [...hunk.insert])
  // For every original character, the inserted text placed before it.
  const pieces: TextHunk[] = []
  const edges = [hunk.from, ...cuts, hunk.to]
  for (let i = 0; i < edges.length - 1; i++) pieces.push({ from: edges[i]!, to: edges[i + 1]!, insert: '' })
  let position = hunk.from
  let piece = 0
  for (const op of ops) {
    if (op.kind === 'insert') {
      // Text inserted exactly at a cut stays with the piece before it.
      const owner = position > hunk.from && position === pieces[piece]!.from && piece > 0 ? piece - 1 : piece
      pieces[owner]!.insert += op.text
      continue
    }
    for (const char of op.text) {
      while (position >= pieces[piece]!.to && piece < pieces.length - 1) piece++
      if (op.kind === 'equal') pieces[piece]!.insert += char
      position += char.length
    }
  }
  // Drop pieces that end up unchanged.
  return pieces.filter((part) => before.slice(part.from, part.to) !== part.insert)
}
