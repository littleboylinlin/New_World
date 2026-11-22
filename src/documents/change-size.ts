// Pure helpers for deciding when ordinary writing keeps a history snapshot. No storage here, so the
// rules can be tested on their own.

/** Characters ordinary writing must replace or remove at once to count as a large change. */
export const largeChangeChars = 200
/** …and the share of the chapter they must be. */
export const largeChangeShare = 0.3

/** How many characters of `before` were replaced or removed, measured between the first and last difference. */
export function replacedLength(before: string, after: string) {
  const limit = Math.min(before.length, after.length)
  let start = 0
  while (start < limit && before[start] === after[start]) start++
  let end = 0
  while (end < limit - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  return before.length - start - end
}

/** A select-all replace, a large deletion or a paste over much of the chapter. Additions alone never count. */
export function isLargeChange(before: string, after: string) {
  const replaced = replacedLength(before, after)
  return replaced >= largeChangeChars && replaced >= before.length * largeChangeShare
}
