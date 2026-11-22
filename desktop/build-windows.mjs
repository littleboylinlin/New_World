import { readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { Arch, Platform, build } from 'electron-builder'
import { prepareDesktopApp } from './prepare-app.mjs'
import { mirrorBase, onlineInstallerName, windowsPackageName } from './release.mjs'

const output = 'dist-windows'
const { appDir, devDependencies, version } = await prepareDesktopApp(output)
const tag = 'v' + version
const packageName = windowsPackageName(tag)

// Two installers: the full one (offline installs and in-app updates, which verify it by SHA-256) and an
// online one of a few hundred KB that downloads the app package from the mirror while it installs.
await build({
  targets: Platform.WINDOWS.createTarget(['nsis', 'nsis-web'], Arch.x64),
  publish: 'never',
  config: {
    appId: 'com.littleboylinlin.newworld',
    productName: 'New World',
    electronVersion: devDependencies.electron,
    electronLanguages: ['en-US'],
    directories: { app: appDir, output, buildResources: 'desktop' },
    // The renderer is already bundled and the desktop shell uses only Electron and Node APIs.
    fileAssociations: [{ ext: 'newworld', name: 'New_World Project', description: 'New_World novel project', role: 'Viewer', mimeType: 'application/vnd.newworld.project+zip' }],
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
    nsisWeb: {
      artifactName: onlineInstallerName(tag),
      appPackageUrl: mirrorBase + tag + '/' + packageName,
    },
  },
})

// electron-builder puts the online installer and its package in nsis-web/ and names the package after
// package.json; both move next to the full installer, the package under the name the URL above uses.
const web = join(output, 'nsis-web')
const files = await readdir(web)
const packages = files.filter((name) => name.endsWith('.nsis.7z'))
if (packages.length !== 1 || !files.includes(onlineInstallerName(tag))) throw new Error(`Unexpected online installer output: ${files.join(', ')}`)
await rename(join(web, packages[0]), join(output, packageName))
await rename(join(web, onlineInstallerName(tag)), join(output, onlineInstallerName(tag)))
