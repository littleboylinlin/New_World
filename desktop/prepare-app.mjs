import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function prepareDesktopApp(output) {
  const metadata = JSON.parse(await readFile('package.json', 'utf8'))
  const appDir = join(output, 'app')
  await rm(appDir, { recursive: true, force: true })
  await mkdir(join(appDir, 'desktop'), { recursive: true })
  await mkdir(join(appDir, 'shared'), { recursive: true })
  const desktopFiles = ['main.cjs', 'preload.cjs', 'language.cjs', 'storage-location.cjs', 'close-behavior.cjs', 'window-theme.cjs', 'spelling.cjs',
    'icon.png', 'tray.png', 'windows-update.cjs', 'windows-release.mjs', 'macos-update.cjs', 'release.mjs',
    'cleanup.cjs', 'macos-install.cjs', 'macos-replace.cjs', 'macos-swap.js']
  await Promise.all([
    cp('dist', join(appDir, 'dist'), { recursive: true }),
    ...desktopFiles.map((file) => cp(join('desktop', file), join(appDir, 'desktop', file))),
    cp('desktop/dictionaries', join(appDir, 'desktop/dictionaries'), { recursive: true }),
    cp('shared/language-packs.mjs', join(appDir, 'shared/language-packs.mjs')),
    cp('public/locales/manifest.json', join(appDir, 'desktop/language-manifest.json')),
    writeFile(join(appDir, 'package.json'), JSON.stringify({
      name: metadata.name, version: metadata.version, description: metadata.description,
      author: metadata.author, main: 'desktop/main.cjs',
    })),
  ])
  await rm(join(appDir, 'dist', 'locales'), { recursive: true, force: true })
  const manifest = JSON.parse(await readFile('public/locales/manifest.json', 'utf8'))
  for (const pack of Object.values(manifest.packs)) await cp(join('public/locales', pack.file), join(output, pack.file))
  return { ...metadata, appDir }
}
