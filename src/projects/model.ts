import type { AiChapterBaseline, Book, BookFile, ChapterRevision, IdeaRevision, LibraryId, RevisionBlobRecord, TrashEntry } from '../library'
import type { ChapterRecord, Edition } from '../documents/model'
import type { Idea } from '../ideas'

export const projectFormat = 'new-world-project'
export const projectSchemaVersion = 2
export const readableProjectSchemas = [1, 2] as const
export const projectStores = ['books', 'files', 'editions', 'chapters', 'ideas', 'revisions', 'revisionBlobs', 'ideaRevisions', 'aiBaselines', 'trash'] as const
export type ProjectStore = typeof projectStores[number]
export interface ProjectData {
  books: Book[]
  files: BookFile[]
  editions: Edition[]
  chapters: ChapterRecord[]
  ideas: Idea[]
  revisions: ChapterRevision[]
  revisionBlobs: RevisionBlobRecord[]
  ideaRevisions: IdeaRevision[]
  aiBaselines: AiChapterBaseline[]
  trash: TrashEntry[]
}
export interface ProjectRoot { library: LibraryId; id: string }
/** IDs referenced by history/provenance whose live records no longer exist. Never fabricated rows. */
export interface Detached { books: string[]; editions: string[]; chapters: string[]; ideas: string[] }
export interface Resource {
  path: string
  bytes: number
  sha256: string
  mediaType: string
  kind: 'json' | 'blob' | 'bytes'
}
export interface ProjectManifest {
  format: typeof projectFormat
  schemaVersion: number
  appVersion: string
  createdAt: number
  root: ProjectRoot
  records: Record<ProjectStore, string>
  detached: Detached
  resources: Resource[]
}
export interface ProjectContents {
  manifest: ProjectManifest
  data: ProjectData
}
export const limits = {
  archive: 512 * 1024 * 1024,
  total: 512 * 1024 * 1024,
  entry: 128 * 1024 * 1024,
  json: 32 * 1024 * 1024,
  entries: 10_000,
  records: 50_000,
  ratio: 200,
}
export class ProjectError extends Error {
  constructor(readonly code: 'format' | 'version' | 'limit' | 'conflict' | 'resource' | 'metadata' | 'unsupported', readonly detail = '') {
    super(`project.${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'ProjectError'
  }
}
export function requireValid(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new ProjectError('format', detail)
}
export const recordPaths: Record<ProjectStore, string> = {
  books: 'books.json', files: 'originals/index.json', editions: 'editions/index.json', chapters: 'chapters/index.json',
  ideas: 'ideas/index.json', revisions: 'revisions/chapters.json', revisionBlobs: 'revisions/blobs.json',
  ideaRevisions: 'revisions/ideas.json', aiBaselines: 'revisions/baselines.json', trash: 'trash/index.json',
}
