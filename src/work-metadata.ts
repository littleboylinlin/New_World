/** Work-scoped, inert JSON. Unknown keys are data, never executable settings or identity references. */
export type MetadataValue = null | boolean | number | string | MetadataValue[] | { [key: string]: MetadataValue }
export interface WorkMetadata {
  author?: string
  synopsis?: string
  subtitle?: string
  tags?: string[]
  status?: string
  [key: string]: MetadataValue | undefined
}
export const workStatuses = ['planning', 'serializing', 'completed', 'paused'] as const
export const metadataLimits = { bytes: 128 * 1024, depth: 12, nodes: 4096, keys: 64, array: 256, keyLength: 128, text: 20000, short: 255, tags: 50, tag: 64, status: 64 }
export class MetadataError extends Error {
  readonly field: string
  constructor(field: string) { super(`Invalid or unsupported work metadata: ${field}`); this.name = 'MetadataError'; this.field = field }
}

export function validateWorkMetadata(value: unknown): asserts value is WorkMetadata {
  const fail = (field: string): never => { throw new MetadataError(field) }
  let nodes = 0
  const visit = (v: unknown, depth: number, path: string): void => {
    if (++nodes > metadataLimits.nodes || depth > metadataLimits.depth) fail(path)
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail(path); return }
    if (!v || typeof v !== 'object') return fail(path)
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || v.length > metadataLimits.array || Object.keys(v).length !== v.length || Reflect.ownKeys(v).length !== v.length + 1) fail(path)
      for (let index = 0; index < v.length; index++) {
        const property = Object.getOwnPropertyDescriptor(v, String(index))
        if (!property || !('value' in property) || !property.enumerable) return fail(path + '[]')
        visit(property.value, depth + 1, path + '[]')
      }
      return
    }
    const prototype = Object.getPrototypeOf(v)
    if (prototype !== Object.prototype && prototype !== null) fail(path)
    const properties = Object.getOwnPropertyDescriptors(v)
    if (Reflect.ownKeys(v).length !== Object.keys(properties).length || Object.keys(properties).length > metadataLimits.keys) fail(path)
    for (const [key, property] of Object.entries(properties)) {
      if (!key || key.length > metadataLimits.keyLength || /[\x00-\x1f]/.test(key)
        || ['__proto__', 'prototype', 'constructor', '$resource'].includes(key) || !('value' in property) || !property.enumerable) fail(path + '.' + key.slice(0, 128))
      visit(property.value, depth + 1, path + '.' + key)
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('metadata')
  visit(value, 0, 'metadata')
  const metadata = value as WorkMetadata
  const line = (v: unknown, limit: number) => typeof v === 'string' && v.length <= limit && !/[\x00-\x1f]/.test(v)
  for (const key of ['author', 'subtitle'] as const) if (Object.hasOwn(metadata, key) && !line(metadata[key], metadataLimits.short)) fail('metadata.' + key)
  if (Object.hasOwn(metadata, 'synopsis') && (typeof metadata.synopsis !== 'string' || metadata.synopsis.length > metadataLimits.text || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(metadata.synopsis))) fail('metadata.synopsis')
  if (Object.hasOwn(metadata, 'status') && !line(metadata.status, metadataLimits.status)) fail('metadata.status')
  if (Object.hasOwn(metadata, 'tags')) {
    if (!Array.isArray(metadata.tags) || metadata.tags.length > metadataLimits.tags || new Set(metadata.tags).size !== metadata.tags.length
      || !metadata.tags.every((tag) => line(tag, metadataLimits.tag) && tag.trim() === tag && tag.length > 0)) fail('metadata.tags')
  }
  if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > metadataLimits.bytes) fail('metadata (UTF-8 size)')
}
