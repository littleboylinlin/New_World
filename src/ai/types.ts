export interface AiExecutionSuccess {
  ok: true
  statusCode?: number
  targetSummary?: string
  data: unknown
}

export interface AiExecutionFailure {
  ok: false
  requiresConfirmation?: false
  statusCode: number
  code: string
  message: string
  targetSummary?: string
  details?: Record<string, unknown>
}

export interface AiConfirmationRequired {
  ok: false
  requiresConfirmation: true
  confirmedAction: string
  fingerprint: string
  targetSummary: string
  impact: AiConfirmImpact
}

export type AiExecutionResult =
  | AiExecutionSuccess
  | AiExecutionFailure
  | AiConfirmationRequired

export interface AiDispatchRequest {
  phase: 'execute' | 'prepare-delete' | 'execute-confirmed'
  confirmationId?: string
  approvalGrant?: string
  expectedFingerprint?: string
  client: AiClientSummary
  action: string
  params: Record<string, string>
  query: Record<string, string>
  body: Record<string, unknown>
}

export type PermissionKey = keyof AiPermissions
