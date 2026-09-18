/**
 * Shared Connection channel facts for the Qoder settings RPC.
 *
 * Browser-safe: the host registration and the client caller both import this
 * module so the route path cannot drift between the two halves.
 */

/** Logical channel owning the Qoder settings endpoints. */
export const qoderRpcChannel = '/qoder-subscription'

/**
 * Absolute Fetch-route prefix. Connection mounts its shared, authenticated API
 * channel at `/api`, and every exact Fetch route lives directly below it.
 */
export const qoderRpcApiPath = `/api${qoderRpcChannel}`

/** Endpoints the account card and the model catalog call. */
export const qoderRpcEndpoints = ['account', 'models'] as const

export type QoderRpcEndpoint = (typeof qoderRpcEndpoints)[number]

/** Absolute Fetch-route path of one endpoint. */
export function qoderRpcPath(endpoint: QoderRpcEndpoint): string {
  return `${qoderRpcApiPath}/${endpoint}`
}

/** Type guard for an untrusted endpoint name. */
export function isQoderRpcEndpoint(value: unknown): value is QoderRpcEndpoint {
  return typeof value === 'string' && (qoderRpcEndpoints as readonly string[]).includes(value)
}
