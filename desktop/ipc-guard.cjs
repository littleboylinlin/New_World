'use strict'

/**
 * Pure Electron IPC sender verification helpers separating the privileged main library
 * window from the limited quick-capture window and rejecting untrusted origins/subframes.
 */

function isTrustedOriginFrame(event, appUrl) {
  if (!event || typeof appUrl !== 'string' || !appUrl) return false
  const frame = event.senderFrame
  const mainFrame = event.sender?.mainFrame
  return Boolean(frame && mainFrame && frame === mainFrame && typeof frame.url === 'string' && frame.url.startsWith(appUrl))
}

function isWindowWebContents(event, win) {
  return Boolean(win && !win.isDestroyed?.() && event?.sender && event.sender === win.webContents)
}

function isTrustedMainRenderer(event, { appUrl, mainWindow }) {
  return isWindowWebContents(event, mainWindow) && isTrustedOriginFrame(event, appUrl)
}

function isTrustedCaptureRenderer(event, { appUrl, captureWindow }) {
  return isWindowWebContents(event, captureWindow) && isTrustedOriginFrame(event, appUrl)
}

function isTrustedAppRenderer(event, { appUrl, mainWindow, captureWindow }) {
  return isTrustedMainRenderer(event, { appUrl, mainWindow }) || isTrustedCaptureRenderer(event, { appUrl, captureWindow })
}

/** The only route a separate reading window may show: one chapter or one original file, read-only. */
const readingRoute = /^#\/compare\/(original|reference)\/[0-9a-f-]{36}\/(file|[0-9a-f-]{36}\/[0-9a-f-]{36})$/

function isReadingRoute(hash) {
  return typeof hash === 'string' && hash.length <= 200 && readingRoute.test(hash)
}

const storySettingsRoute = /^#\/story-settings\/(original|reference)\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

function isStorySettingsRoute(hash) {
  return typeof hash === 'string' && storySettingsRoute.test(hash)
}

/** A secondary window may only ask for its language pack. */
function isTrustedSecondaryRenderer(event, appUrl, windows) {
  for (const win of windows) {
    if (isWindowWebContents(event, win) && isTrustedOriginFrame(event, appUrl)) return true
  }
  return false
}

function isTrustedTaskNotification(contents, permission, details, { appUrl, mainWindow }) {
  return permission === 'notifications' && isWindowWebContents({ sender: contents }, mainWindow)
    && details?.isMainFrame === true && typeof details.requestingUrl === 'string'
    && details.requestingUrl.split('#')[0] === appUrl
    && contents.getURL().split('#')[0] === appUrl
}

function shouldCancelClientConfirmations(previousClient, updatedClient) {
  if (!updatedClient || !updatedClient.enabled || !updatedClient.permissions?.delete) return true
  if (!previousClient) return false
  if (previousClient.scope?.mode !== updatedClient.scope?.mode) return true
  if (updatedClient.scope?.mode === 'selected') {
    const prevSet = new Set(Array.isArray(previousClient.scope?.workIds) ? previousClient.scope.workIds : [])
    const nextSet = new Set(Array.isArray(updatedClient.scope?.workIds) ? updatedClient.scope.workIds : [])
    for (const id of prevSet) {
      if (!nextSet.has(id)) return true
    }
  }
  return false
}

module.exports = {
  isTrustedOriginFrame,
  isTrustedMainRenderer,
  isTrustedCaptureRenderer,
  isTrustedAppRenderer,
  isTrustedTaskNotification,
  isReadingRoute,
  isStorySettingsRoute,
  isTrustedSecondaryRenderer,
  shouldCancelClientConfirmations,
}
