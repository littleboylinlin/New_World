import { BlobReader, BlobWriter, ZipReader, ZipWriter } from '@zip.js/zip.js'
import type { FileEntry } from '@zip.js/zip.js'
import { runningVersion } from '../updates'
import { limits, projectFormat, projectSchemaVersion, readableProjectSchemas, projectStores, legacyProjectStores, projectTaskStores, ProjectError, recordPaths, requireValid as ok } from './model'
import { MetadataError, validateWorkMetadata } from '../work-metadata'
import { TaskDataError } from '../tasks/model'
import type { ProjectContents, ProjectData, ProjectManifest, ProjectRoot, Resource } from './model'
import { detachedIds, fields, safeJson, sha256, sha256Pattern, validateData, validatePayloads } from './validate'

export const projectMime = 'application/vnd.newworld.project+zip'
const decoder = new TextDecoder('utf-8', { fatal: true })
export function safePath(path: string) {
  return typeof path === 'string' && path.length <= 240 && /^[a-z0-9][a-z0-9./-]*$/.test(path)
    && path.split('/').every((s) => !!s && s !== '.' && s !== '..')
}

export async function packProject(data: ProjectData, root: ProjectRoot) {
  const detached = detachedIds(data)
  validateData(data, root, detached)
  await validatePayloads(data)
  const resources: Resource[] = []
  const payloads = new Map<string, Blob>()
  const store = async (path: string, blob: Blob, kind: Resource['kind']) => {
    const hash = await sha256(blob)
    if (!payloads.has(path)) {
      payloads.set(path, blob)
      resources.push({ path, bytes: blob.size, sha256: hash, mediaType: blob.type, kind })
    }
    return path
  }
  const encode = async (value: unknown, folder: string): Promise<unknown> => {
    if (value instanceof Blob || value instanceof Uint8Array) {
      const kind = value instanceof Blob ? 'blob' : 'bytes'
      const blob = value instanceof Blob ? value : new Blob([Uint8Array.from(value)])
      // MIME participates in the path so identical bytes with different media types remain exact.
      const identity = await sha256(new Blob([await sha256(blob), '\n', blob.type]))
      const path = await store(`${folder}/${identity}.bin`, blob, kind)
      return { $resource: path }
    }
    if (Array.isArray(value)) return Promise.all(value.map((v) => encode(v, folder)))
    if (value && typeof value === 'object') {
      const entries = []
      for (const [k, v] of Object.entries(value)) {
        ok(k !== '$resource', 'reserved resource marker')
        if (v !== undefined) entries.push([k, await encode(v, k === 'blob' ? 'originals' : k === 'data' ? 'revisions/payloads' : 'assets')])
      }
      return Object.fromEntries(entries)
    }
    return value
  }
  for (const name of projectStores) {
    const encoded = await encode(data[name], 'assets')
    await store(recordPaths[name], new Blob([JSON.stringify(encoded)], { type: 'application/json' }), 'json')
  }
  const manifest: ProjectManifest = {
    format: projectFormat, schemaVersion: projectSchemaVersion, appVersion: runningVersion, createdAt: Date.now(),
    root, records: { ...recordPaths }, detached, resources,
  }
  const zip = new ZipWriter(new BlobWriter(projectMime), { useWebWorkers: false, level: 0 })
  await zip.add('manifest.json', new BlobReader(new Blob([JSON.stringify(manifest)])))
  for (const [path, blob] of payloads) await zip.add(path, new BlobReader(blob))
  const blob = await zip.close()
  // The exact same parser used by import checks every export before it reaches disk.
  await readProject(blob)
  return blob
}

