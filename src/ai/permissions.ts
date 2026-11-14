import type { Book } from '../library'
import type { Idea } from '../ideas'
import type { LibraryId } from '../library'
import type { PermissionKey } from './types'

export function isValidLibraryId(value: unknown): value is LibraryId {
  return value === 'original' || value === 'reference'
}

export function hasPermission(client: AiClientSummary, permission: PermissionKey): boolean {
  return Boolean(client.enabled && client.permissions?.[permission] === true)
}

export function isWorkInScope(client: AiClientSummary, bookId: string): boolean {
  if (!client.enabled) return false
  if (client.scope.mode === 'all') return true
  if (client.scope.mode === 'selected') {
    return client.scope.workIds.includes(bookId)
  }
  return false
}

export function canCreateTopLevelWork(client: AiClientSummary): boolean {
  return hasPermission(client, 'create') && client.scope.mode === 'all'
}

export function canCreateInsideWork(client: AiClientSummary, bookId: string): boolean {
  return hasPermission(client, 'create') && isWorkInScope(client, bookId)
}

export function filterAuthorizedBooks<T extends Pick<Book, 'id' | 'workId'>>(
  client: AiClientSummary,
  books: readonly T[],
): T[] {
  if (!client.enabled || client.scope.mode === 'none') return []
  if (client.scope.mode === 'all') return [...books]
  const allowed = new Set(client.scope.workIds)
  return books.filter((book) => allowed.has(book.workId || book.id))
}

export function isIdeaInScope(client: AiClientSummary, idea: Idea): boolean {
  if (!client.enabled || client.scope.mode === 'none') return false
  if (client.scope.mode === 'all') return true
  if (!idea.bookId) return false
  return client.scope.workIds.includes(idea.bookId)
}

export function canAssignIdeaWork(client: AiClientSummary, work: { library: LibraryId; bookId: string } | undefined): boolean {
  if (!client.enabled || client.scope.mode === 'none') return false
  if (client.scope.mode === 'all') return true
  if (!work) return false
  return client.scope.workIds.includes(work.bookId)
}
