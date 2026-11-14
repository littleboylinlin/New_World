import { createConfirmController } from './confirm-dialog'
import { executeAiDispatch } from './executor'
import type { AiDispatchRequest } from './types'

let installed = false

export function mountAiDesktopHost(): void {
  if (installed) return
  const desktop = window.newWorldDesktop
  if (!desktop?.onAiDispatch || !desktop.sendAiDispatchResult || !desktop.onAiConfirmOpen || !desktop.sendAiConfirmDecision) {
    return
  }
  installed = true

  const confirmController = createConfirmController((confirmationId, approved) =>
    desktop.sendAiConfirmDecision!(confirmationId, approved),
  )

  desktop.onAiConfirmOpen((request) => {
    confirmController.enqueue(request)
  })

  desktop.onAiConfirmClose?.(({ confirmationId }) => {
    confirmController.dismiss(confirmationId)
  })

  desktop.onAiDispatch((packet) => {
    void (async () => {
      try {
        const result = await executeAiDispatch(packet.payload as unknown as AiDispatchRequest)
        desktop.sendAiDispatchResult?.(packet.callId, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        desktop.sendAiDispatchResult?.(packet.callId, {
          ok: false,
          statusCode: 500,
          code: 'dispatch_exception',
          message,
        })
      }
    })()
  })
}