/** Completely validates an untrusted archive in memory, without opening IndexedDB. */
export async function readProject(file: Blob): Promise<ProjectContents> {
  if (file.size > limits.archive) throw new ProjectError('limit')
  const zip = new ZipReader(new BlobReader(file), { useWebWorkers: false, strictness: 'strict', filenameValidation: 'strict' })
  try {
    const entries = new Map<string, FileEntry>()
    let declaredTotal = 0
    for await (const entry of zip.getEntriesGenerator()) {
      if (entries.size >= limits.entries) throw new ProjectError('limit')
      ok(((entry.externalFileAttributes >>> 16) & 0o170000) !== 0o120000 && safePath(entry.filename) && !entries.has(entry.filename) && !entry.directory && !entry.encrypted, 'ZIP paths/encryption')
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > limits.entry
        || (entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.ratio)) throw new ProjectError('limit')
      declaredTotal += entry.uncompressedSize
      if (declaredTotal > limits.total) throw new ProjectError('limit')
      entries.set(entry.filename, entry)
    }
    let actualTotal = 0
    const read = async (path: string, max: number, type = '') => {
      const entry = entries.get(path)
      ok(entry, 'missing resource')
      if (entry.uncompressedSize > max) throw new ProjectError('limit')
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let received = 0
      await entry.getData(new WritableStream<Uint8Array>({
        write(chunk) {
          received += chunk.byteLength; actualTotal += chunk.byteLength
          if (received > max || received > entry.uncompressedSize || actualTotal > limits.total) throw new ProjectError('limit')
          chunks.push(Uint8Array.from(chunk))
        },
      }), { checkSignature: true, checkOverlappingEntry: true })
      ok(received === entry.uncompressedSize, 'ZIP size')
      return new Blob(chunks, { type })
    }
    const json = async (blob: Blob) => {
      const value = JSON.parse(decoder.decode(await blob.arrayBuffer()))
      safeJson(value)
      return value
    }
    const manifest = await json(await read('manifest.json', limits.json)) as ProjectManifest
    fields(manifest, 'format schemaVersion appVersion createdAt root records detached resources')
    ok(manifest.format === projectFormat && Number.isSafeInteger(manifest.schemaVersion), 'format identifier')
    if (!readableProjectSchemas.includes(manifest.schemaVersion as 1 | 2 | 3)) throw new ProjectError('version')
    ok(typeof manifest.appVersion === 'string' && Number.isSafeInteger(manifest.createdAt) && manifest.createdAt >= 0, 'manifest metadata')
    fields(manifest.root, 'library id')
    const stores=manifest.schemaVersion>=3?projectStores:legacyProjectStores
    fields(manifest.records, stores.join(' '))
    ok(Array.isArray(manifest.resources), 'resource inventory')
    const resources = new Map<string, Resource>()
    for (const r of manifest.resources) {
      fields(r, 'path bytes sha256 mediaType kind')
      ok(safePath(r.path) && r.path !== 'manifest.json' && !resources.has(r.path) && entries.has(r.path)
        && Number.isSafeInteger(r.bytes) && r.bytes >= 0 && r.bytes === entries.get(r.path)!.uncompressedSize
        && typeof r.sha256 === 'string' && sha256Pattern.test(r.sha256) && typeof r.mediaType === 'string'
        && r.mediaType.length <= 255 && !/[\x00-\x1f]/.test(r.mediaType) && ['json', 'blob', 'bytes'].includes(r.kind), 'resource inventory entry')
      resources.set(r.path, r)
    }
    ok(entries.size === resources.size + 1, 'unlisted ZIP resource')
    const decoded = new Map<string, Blob>()
    for (const r of resources.values()) {
      const blob = await read(r.path, r.kind === 'json' ? limits.json : limits.entry, r.mediaType)
      if (await sha256(blob) !== r.sha256) throw new ProjectError('resource')
      decoded.set(r.path, blob)
    }
    const used = new Set<string>()
    const decode = async (value: any, depth = 0): Promise<any> => {
      if (depth > 64) throw new ProjectError('limit')
      if (Array.isArray(value)) return Promise.all(value.map((v) => decode(v, depth + 1)))
      if (value && typeof value === 'object') {
        if (Object.hasOwn(value, '$resource')) {
          fields(value, '$resource')
          const r = resources.get(value.$resource)
          ok(r && r.kind !== 'json', 'binary resource reference')
          used.add(r.path)
          const blob = decoded.get(r.path)!
          return r.kind === 'blob' ? blob : new Uint8Array(await blob.arrayBuffer())
        }
        return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => {
          // Metadata is opaque JSON, never a binary reference or a new application setting.
          if (k === 'metadata') { validateWorkMetadata(v); return [k, v] }
          return [k, await decode(v, depth + 1)]
        })))
      }
      return value
    }
    const data = {} as ProjectData
    for (const name of stores) {
      const path = manifest.records[name]
      ok(path === recordPaths[name] && resources.get(path)?.kind === 'json', 'record path')
      used.add(path)
      ;(data[name] as unknown) = await decode(await json(decoded.get(path)!))
    }
    if(manifest.schemaVersion<3){fields(manifest.detached,'books editions chapters ideas');manifest.detached.tasks=[];for(const name of projectTaskStores)(data[name] as unknown[])=[]}
    ok(used.size === resources.size, 'unreferenced resource')
    validateData(data, manifest.root, manifest.detached, manifest.schemaVersion)
    await validatePayloads(data)
    return { manifest, data }
  } catch (error) {
    if(error instanceof TaskDataError)throw new ProjectError('unsupported',error.detail)
    if (error instanceof MetadataError) throw new ProjectError('metadata', error.field)
    if (error instanceof ProjectError) throw error
    throw new ProjectError('format')
  } finally { await zip.close() }
}
