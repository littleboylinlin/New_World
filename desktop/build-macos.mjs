import { Arch, Platform, build } from 'electron-builder'
import { prepareDesktopApp } from './prepare-app.mjs'

if (process.platform !== 'darwin') throw new Error('Build macOS installers on macOS')
const arch = process.env.MACOS_ARCH || process.arch
if (!['arm64', 'x64'].includes(arch) || arch !== process.arch) throw new Error('Build each macOS architecture on a matching native runner')
const output = 'dist-macos'
const { appDir, devDependencies } = await prepareDesktopApp(output)

// Ad-hoc signing needs no certificate and must also run for pull-request builds.
process.env.CSC_FOR_PULL_REQUEST = 'true'

await build({
  targets: Platform.MAC.createTarget('dmg', arch === 'arm64' ? Arch.arm64 : Arch.x64),
  publish: 'never',
  config: {
    appId: 'com.littleboylinlin.newworld', productName: 'New World',
    electronVersion: devDependencies.electron, electronLanguages: ['en-US'],
    directories: { app: appDir, output, buildResources: 'desktop' },
    beforeBuild: () => false, publish: null,
    mac: {
      extendInfo: { CFBundleDocumentTypes: [{ CFBundleTypeName: 'New_World Project', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Owner', LSItemContentTypes: ['com.littleboylinlin.newworld.project'], CFBundleTypeExtensions: ['newworld'] }], UTExportedTypeDeclarations: [{ UTTypeIdentifier: 'com.littleboylinlin.newworld.project', UTTypeDescription: 'New_World Project', UTTypeConformsTo: ['public.zip-archive'], UTTypeTagSpecification: { 'public.filename-extension': ['newworld'], 'public.mime-type': 'application/vnd.newworld.project+zip' } }] },
      icon: 'desktop/icon.icns', category: 'public.app-category.productivity',
      artifactName: 'New-World-${version}-macos-${arch}.${ext}',
      minimumSystemVersion: '13.0', identity: '-', hardenedRuntime: false, gatekeeperAssess: false, notarize: false,
    },
    dmg: {
      title: 'New World ${version}', iconSize: 100,
      window: { width: 540, height: 380 },
    },
  },
})
