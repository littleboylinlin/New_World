import { maxEditionImageBytes, maxImageBytes } from './model'

const raster = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i
const removedTags = new Set('head title script style link meta base iframe object embed svg math template noscript form input button select textarea video audio source canvas'.split(' '))
const allowedTags = new Set('a article aside blockquote br caption code del div em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img li main ol p pre s section span strike strong sub sup table tbody td th thead tr u ul b'.split(' '))
const inlineStyleTags = new Set('a b code em i span strong u p h1 h2 h3 h4 h5 h6'.split(' '))

function imageMime(bytes: Uint8Array) {
  const signature = String.fromCharCode(...bytes.subarray(0, 12))
  if (signature.startsWith('\x89PNG\r\n\x1a\n')) return 'png'
  if (signature.startsWith('\xff\xd8\xff')) return 'jpeg'
  if (signature.startsWith('GIF87a') || signature.startsWith('GIF89a')) return 'gif'
  if (signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP') return 'webp'
}

export function imageInfo(source: unknown) {
  if (typeof source !== 'string' || source.length > maxImageBytes * 4 / 3 + 40) return
  const match = raster.exec(source)
  if (!match || match[2].length < 16 || match[2].length % 4) return
  const type = match[1].toLowerCase()
  const prefix = Uint8Array.from(atob(match[2].slice(0, 16)), (char) => char.charCodeAt(0))
  const bytes = match[2].length * 3 / 4 - (source.endsWith('==') ? 2 : source.endsWith('=') ? 1 : 0)
  if (type === imageMime(prefix) && bytes <= maxImageBytes) return { type, bytes, base64: match[2] }
}

export async function rasterData(blob: Blob) {
  if (blob.size > maxImageBytes) return undefined
  const type = imageMime(new Uint8Array(await blob.slice(0, 12).arrayBuffer()))
  if (!type) return undefined
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(new Blob([blob], { type: `image/${type}` }))
  })
}

export function inertMarkup(source: string) {
  const template = document.createElement('template')
  template.innerHTML = source
  return template
}

export function imageBudget() {
  return { remaining: maxEditionImageBytes, omitted: 0 }
}

export function cleanMarkup(template: HTMLTemplateElement, budget = imageBudget()) {
  for (const node of template.content.querySelectorAll('*')) {
    if (!template.content.contains(node)) continue
    const tag = node.localName.toLowerCase()
    if (node.hasAttribute('hidden') || removedTags.has(tag)) {
      node.remove()
      continue
    }
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !allowedTags.has(tag)) {
      const fragment = template.ownerDocument.createDocumentFragment()
      while (node.firstChild) fragment.append(node.firstChild)
      node.replaceWith(fragment)
      continue
    }

    const source = node.getAttribute('src')
    const alt = node.getAttribute('alt')?.slice(0, 255) ?? ''
    const style = node.getAttribute('style') ?? ''
    const start = Number(node.getAttribute('start'))
    const spans = ['colspan', 'rowspan'].map((name) => [name, Number(node.getAttribute(name))] as const)
    for (const name of node.getAttributeNames()) node.removeAttribute(name)
    if (tag === 'img') {
      const info = imageInfo(source)
      if (!info || info.bytes > budget.remaining) {
        budget.omitted++
        node.replaceWith(`[图片未导入${alt ? `：${alt}` : ''}]`)
      } else {
        budget.remaining -= info.bytes
        node.setAttribute('src', source!)
        if (alt) node.setAttribute('alt', alt)
      }
    } else if (tag === 'ol' && Number.isInteger(start) && start > 0 && start < 100_000) {
      node.setAttribute('start', String(start))
    } else if (tag === 'td' || tag === 'th') {
      for (const [name, value] of spans) if (Number.isInteger(value) && value > 1 && value <= 100) node.setAttribute(name, String(value))
    }

    if (style && inlineStyleTags.has(tag) && node.childNodes.length) {
      const marks = []
      if (/(?:^|;)\s*font-weight\s*:\s*(?:bold|[6-9]00)\b/i.test(style)) marks.push('strong')
      if (/(?:^|;)\s*font-style\s*:\s*italic\b/i.test(style)) marks.push('em')
      if (/text-decoration(?:-line)?\s*:[^;]*\bunderline\b/i.test(style)) marks.push('u')
      if (/text-decoration(?:-line)?\s*:[^;]*\bline-through\b/i.test(style)) marks.push('s')
      for (const mark of marks) {
        const wrapper = template.ownerDocument.createElement(mark)
        while (node.firstChild) wrapper.append(node.firstChild)
        node.append(wrapper)
      }
    }
  }
  return template.innerHTML
}
