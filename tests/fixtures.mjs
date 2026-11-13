import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from 'docx'

export const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP0yg5lYGBgYmBgYGBgAAAMlwEOZ65fggAAAABJRU5ErkJggg==', 'base64')

// A blank PDF generated with pypdf and encrypted with a test-only password.
export const passwordPdf = () => file('密码原件.pdf', Buffer.from('JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDY0OWU5ZDkxYjE+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyNDAgMzIwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8ZDM2NjA4ODkzZTE1Nzc1OGEyNTc1NmM1ZmE5ZDE0NmZjODI3MzYyYzM5YWU5ZGI0NWE0NjJjODkxYWI4MjM5Yj4KL1UgPDhiZTRlNjRkNDJjYmI1YjA0MDBhODE1ZWJlN2IxZDk2MjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDM4MzIzMjYxNjU2MTM1MzY2MTM1NjEzMTMzMzAzNzYxNjY2NjM3NjU2MjMwMzUzMjY2MzkzMjM4NjUzNjMwMzU+IDwzODMyMzI2MTY1NjEzNTM2NjEzNTYxMzEzMzMwMzc2MTY2NjYzNzY1NjIzMDM1MzI2NjM5MzIzODY1MzYzMDM1PiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK', 'base64'))

export function file(name, content) {
  return { name, mimeType: 'application/octet-stream', buffer: Buffer.from(content) }
}

async function archive(name, entries) {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const [path, contents] of Object.entries(entries)) {
    await zip.add(path, typeof contents === 'string' ? new TextReader(contents) : new Uint8ArrayReader(contents), path === 'mimetype'
      ? { level: 0, dataDescriptor: false, extendedTimestamp: false } : {})
  }
  return file(name, await zip.close())
}

export async function epub({ rich = false, protectedSpine = false } = {}) {
  const xhtml = (body) => `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>试读</title></head><body>${body}</body></html>`
  return archive('纸上森林.EPUB', {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles>
      <rootfile full-path="OEBPS/书籍.opf" media-type="application/oebps-package+xml"/>
    </rootfiles></container>`,
    'OEBPS/书籍.opf': `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="isbn">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="isbn">urn:uuid:6b12f70d-2b2b-4af7-9821-ab9611aa8212</dc:identifier>
      <dc:title>纸上森林</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata>
      <manifest><item id="two" href="章节/第二%20节.xhtml" media-type="application/xhtml+xml"/>
        <item id="one" href="章节/第一节.xhtml" media-type="application/xhtml+xml"/>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        ${rich ? '<item id="picture" href="pixel.png" media-type="image/png"/>' : ''}
      </manifest><spine><itemref idref="one"/><itemref idref="two"/></spine>
    </package>`,
    'OEBPS/nav.xhtml': xhtml('<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="章节/第一节.xhtml">第一节</a></li><li><a href="章节/第二%20节.xhtml">第二节</a></li></ol></nav>'),
    'OEBPS/章节/第一节.xhtml': xhtml(`<h1>纸上森林</h1><p>第一节的树叶响了。</p>${rich ? '<img src="../pixel.png" alt="书中插图"/>' : ''}`),
    'OEBPS/章节/第二 节.xhtml': xhtml('<h1>夜里的灯</h1><p>第二节的窗亮了。</p>'),
    ...(rich ? { 'OEBPS/pixel.png': pixel } : {}),
    ...(protectedSpine ? { 'META-INF/encryption.xml': '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><CipherData><CipherReference URI="OEBPS/章节/第一节.xhtml"/></CipherData></EncryptedData></encryption>' } : {}),
  })
}

export async function docx() {
  return archive('未寄的信.docx', {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`,
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>未寄的信</w:t></w:r></w:p><w:p><w:r><w:t>他把信放在窗边。</w:t><w:br/><w:t>等雨停。</w:t></w:r></w:p>
    </w:body></w:document>`,
  })
}

export async function odt() {
  const office = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'
  const text = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
  const mime = 'application/vnd.oasis.opendocument.text'
  return archive('傍晚的雾.odt', {
    mimetype: mime,
    'content.xml': `<office:document-content xmlns:office="${office}" xmlns:text="${text}" office:version="1.3">
      <office:body><office:text><text:h text:outline-level="1">傍晚的雾</text:h><text:p>巷子<text:s text:c="2"/>起了雾。<text:line-break/>有人走来。</text:p></office:text></office:body>
    </office:document-content>`,
    'META-INF/manifest.xml': `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
      <manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}" manifest:version="1.3"/>
      <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
    </manifest:manifest>`,
  })
}

export async function richDocx() {
  const word = new Document({ sections: [{ children: [
    new Paragraph({ text: '带插图的原稿', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: '加粗中文', bold: true }), new TextRun({ text: '下划线', underline: {} }), new TextRun({ text: '斜体', italics: true })] }),
    new Paragraph({ children: [new ImageRun({ type: 'png', data: pixel, transformation: { width: 24, height: 24 }, altText: { name: '试读插图', description: '试读插图', title: '试读插图' } })] }),
  ] }] })
  return file('带插图的原稿.docx', await Packer.toBuffer(word))
}

export function pdf({ imageOnly = false } = {}) {
  const page = (contents) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 320] /Resources << /Font << /F1 5 0 R /F2 8 0 R >> /XObject << /Im1 11 0 R >> >> /Contents ${contents} 0 R >>`
  const stream = (data) => `<< /Length ${data.length} >>\nstream\n${data}\nendstream`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    page(6), page(7),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(imageOnly ? 'q 160 0 0 160 40 80 cm /Im1 Do Q' : '1 0 0 rg 40 80 160 160 re f 0 g BT /F1 18 Tf 24 275 Td (First page) Tj ET'),
    stream(imageOnly ? 'q 160 0 0 160 40 80 cm /Im1 Do Q' : '0 0 1 rg 40 80 160 160 re f 0 g BT /F2 18 Tf 24 275 Td <4E2D6587> Tj ET'),
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [9 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 /FontDescriptor 10 0 R >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /Ascent 880 /Descent -120 /CapHeight 880 /ItalicAngle 0 /StemV 93 /FontBBox [-25 -254 1000 880] >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\naa55dd>\nendstream',
  ]
  let data = '%PDF-1.4\n'
  const offsets = ['0000000000 65535 f \n']
  for (const [index, object] of objects.entries()) {
    offsets.push(`${String(data.length).padStart(10, '0')} 00000 n \n`)
    data += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const start = data.length
  data += `xref\n0 ${offsets.length}\n${offsets.join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return file(imageOnly ? '影像原件.pdf' : '双页试读.pdf', data)
}

/** Runs an action from a shelf card's menu. Without a title, the only card on the shelf is used. */
export async function bookAction(page, action, title) {
  await page.getByRole('button', { name: title ? `「${title}」的操作` : /」的操作$/ }).click()
  await page.getByRole('menu').getByRole('menuitem', { name: action, exact: true }).click()
}
