import { AnnotationMode, GlobalWorkerOptions, VerbosityLevel, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

const maxPdfPreviewSize = 64 * 1024 * 1024

export async function openPdf(blob: Blob, signal: AbortSignal) {
  if (blob.size > maxPdfPreviewSize) throw new Error('文件超过 64 MiB 的 PDF 预览上限。')
  const data = new Uint8Array(await blob.arrayBuffer())
  signal.throwIfAborted()
  const assets = new URL(`${import.meta.env.BASE_URL}pdfjs/`, location.href).href
  const task = getDocument({
    data,
    cMapUrl: `${assets}cmaps/`,
    standardFontDataUrl: `${assets}standard_fonts/`,
    iccUrl: `${assets}iccs/`,
    wasmUrl: `${assets}wasm/`,
    enableXfa: false,
    maxImageSize: 32_000_000,
    canvasMaxAreaInBytes: 32_000_000,
    stopAtErrors: true,
    verbosity: VerbosityLevel.ERRORS,
  })
  const close = () => {
    signal.removeEventListener('abort', close)
    void task.destroy().catch(() => {})
  }
  signal.addEventListener('abort', close, { once: true })

  try {
    const pdf = await task.promise
    if (pdf.numPages < 1) throw new Error('PDF has no pages')
    return {
      length: pdf.numPages,
      async readText(index: number) {
        const page = await pdf.getPage(index + 1)
        signal.throwIfAborted()
        try {
          const { items } = await page.getTextContent()
          return items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('')
        } finally {
          page.cleanup()
        }
      },
      async renderPage(index: number) {
        const page = await pdf.getPage(index + 1)
        signal.throwIfAborted()
        const original = page.getViewport({ scale: 1 })
        if (!Number.isFinite(original.width * original.height) || original.width <= 0 || original.height <= 0) {
          throw new Error('PDF 页面尺寸异常。')
        }
        const density = Math.min(devicePixelRatio || 1, 2)
        const scale = Math.min(880 * density / original.width, 4096 / original.height, Math.sqrt(6_000_000 / (original.width * original.height)))
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.ceil(viewport.width))
        canvas.height = Math.max(1, Math.ceil(viewport.height))
        canvas.setAttribute('role', 'img')
        canvas.setAttribute('aria-label', `PDF 第 ${index + 1} 页`)
        const render = page.render({ canvas, viewport, annotationMode: AnnotationMode.DISABLE })
        const cancel = () => render.cancel()
        signal.addEventListener('abort', cancel, { once: true })
        try {
          await render.promise
          return canvas
        } catch {
          signal.throwIfAborted()
          throw new Error('无法渲染这一页 PDF。')
        } finally {
          signal.removeEventListener('abort', cancel)
          page.cleanup()
        }
      },
    }
  } catch (error) {
    close()
    signal.throwIfAborted()
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('此 PDF 需要密码，当前版本仅保存原文件。')
    throw new Error('无法打开此 PDF。文件可能损坏或使用了无法预览的内容。')
  }
}
