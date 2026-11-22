import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))
// Each build gets its own id, so a deploy without a version bump still reaches open web pages.
const build = process.env.GITHUB_SHA || randomUUID()

function versionFile() {
  return {
    name: 'version-file',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ version, build })}\n` })
    },
  }
}

export default defineConfig({
  base: './',
  define: { __BUILD_ID__: JSON.stringify(build) },
  plugins: [
    versionFile(),
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/pdfjs-dist/{cmaps,iccs,standard_fonts,wasm}',
          dest: 'pdfjs',
          rename: { stripBase: 2 },
        },
        ...dependencyNotices(),
        { src: 'src/fonts/*-OFL.txt', dest: 'licenses' },
        { src: 'src/story-settings/Excalidraw-MIT.txt', dest: 'licenses' },
      ],
    }),
  ],
})
