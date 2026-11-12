import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Arch, Platform, build } from 'electron-builder'

const { name, version, description, author, devDependencies } = JSON.parse(await readFile('package.json', 'utf-8'))
const output = 'dist-windows'
const appDir = join(output, 'app')
await rm(appDir, { recursive: true, force: true })
await mkdir(join(appDir, 'desktop'), { recursive: true })
await mkdir(join(appDir, 'shared'), { recursive: true })
await Promise.all([
  cp('dist', join(appDir, 'dist'), { recursive: true }),
  cp('desktop/main.cjs', join(appDir, 'desktop/main.cjs')),
  cp('desktop/preload.cjs', join(appDir, 'desktop/preload.cjs')),
  cp('desktop/language.cjs', join(appDir, 'desktop/language.cjs')),
  cp('shared/language-packs.mjs', join(appDir, 'shared/language-packs.mjs')),
  cp('public/locales/manifest.json', join(appDir, 'desktop/language-manifest.json')),
  cp('desktop/storage-location.cjs', join(appDir, 'desktop/storage-location.cjs')),
  cp('desktop/close-behavior.cjs', join(appDir, 'desktop/close-behavior.cjs')),
  cp('desktop/tray.png', join(appDir, 'desktop/tray.png')),
  cp('desktop/windows-update.cjs', join(appDir, 'desktop/windows-update.cjs')),
  cp('desktop/windows-release.mjs', join(appDir, 'desktop/windows-release.mjs')),
  writeFile(join(appDir, 'package.json'), JSON.stringify({
    name, version, description, author, main: 'desktop/main.cjs',
  })),
])

await rm(join(appDir, 'dist', 'locales'), { recursive: true, force: true })
const languageManifest = JSON.parse(await readFile('public/locales/manifest.json', 'utf8'))
for (const pack of Object.values(languageManifest.packs)) {
  await cp(join('public/locales', pack.file), join(output, pack.file))
}

await build({
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  publish: 'never',
  config: {
    appId: 'com.littleboylinlin.newworld',
    productName: 'New World',
    electronVersion: devDependencies.electron,
    electronLanguages: ['en-US'],
    directories: { app: appDir, output, buildResources: 'desktop' },
    // The renderer is already bundled and the desktop shell uses only Electron and Node APIs.
    beforeBuild: () => false,
    publish: null,
    win: {
      icon: 'desktop/icon.ico',
      artifactName: 'New-World-Setup-${version}-${arch}.${ext}',
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      createDesktopShortcut: false,
      installerLanguages: ['en_US', 'zh_CN'],
      displayLanguageSelector: false,
      deleteAppDataOnUninstall: false,
      differentialPackage: false,
      include: 'desktop/installer.nsh',
    },
  },
})
