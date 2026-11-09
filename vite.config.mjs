import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  base: './',
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/pdfjs-dist/{cmaps,iccs,standard_fonts,wasm}',
          dest: 'pdfjs',
          rename: { stripBase: 2 },
        },
        { src: 'node_modules/pdfjs-dist/LICENSE', dest: 'licenses', rename: { stripBase: true, name: 'pdfjs-dist.txt' } },
        { src: 'node_modules/@zip.js/zip.js/LICENSE', dest: 'licenses', rename: { stripBase: true, name: 'zip.js.txt' } },
      ],
    }),
  ],
})
