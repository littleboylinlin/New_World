export const releaseEndpoint: string
export const releasePages: string
export const windowsReleaseList: string
export function isWindowsTag(tag: unknown): tag is string
export function isNewerWindowsTag(tag: unknown, currentVersion: string): boolean
export function readWindowsInstaller(tag: string, assets: unknown): {
  tag: string
  name: string
  url: string
  size: number
  sha256: string
} | undefined
export function isUpdateUrl(address: string): boolean
