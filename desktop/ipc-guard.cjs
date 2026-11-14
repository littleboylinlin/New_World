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
  shouldCancelClientConfirmations,
}
