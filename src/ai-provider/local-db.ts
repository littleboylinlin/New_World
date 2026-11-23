const databaseName = 'new-world-ai-providers'
export const configStore = 'config'
export const summaryStore = 'summaries'
export const storyIgnoreStore = 'storyCheckIgnored'
let opening: Promise<IDBDatabase> | undefined

function database(): Promise<IDBDatabase> {
  if (opening) return opening
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 3)
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) request.result.createObjectStore(configStore)
      if (event.oldVersion < 2) request.result.createObjectStore(summaryStore)
      if (event.oldVersion < 3) request.result.createObjectStore(storyIgnoreStore)
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); opening = undefined }
      resolve(db)
    }
  })
  const pending = opening
  void pending.catch(() => { if (opening === pending) opening = undefined })
  return pending
}

export async function localTransaction<T>(
  storeName: string, mode: IDBTransactionMode,
  work: (store: IDBObjectStore, finish: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode)
    let result: T
    let failure: unknown
    transaction.oncomplete = () => resolve(result)
    transaction.onabort = () => reject(failure ?? transaction.error)
    const fail = (error: unknown) => { failure = error; transaction.abort() }
    try {
      work(transaction.objectStore(storeName), (value) => { result = value }, fail)
    } catch (error) {
      fail(error)
    }
  })
}
