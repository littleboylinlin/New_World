export async function createLegacyDatabase(version) {
  const q = indexedDB.open('new-world-library', version)
  q.onupgradeneeded = () => {
    const db = q.result
    const books = db.createObjectStore('books', { keyPath: ['library', 'id'] })
    books.createIndex('byLibrary', 'library'); books.createIndex('byLibraryDigest', ['library', 'digest'], { unique: version < 8 })
    db.createObjectStore('files', { keyPath: ['library', 'id'] })
    const editions = db.createObjectStore('editions', { keyPath: ['library', 'bookId', 'id'] })
    editions.createIndex('byBook', ['library', 'bookId']); editions.createIndex('byName', ['library', 'bookId', 'name'], { unique: true })
    const chapters = db.createObjectStore('chapters', { keyPath: ['library', 'bookId', 'editionId', 'id'] })
    chapters.createIndex('byBook', ['library', 'bookId']); chapters.createIndex('byEdition', ['library', 'bookId', 'editionId'])
    for (const [name, keyPath] of [['trash','id'], ['ideas','id'], ['writingDays','date'], ['revisionBlobs','hash']]) db.createObjectStore(name, { keyPath })
    const revisions = db.createObjectStore('revisions', { keyPath: 'id' })
    revisions.createIndex('byChapter', ['library', 'bookId', 'editionId', 'chapterId']); revisions.createIndex('byEdition', ['library', 'bookId', 'editionId']); revisions.createIndex('byBook', ['library', 'bookId'])
    const baselines = db.createObjectStore('aiBaselines', { keyPath: ['clientId', 'library', 'bookId', 'editionId', 'chapterId'] })
    baselines.createIndex('byEdition', ['library', 'bookId', 'editionId']); baselines.createIndex('byBook', ['library', 'bookId'])
    const ideas = db.createObjectStore('ideaRevisions', { keyPath: 'id' }); ideas.createIndex('byIdea', 'ideaId'); ideas.createIndex('byBook', ['library', 'bookId'])
    if (version >= 9) {
      for (const name of ['tasks', 'taskProjects', 'taskSections', 'taskLabels', 'taskCompletions', 'taskFilters', 'taskTemplates', 'taskAttachments', 'taskSettings']) {
        db.createObjectStore(name, { keyPath: 'id' })
      }
    }
    const trash = q.transaction.objectStore('trash')
    if (version >= 10) trash.createIndex('byDeletedAt', 'deletedAt')
    if (version >= 11) db.createObjectStore('writingStyles', { keyPath: 'id' })
    if (version >= 12) trash.createIndex('byWorkKind', ['library', 'bookId', 'kind'])
    if (version >= 13) db.createObjectStore('storyBoards', { keyPath: ['library', 'bookId'] })
    if (version >= 14) db.createObjectStore('bookChats', { keyPath: 'id' }).createIndex('byBook', ['library', 'bookId'])
  }
  await new Promise((r, j) => { q.onsuccess = r; q.onerror = () => j(q.error) }); q.result.close()
}
