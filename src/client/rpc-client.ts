/**
 * Browser caller for the Qoder settings RPC.
 *
 * Requests go to Connection's shared `/api` channel, which the connection
 * plugin mounts itself and guards with its Host/Origin fence and browser
 * authentication; the caller only has to carry the session cookie.
 */

import { qoderRpcPath, type QoderRpcEndpoint } from '../dsh/rpc-channel.ts'

export type QoderRpcOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

interface QoderRpcEnvelope {
  ok?: unknown
  value?: unknown
  error?: { message?: unknown }
}

export interface QoderRpcTransport {
  /** Transport override for tests; defaults to the page's global fetch. */
  fetch?: typeof globalThis.fetch
}

export interface QoderRpcCaller {
  call<T>(endpoint: QoderRpcEndpoint, payload: unknown, signal?: AbortSignal): Promise<QoderRpcOutcome<T>>
}

/**
 * Create the caller used by the account card and the model catalog.
 *
 * Failures are returned rather than thrown so the cards keep their existing
 * "result or undefined" handling: a transport status becomes a transport
 * failure message, and an endpoint failure keeps the provider's own message.
 */
export function createQoderRpcCaller(transport: QoderRpcTransport = {}): QoderRpcCaller {
  const send = transport.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
  return {
    async call<T>(endpoint: QoderRpcEndpoint, payload: unknown, signal?: AbortSignal): Promise<QoderRpcOutcome<T>> {
      const path = qoderRpcPath(endpoint)
      try {
        const response = await send(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload ?? {}),
          ...signal === undefined ? {} : { signal },
        })
        if (!response.ok) return { ok: false, error: `transport failure for ${path}: HTTP ${response.status}` }
        const envelope = await response.json() as QoderRpcEnvelope
        if (envelope?.ok === true) return { ok: true, data: envelope.value as T }
        const message = envelope?.error?.message
        return { ok: false, error: typeof message === 'string' ? message : 'RPC returned error' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
