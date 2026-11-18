export {
  releaseEndpoint, releasePages, desktopReleaseList as windowsReleaseList, mirrorLatest,
  isStableTag as isWindowsTag, isNewerTag as isNewerWindowsTag,
  readWindowsInstaller, isWindowsUpdateUrl as isUpdateUrl, findInstaller,
} from './release.mjs'
