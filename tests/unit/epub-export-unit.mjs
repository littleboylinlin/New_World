import test from 'node:test'
import assert from 'node:assert/strict'
import { TextWriter, Uint8ArrayReader, ZipReader } from '@zip.js/zip.js'
import { epubExport } from '../../src/documents/epub-export.ts'

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGNg+M/AAAQAAQAA/wH84XAAAAAASUVORK5CYII=',
  'base64',
)
const pngDataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`

// Minimal 1x1 JPEG bytes (SOI + APP0 + SOF0 + EOI) sufficient for magic header detection and packaging.
const jpegBytes = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
])
const jpegDataUrl = `data:image/jpeg;base64,${jpegBytes.toString('base64')}`

async function readEpubArchive(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const zip = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false })
  try {
    const entries = await zip.getEntries()
    const texts = new Map()
    const binaries = new Map()
    for (const entry of entries) {
      if (entry.filename.endsWith('.png') || entry.filename.endsWith('.jpg')) {
        const chunks = []
        await entry.getData(new WritableStream({
          write(chunk) { chunks.push(Uint8Array.from(chunk)) },
        }))
        binaries.set(entry.filename, Buffer.concat(chunks))
      } else {
        texts.set(entry.filename, await entry.getData(new TextWriter()))
      }
    }
    return { bytes, entries, texts, binaries }
  } finally {
    await zip.close()
  }
}

test('EPUB 压缩包满足 OCF 规范：mimetype 排首位且不压缩，包含必需骨架文件', async () => {
  const blob = await epubExport({
    title: '雾港笔记',
    author: '林深',
    fallbackLanguage: 'en',
    identifier: 'urn:uuid:11111111-2222-3333-4444-555555555555',
    modified: new Date('2026-11-22T08:00:00.123Z'),
    cover: new Blob([pngBytes], { type: 'image/png' }),
    chapters: [
      {
        title: '第一章 雾起',
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '码头响起了汽笛声。' }] },
            { type: 'image', attrs: { src: pngDataUrl, alt: '雾港插图' } },
          ],
        },
      },
      {
        title: '第二章 归船',
        content: {
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '第二章 归船' }] },
            { type: 'paragraph', content: [{ type: 'text', text: '灯塔在夜色里亮起来。' }] },
            { type: 'image', attrs: { src: pngDataUrl, alt: '重复插图' } },
            { type: 'image', attrs: { src: jpegDataUrl, alt: '夜景照片' } },
          ],
        },
      },
    ],
    labels: { toc: '目录', cover: '封面', author: '作者', synopsis: '作品简介', imageFallback: '［图片］' },
  })

  const { bytes, entries, texts, binaries } = await readEpubArchive(blob)

  // Check raw ZIP Local File Header at byte 0: PK\x03\x04, flags, method=0, name="mimetype", extra=0, payload="application/epub+zip".
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(view.getUint32(0, true), 0x04034b50)
  const flags = view.getUint16(6, true)
  const compressionMethod = view.getUint16(8, true)
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  assert.equal(flags & 0x08, 0, 'mimetype must not use a data descriptor')
  assert.equal(compressionMethod, 0, 'mimetype must be stored uncompressed (method 0)')
  assert.equal(nameLength, 8)
  assert.equal(extraLength, 0)
  assert.equal(Buffer.from(bytes.subarray(30, 38)).toString('utf8'), 'mimetype')
  assert.equal(Buffer.from(bytes.subarray(38, 58)).toString('utf8'), 'application/epub+zip')

  assert.equal(entries[0].filename, 'mimetype')
  assert.equal(entries[0].compressionMethod, 0)
  assert.equal(texts.get('mimetype'), 'application/epub+zip')

  const container = texts.get('META-INF/container.xml')
  assert.ok(container)
  assert.match(container, /full-path="OEBPS\/content\.opf"/)
  assert.match(container, /media-type="application\/oebps-package\+xml"/)

  const opf = texts.get('OEBPS/content.opf')
  assert.ok(opf)
  assert.match(opf, /version="3\.0"/)
  assert.match(opf, /unique-identifier="book-id"/)
  assert.match(opf, /<dc:identifier id="book-id">urn:uuid:11111111-2222-3333-4444-555555555555<\/dc:identifier>/)
  assert.match(opf, /<dc:title>雾港笔记<\/dc:title>/)
  assert.match(opf, /<dc:creator>林深<\/dc:creator>/)
  assert.match(opf, /<dc:language>zh-CN<\/dc:language>/)
  assert.match(opf, /<meta property="dcterms:modified">2026-11-22T08:00:00Z<\/meta>/)
  assert.match(opf, /<meta name="cover" content="cover-image"\/>/)
  assert.match(opf, /id="cover-image" href="images\/cover\.png" media-type="image\/png" properties="cover-image"/)
  assert.match(opf, /id="nav" href="nav\.xhtml" media-type="application\/xhtml\+xml" properties="nav"/)
  assert.match(opf, /id="ncx" href="toc\.ncx" media-type="application\/x-dtbncx\+xml"/)
  assert.match(opf, /<spine toc="ncx">/)

  const spineOrder = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map((m) => m[1])
  assert.deepEqual(spineOrder, ['cover', 'chapter-001', 'chapter-002'])

  const nav = texts.get('OEBPS/nav.xhtml')
  assert.ok(nav)
  assert.match(nav, /epub:type="toc"/)
  assert.match(nav, /<h1>目录<\/h1>/)
  assert.match(nav, /<a href="chapters\/chapter-001\.xhtml">第一章 雾起<\/a>[\s\S]*<a href="chapters\/chapter-002\.xhtml">第二章 归船<\/a>/)

  const ncx = texts.get('OEBPS/toc.ncx')
  assert.ok(ncx)
  assert.match(ncx, /<meta name="dtb:uid" content="urn:uuid:11111111-2222-3333-4444-555555555555"\/>/)
  assert.match(ncx, /<docTitle><text>雾港笔记<\/text><\/docTitle>/)
  assert.match(ncx, /<docAuthor><text>林深<\/text><\/docAuthor>/)
  assert.match(ncx, /playOrder="1"[\s\S]*chapters\/chapter-001\.xhtml[\s\S]*playOrder="2"[\s\S]*chapters\/chapter-002\.xhtml/)

  // Cover and deduplicated chapter illustrations are stored intact.
  assert.deepEqual(binaries.get('OEBPS/images/cover.png'), pngBytes)
  assert.deepEqual(binaries.get('OEBPS/images/image-001.png'), pngBytes)
  assert.deepEqual(binaries.get('OEBPS/images/image-002.jpg'), jpegBytes)
  assert.equal(binaries.has('OEBPS/images/image-003.png'), false, 'identical images should be deduplicated')

  const ch1 = texts.get('OEBPS/chapters/chapter-001.xhtml')
  const ch2 = texts.get('OEBPS/chapters/chapter-002.xhtml')
  assert.match(ch1, /<h1>第一章 雾起<\/h1>/)
  assert.match(ch1, /<img src="\.\.\/images\/image-001\.png" alt="雾港插图"\/>/)
  assert.equal((ch2.match(/<h1>/g) ?? []).length, 1, 'chapter starting with matching h1 should not duplicate heading')
  assert.match(ch2, /<img src="\.\.\/images\/image-001\.png" alt="重复插图"\/>/)
  assert.match(ch2, /<img src="\.\.\/images\/image-002\.jpg" alt="夜景照片"\/>/)
})

test('无封面无作者英文作品、富文本节点与简介扉页导出正确', async () => {
  const blob = await epubExport({
    title: 'Harbor & <Lanterns>',
    fallbackLanguage: 'zh-CN',
    chapters: [
      {
        title: 'Chapter One',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Bold & <safe>', marks: [{ type: 'bold' }] },
                { type: 'text', text: ' ', marks: [] },
                { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
                { type: 'text', text: ' ', marks: [] },
                { type: 'text', text: 'under', marks: [{ type: 'underline' }] },
                { type: 'text', text: ' ', marks: [] },
                { type: 'text', text: 'strike', marks: [{ type: 'strike' }] },
                { type: 'text', text: ' ', marks: [] },
                { type: 'text', text: 'code\x00', marks: [{ type: 'code' }] },
              ],
            },
            { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted line' }] }] },
            { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Third item' }] }] }] },
            { type: 'horizontalRule' },
            {
              type: 'table',
              content: [
                {
                  type: 'tableRow',
                  content: [
                    { type: 'tableHeader', attrs: { colspan: 2 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Header' }] }] },
                  ],
                },
                {
                  type: 'tableRow',
                  content: [
                    { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
                    { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
                  ],
                },
              ],
            },
            { type: 'image', attrs: { src: 'https://example.invalid/remote.png', alt: 'Remote' } },
          ],
        },
      },
    ],
    information: {
      title: 'Harbor & <Lanterns>',
      subtitle: 'Book I',
      synopsis: 'Line one\nLine two',
    },
  })

  const { texts } = await readEpubArchive(blob)
  const opf = texts.get('OEBPS/content.opf')
  const ncx = texts.get('OEBPS/toc.ncx')
  const ch1 = texts.get('OEBPS/chapters/chapter-001.xhtml')
  const titlepage = texts.get('OEBPS/titlepage.xhtml')

  assert.match(opf, /<dc:language>en<\/dc:language>/)
  assert.match(opf, /<dc:title>Harbor &amp; &lt;Lanterns&gt;<\/dc:title>/)
  assert.doesNotMatch(opf, /<dc:creator>/)
  assert.doesNotMatch(opf, /cover-image/)
  assert.equal(texts.has('OEBPS/cover.xhtml'), false)
  assert.doesNotMatch(ncx, /<docAuthor>/)
  assert.ok(titlepage)
  assert.match(titlepage, /Book I/)
  assert.match(titlepage, /Line one<br\/>Line two/)

  const spineOrder = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map((m) => m[1])
  assert.deepEqual(spineOrder, ['titlepage', 'chapter-001'])

  assert.match(ch1, /<strong>Bold &amp; &lt;safe&gt;<\/strong>/)
  assert.match(ch1, /<em>italic<\/em>/)
  assert.match(ch1, /<u>under<\/u>/)
  assert.match(ch1, /<s>strike<\/s>/)
  assert.match(ch1, /<code>code<\/code>/)
  assert.match(ch1, /<blockquote><p>Quoted line<\/p><\/blockquote>/)
  assert.match(ch1, /<ol start="3"><li><p>Third item<\/p><\/li><\/ol>/)
  assert.match(ch1, /<hr\/>/)
  assert.match(ch1, /<th colspan="2"><p>Header<\/p><\/th>/)
  assert.match(ch1, /<p>\[Remote\]<\/p>/)
  assert.equal(ch1.includes('\x00'), false)
})
