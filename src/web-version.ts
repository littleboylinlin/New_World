import { t } from './i18n'
import { cornerTip } from './corner-tips'

export const buildId = __BUILD_ID__

/** The web app compares its build with the version.json deployed next to it, without asking GitHub. */
export function mountWebVersionCheck(saveBeforeLeaving: () => Promise<boolean>) {
  if (window.newWorldDesktop) return
  let checking = false
  let offered: string | undefined
  let dismissed: string | undefined

  async function check() {
    if (checking || document.hidden || !navigator.onLine) return
    checking = true
    try {
      const response = await fetch(new URL('./version.json', document.baseURI), { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return
      const deployed: unknown = await response.json()
      const build = deployed && typeof deployed === 'object' ? (deployed as { build?: unknown }).build : undefined
      if (typeof build !== 'string' || !build || build === buildId || build === offered || build === dismissed) return
      offered = build
      cornerTip('version', t('webUpdate.ready'), [{
        label: t('webUpdate.reload'), primary: true,
        run: async () => {
          if (!await saveBeforeLeaving()) throw new Error(t('webUpdate.saveFirst'))
          location.reload()
        },
      }], () => { dismissed = build; offered = undefined })
    } catch { /* The next visit to the tab checks again. */ } finally {
      checking = false
    }
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check() })
  window.setTimeout(() => void check(), 0)
}
