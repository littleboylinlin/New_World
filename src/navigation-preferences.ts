export function preference<T extends string>(key: string, values: readonly T[], fallback: T) {
  let current = fallback
  try {
    const stored = localStorage.getItem('new-world:' + key) as T | null
    if (stored && values.includes(stored)) current = stored
  } catch { /* Preferences still work for this session. */ }
  return {
    get: () => current,
    set(value: T) {
      current = value
      try { localStorage.setItem('new-world:' + key, value) } catch { /* Keep the in-memory choice. */ }
    },
  }
}

export const writingFilter = preference('writing-filter', ['all', 'original', 'reference'] as const, 'all')
export const writingSort = preference('writing-sort', ['added', 'opened', 'title'] as const, 'added')
/** How the home page shows recent projects: a list of rows or the library's covers. */
export const recentStyle = preference('recent-style', ['list', 'cover'] as const, 'list')
