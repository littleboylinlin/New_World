import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

function dependencyNotices() {
  const { packages } = JSON.parse(readFileSync(new URL('./package-lock.json', import.meta.url), 'utf-8'))
  return Object.entries(packages).flatMap(([path, info]) => {
    if (!path || info.dev || !existsSync(path)) return []
    const name = path.replace(/^node_modules\//, '').replaceAll('/', '-')
    return readdirSync(path).filter((file) => /^(?:license|licence|copying|notice)(?:[.-].*)?$/i.test(file)).map((file) => ({
      src: `${path}/${file}`, dest: 'licenses', rename: { stripBase: true, name: `${name}-${file}` },
    }))
  })
}

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
        ...dependencyNotices(),
        { src: 'src/fonts/*-OFL.txt', dest: 'licenses' },
      ],
    }),
  ],
})
