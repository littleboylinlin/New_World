import { Arch, Platform, build } from 'electron-builder'
import { prepareDesktopApp } from './prepare-app.mjs'

const output = 'dist-windows'
const { appDir, devDependencies } = await prepareDesktopApp(output)

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
