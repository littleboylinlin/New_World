import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Arch, Platform, build } from 'electron-builder'

const { name, version, description, author, devDependencies } = JSON.parse(await readFile('package.json', 'utf-8'))
const output = 'dist-windows'
const appDir = join(output, 'app')
await rm(appDir, { recursive: true, force: true })
await mkdir(join(appDir, 'desktop'), { recursive: true })
await Promise.all([
  cp('dist', join(appDir, 'dist'), { recursive: true }),
  cp('desktop/main.cjs', join(appDir, 'desktop/main.cjs')),
  cp('desktop/preload.cjs', join(appDir, 'desktop/preload.cjs')),
  writeFile(join(appDir, 'package.json'), JSON.stringify({
    name, version, description, author, main: 'desktop/main.cjs',
  })),
])

await build({
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  publish: 'never',
  config: {
    appId: 'com.littleboylinlin.newworld',
    productName: 'New World',
    electronVersion: devDependencies.electron,
    directories: { app: appDir, output, buildResources: 'desktop' },
    npmRebuild: false,
    win: {
      icon: 'desktop/icon.ico',
      artifactName: 'New-World-Setup-${version}-${arch}.${ext}',
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      runAfterFinish: false,
      deleteAppDataOnUninstall: false,
      differentialPackage: false,
      include: 'desktop/installer.nsh',
    },
  },
})
