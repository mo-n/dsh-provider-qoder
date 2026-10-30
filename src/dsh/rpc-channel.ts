/**
 * Shared Connection channel facts for the Qoder settings RPC.
 *
 * Browser-safe: the host registration and the client caller both import this
 * module so the route path cannot drift between the two halves.
 */

import type { QoderAccountInfo } from '../qoder/account.ts'
import type { QoderAuthorizationView } from '../qoder/authorization.ts'
import type { QoderCatalogModel } from '../qoder/catalog.ts'
import type { QoderQueueSnapshot } from '../qoder/queue.ts'
import type { QoderRegion } from '../qoder/region.ts'
 
/** Logical channel owning the Qoder settings endpoints. */
export const qoderRpcChannel = '/qoder-subscription'

/**
 * Absolute Fetch-route prefix. Connection mounts its shared, authenticated API
 * channel at `/api`, and every exact Fetch route lives directly below it.
 */
export const qoderRpcApiPath = `/api${qoderRpcChannel}`

/** Endpoints the account card, the model catalog, and the composer context select call. */
export const qoderRpcEndpoints = ['account', 'models', 'queue', 'sessionTier', 'readSessionTier', 'sessionTierEvents', 'authorization', 'beginLogin', 'cancelLogin', 'selectAuthorization'] as const

export type QoderRpcEndpoint = (typeof qoderRpcEndpoints)[number]

export interface QoderSessionTierScope {
  region: QoderRegion
  sessionId: string
  modelId: string
}

export interface QoderSessionTierSelection extends QoderSessionTierScope {
  tierKey: string
  tokenCount: number
}

export interface QoderSessionTierPayload extends QoderSessionTierScope {
  tierKey: string
}

/** Ordinary JSON endpoints; the NDJSON event stream is deliberately separate. */
export interface QoderRpcContract {
  account: { input: { force?: boolean }; output: QoderAccountInfo }
  models: { input: Record<string, never>; output: readonly QoderCatalogModel[] }
  queue: { input: { sessionId: string }; output: QoderQueueSnapshot[] }
  sessionTier: { input: QoderSessionTierPayload; output: QoderSessionTierSelection }
  readSessionTier: { input: QoderSessionTierScope; output: QoderSessionTierSelection }
  authorization: { input: { region: QoderRegion }; output: QoderAuthorizationView }
  beginLogin: { input: { region: QoderRegion }; output: QoderAuthorizationView }
  cancelLogin: { input: { region: QoderRegion }; output: QoderAuthorizationView }
  selectAuthorization: { input: { region: QoderRegion; method: 'pat' | 'browser' | 'none' }; output: QoderAuthorizationView }
}

export type QoderJsonRpcEndpoint = keyof QoderRpcContract
export type QoderRpcInput<E extends QoderJsonRpcEndpoint> = QoderRpcContract[E]['input']
export type QoderRpcOutput<E extends QoderJsonRpcEndpoint> = QoderRpcContract[E]['output']

/** Absolute Fetch-route path of one endpoint. */
export function qoderRpcPath(endpoint: QoderRpcEndpoint): string {
  return `${qoderRpcApiPath}/${endpoint}`
}

/** Type guard for an untrusted endpoint name. */
export function isQoderRpcEndpoint(value: unknown): value is QoderRpcEndpoint {
  return typeof value === 'string' && (qoderRpcEndpoints as readonly string[]).includes(value)
}

/** Standard diagnostic codes carried in a settings RPC failure envelope. */
export const qoderRpcErrorCodes = [
  'NO_CREDENTIALS',
  'UNAUTHENTICATED',
  'UPSTREAM_ERROR',
  'TIMEOUT',
  'ABORTED',
  'UNKNOWN_ENDPOINT',
  'INTERNAL',
  'INVALID_REQUEST',
] as const

export type QoderRpcErrorCode = (typeof qoderRpcErrorCodes)[number]

/** Type guard for an untrusted error code. */
export function isQoderRpcErrorCode(value: unknown): value is QoderRpcErrorCode {
  return typeof value === 'string' && (qoderRpcErrorCodes as readonly string[]).includes(value)
}

/** Successful outcome for a Qoder settings RPC request. */
export interface QoderRpcSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** Structured failure detail carried in a Qoder settings RPC failure outcome. */
export interface QoderRpcErrorDetail {
  readonly code: QoderRpcErrorCode
  readonly message: string
  readonly details?: object
}

/** Failed outcome for a Qoder settings RPC request. */
export interface QoderRpcFailure {
  readonly ok: false
  readonly error: QoderRpcErrorDetail
}

/** Standard result envelope for the Qoder settings RPC. */
export type QoderRpcResult<T> = QoderRpcSuccess<T> | QoderRpcFailure
