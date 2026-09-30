/**
 * Loopback settings RPC for the Qoder cards.
 *
 * Endpoints use Connection exact Fetch routes on its shared `/api` channel.
 * See ADR-0008 for the reason this replaces the dedicated RPC channel.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  qoderRpcEndpoints,
  qoderRpcPath,
  type QoderRpcEndpoint,
  type QoderRpcResult,
} from './rpc-channel.ts'

/** Qoder's internal dispatcher; Fetch-route authentication remains owned by Connection. */
export type QoderRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<QoderRpcResult<unknown>>

/**
 * Mount every Qoder settings endpoint on the shared API channel.
 *
 * Registering is caller-owned: the returned disposer removes the routes again,
 * so the caller can tie them to its fiber with `ctx.effect`.
 *
 * @param ctx - host context carrying the Connection service.
 * @param handler - decoded endpoint handler, shared by every endpoint.
 * @returns disposer removing every registered route.
 * @throws when Connection exposes no exact Fetch registry.
 */
export function registerQoderRpc(ctx: Context, handler: QoderRpcHandler): () => void {
  const registry = ctx.connection?.fetch
  if (typeof registry?.register !== 'function') {
    throw new Error('provider-qoder: connection exposes no exact Fetch route registry')
  }
  const disposers = qoderRpcEndpoints.map(endpoint => registry.register({
    path: qoderRpcPath(endpoint),
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleQoderRpcRequest(endpoint, handler, request),
  }))
  return () => {
    for (const dispose of disposers) {
      void dispose()
    }
  }
}

/**
 * Decode one request, run the endpoint handler, and encode its result.
 *
 * Failures stay inside the response envelope so the client keeps a single error
 * path; only a malformed body and a handler crash use a transport status.
 */
async function handleQoderRpcRequest(
  endpoint: QoderRpcEndpoint,
  handler: QoderRpcHandler,
  request: Request,
): Promise<Response> {
  if (request.signal.aborted) {
    return Response.json({
      ok: false,
      error: { code: 'ABORTED', message: 'Request aborted', details: { issues: [] } },
    })
  }
  let payload: unknown = {}
  const body = await request.text()
  if (body.trim().length > 0) {
    try {
      payload = JSON.parse(body)
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
  }
  try {
    return Response.json(await handler(endpoint, payload, request.signal))
  } catch (error) {
    if (request.signal.aborted) {
      return Response.json({
        ok: false,
        error: { code: 'ABORTED', message: 'Request aborted', details: { issues: [] } },
      })
    }
    return new Response(`handler failure: ${String(error)}`, { status: 500 })
  }
}
