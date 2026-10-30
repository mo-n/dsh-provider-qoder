import { isQoderRpcErrorCode, type QoderRpcErrorCode } from '../dsh/rpc-channel.ts'

export type OperationCause = 'permission-denied' | 'unauthenticated' | 'connection' | 'timeout' | 'cancelled' | 'persistence' | 'unknown'
export type OperationOutcome = 'not-completed' | 'partial' | 'unknown'
export interface OperationError {
  cause: OperationCause
  /** Reads have no mutation outcome. */
  outcome?: OperationOutcome
  stage: string
  completedStages: readonly string[]
  diagnostic: { operation: string; stage: string; cause: OperationCause; outcome?: OperationOutcome; rpcCode?: QoderRpcErrorCode; code?: string; status?: number; completedStages: readonly string[]; context?: { region?: string; sessionId?: string; modelId?: string; tierKey?: string } }
}
export type OperationResult<T> = { ok: true; value: T } | { ok: false; error: OperationError }
export const success = <T>(value: T): OperationResult<T> => ({ ok: true, value })

const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
/** Classify only explicit protocol fields and standard exception names, never error prose. */
export function operationCause(error: unknown): OperationCause {
  const value = record(error)
  const code = value.code
  const status = value.status ?? record(value.details).status
  if (code === 'PERMISSION_DENIED' || code === 'FORBIDDEN' || code === 'EACCES' || code === 'EPERM' || value.name === 'NotAllowedError' || value.name === 'SecurityError') return 'permission-denied'
  if (code === 'UNAUTHENTICATED' || code === 'NO_CREDENTIALS') return 'unauthenticated'
  if (code === 'TIMEOUT' || code === 'ETIMEDOUT' || value.name === 'TimeoutError') return 'timeout'
  if (code === 'ABORTED' || code === 'ABORT_ERR' || value.name === 'AbortError') return 'cancelled'
  if (code === 'PERSISTENCE_FAILED' || code === 'STORAGE_ERROR') return 'persistence'
  if (['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'NETWORK_ERROR'].includes(String(code)) || value.name === 'NetworkError' || record(value.details).cause === 'connection') return 'connection'
  if (status === 403) return 'permission-denied'
  if (status === 401) return 'unauthenticated'
  return 'unknown'
}

/** A whitelist deliberately excludes exception messages, details, values and credentials. */
export function diagnoseOperation(error: OperationError): void {
  console.error('[Qoder settings operation]', error.diagnostic)
}
export function failure(operation: string, stage: string, error: unknown, options: {
  mutation?: boolean; completedStages?: readonly string[]; outcome?: OperationOutcome; context?: { region?: string; sessionId?: string; modelId?: string; tierKey?: string }
} = {}): OperationResult<never> {
  const cause = operationCause(error)
  const completedStages = options.completedStages ?? []
  const raw = record(error)
  // Keep the original RPC classification, without retaining its unsafe message/details.
  const rpcCode = isQoderRpcErrorCode(raw.code) ? raw.code : undefined
  const outcome = options.mutation ? options.outcome ?? (completedStages.length ? 'partial' : 'unknown') : undefined
  const safeCodes = ['PERMISSION_DENIED', 'FORBIDDEN', 'EACCES', 'EPERM', 'PERSISTENCE_FAILED', 'STORAGE_ERROR', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'ETIMEDOUT', 'NETWORK_ERROR', 'ABORT_ERR']
  const code = safeCodes.includes(String(raw.code)) ? String(raw.code) : undefined
  const rawStatus = raw.status ?? record(raw.details).status
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined
  const context = options.context === undefined ? undefined : {
    ...options.context.region === 'global' || options.context.region === 'china' ? { region: options.context.region } : {},
    ...typeof options.context.sessionId === 'string' ? { sessionId: options.context.sessionId } : {},
    ...typeof options.context.modelId === 'string' ? { modelId: options.context.modelId } : {},
    ...typeof options.context.tierKey === 'string' ? { tierKey: options.context.tierKey } : {},
  }
  const result: OperationError = { cause, stage, completedStages,
    ...outcome ? { outcome } : {},
    diagnostic: { operation, stage, cause, ...outcome ? { outcome } : {}, ...rpcCode ? { rpcCode } : {}, ...code ? { code } : {}, ...status ? { status } : {}, completedStages, ...context ? { context } : {} },
  }
  diagnoseOperation(result)
  return { ok: false, error: result }
}

/** Concise presentation uses completion evidence; diagnostic text never reaches the UI. */
export function operationNotice<T extends 'saveFailed' | 'patSaveFailed' | 'removeFailed' | 'regionChangeFailed' | 'featureSaveFailed'>(error: OperationError, fallback: T) {
  if (error.outcome === 'partial') return 'patSavedSelectionFailed' as const
  if (error.outcome === 'unknown') return 'operationOutcomeUnknown' as const
  return fallback
}
