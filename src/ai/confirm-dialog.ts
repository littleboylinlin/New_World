import { t } from '../i18n'
import { button, element } from '../ui'

export type ConfirmDecisionSender = (confirmationId: string, approved: boolean) => Promise<unknown>

function actionLabel(impact: AiConfirmImpact): string {
  switch (impact.kind) {
    case 'work': return t('ai.confirmKindWork')
    case 'edition': return t('ai.confirmKindEdition')
    case 'chapter': return t('ai.confirmKindChapter')
    case 'source': return t('ai.confirmKindSource')
    case 'idea': return t('ai.confirmKindIdea')
    case 'destructive_update': return t('ai.confirmKindDestructiveUpdate')
    default: return ''
  }
}

function libraryLabel(library?: 'original' | 'reference'): string {
  if (library === 'original') return t('libraries.original')
  if (library === 'reference') return t('libraries.reference')
  return ''
}

export function createConfirmController(sendDecision: ConfirmDecisionSender) {
  const queue: AiConfirmRequest[] = []
  let active: {
    request: AiConfirmRequest
    dialog: HTMLDialogElement
    timer: number
    settled: boolean
  } | null = null

  function settle(request: AiConfirmRequest, approved: boolean) {
    if (active && active.request.confirmationId === request.confirmationId) {
      if (active.settled) return
      active.settled = true
      window.clearInterval(active.timer)
      const dlg = active.dialog
      active = null
      if (dlg.open) dlg.close()
      dlg.remove()
      void sendDecision(request.confirmationId, approved).catch(() => {})
      pump()
      return
    }
    const queuedIndex = queue.findIndex((item) => item.confirmationId === request.confirmationId)
    if (queuedIndex >= 0) {
      queue.splice(queuedIndex, 1)
      void sendDecision(request.confirmationId, approved).catch(() => {})
    }
  }

  function showNext(request: AiConfirmRequest) {
    const { impact } = request
    const dialog = element('dialog', 'modal ai-confirm-dialog') as HTMLDialogElement
    dialog.setAttribute('aria-modal', 'true')

    const titleId = `ai-confirm-title-${request.confirmationId}`
    dialog.setAttribute('aria-labelledby', titleId)

    const head = element('div', 'modal-head')
    const heading = element('h2', undefined, t('ai.confirmTitle'))
    heading.id = titleId
    const closeBtn = button(t('common.close'), 'close')
    closeBtn.setAttribute('aria-label', t('common.close'))
    closeBtn.addEventListener('click', () => settle(request, false))
    head.append(heading, closeBtn)

    const warning = element('p', 'ai-confirm-warning', t('ai.confirmWarning', [request.clientName, actionLabel(impact)]))

    const list = element('dl', 'ai-confirm-details')
    function row(label: string, value: string | number | undefined) {
      if (value === undefined || value === '') return
      list.append(element('dt', undefined, label), element('dd', undefined, String(value)))
    }

    row(t('ai.confirmClient'), request.clientName)
    row(t('ai.confirmAction'), actionLabel(impact))
    if (impact.library) row(t('ai.confirmLibrary'), libraryLabel(impact.library))
    row(t('ai.confirmBook'), impact.bookTitle)
    row(t('ai.confirmEdition'), impact.editionTitle)
    row(t('ai.confirmChapter'), impact.chapterTitle)
    row(t('ai.confirmSource'), impact.sourceName)
    row(t('ai.confirmIdea'), impact.ideaPreview)
    if (impact.affectedChapters !== undefined) {
      row(t('ai.confirmAffectedChapters'), impact.affectedChapters)
    }
    if (impact.affectedWords !== undefined) {
      row(t('ai.confirmAffectedWords'), impact.affectedWords.toLocaleString())
    }
    if (impact.beforeWords !== undefined && impact.afterWords !== undefined) {
      row(t('ai.confirmWordChange'), `${impact.beforeWords.toLocaleString()} -> ${impact.afterWords.toLocaleString()} (-${(impact.lostWords ?? 0).toLocaleString()})`)
    }
    row(t('ai.confirmImpactSummary'), impact.summary)

    const countdown = element('p', 'ai-confirm-countdown')
    const updateCountdown = () => {
      const remaining = Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000))
      countdown.textContent = t('ai.confirmExpiresIn', [remaining])
    }
    updateCountdown()

    const actions = element('div', 'ai-confirm-actions')
    const cancelBtn = button(t('ai.confirmCancel'), 'button button-quiet')
    cancelBtn.type = 'button'
    cancelBtn.addEventListener('click', () => settle(request, false))
    const approveBtn = button(t('ai.confirmApprove'), 'button ai-danger-btn')
    approveBtn.type = 'button'
    approveBtn.addEventListener('click', (event: MouseEvent) => {
      // Only genuine interactive pointer/keyboard activation from the user is accepted.
      if (!event.isTrusted) return
      settle(request, true)
    })
    actions.append(cancelBtn, approveBtn)

    dialog.append(head, warning, list, countdown, actions)

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      settle(request, false)
    })
    dialog.addEventListener('close', () => {
      settle(request, false)
    })

    const timer = window.setInterval(() => {
      updateCountdown()
      if (Date.now() > request.expiresAt) {
        settle(request, false)
      }
    }, 250)

    active = { request, dialog, timer, settled: false }
    document.body.append(dialog)
    dialog.showModal()
    cancelBtn.focus()
  }

  function pump() {
    if (active || !queue.length) return
    const next = queue.shift()!
    if (Date.now() > next.expiresAt) {
      void sendDecision(next.confirmationId, false).catch(() => {})
      pump()
      return
    }
    showNext(next)
  }

  function enqueue(request: AiConfirmRequest) {
    if (active?.request.confirmationId === request.confirmationId) return
    if (queue.some((item) => item.confirmationId === request.confirmationId)) return
    queue.push(request)
    pump()
  }

  function dismiss(confirmationId: string) {
    if (active && active.request.confirmationId === confirmationId) {
      active.settled = true
      window.clearInterval(active.timer)
      const dlg = active.dialog
      active = null
      if (dlg.open) dlg.close()
      dlg.remove()
      pump()
      return
    }
    const index = queue.findIndex((item) => item.confirmationId === confirmationId)
    if (index >= 0) queue.splice(index, 1)
  }

  function destroy() {
    queue.length = 0
    if (active) {
      active.settled = true
      window.clearInterval(active.timer)
      if (active.dialog.open) active.dialog.close()
      active.dialog.remove()
      active = null
    }
  }

  return {
    enqueue,
    dismiss,
    destroy,
  }
}
