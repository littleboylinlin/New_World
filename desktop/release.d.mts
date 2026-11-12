export const releaseEndpoint: string
export const releasePages: string
export const desktopReleaseList: string
export interface Installer { tag: string; name: string; url: string; size: number; sha256: string }
export function isStableTag(tag: unknown): tag is string
export function isNewerTag(tag: unknown, currentVersion: string): boolean
export function installerName(tag: string, platform: string, arch: string): string | undefined
export function readWindowsInstaller(tag: string, assets: unknown): Installer | undefined
export function readMacInstaller(tag: string, assets: unknown, arch: string): Installer | undefined
export function isInstallerUrl(address: string, platform: string, arch: string): boolean
export function isWindowsUpdateUrl(address: string): boolean
