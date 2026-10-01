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
  type QoderSessionTierScope,
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
export function registerQoderRpc(
  ctx: Context,
  handler: QoderRpcHandler,
  subscribeTiers?: (listener: (scope: QoderSessionTierScope) => void) => () => void,
): () => void {
  const registry = ctx.connection?.fetch
  if (typeof registry?.register !== 'function') {
    throw new Error('provider-qoder: connection exposes no exact Fetch route registry')
  }
  const streams = new Set<() => void>()
  const disposers = qoderRpcEndpoints.map(endpoint => registry.register({
    path: qoderRpcPath(endpoint),
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => endpoint === 'sessionTierEvents' && subscribeTiers
      ? Promise.resolve(sessionTierEvents(request, subscribeTiers, streams))
      : handleQoderRpcRequest(endpoint, handler, request),
  }))
  return () => {
    for (const close of streams) close()
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

/** Authenticated change stream; reconnecting clients reread on the initial ready item. */
function sessionTierEvents(
  request: Request,
  subscribe: (listener: (scope: QoderSessionTierScope) => void) => () => void,
  streams: Set<() => void>,
): Response {
  let close = () => {}
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false
      let unsubscribe = () => {}
      const send = (value: unknown) => { if (!ended) controller.enqueue(encoder.encode(JSON.stringify(value) + '\n')) }
      close = () => {
        if (ended) return
        ended = true
        unsubscribe()
        request.signal.removeEventListener('abort', close)
        streams.delete(close)
        try { controller.close() } catch { /* The reader may already have cancelled. */ }
      }
      unsubscribe = subscribe(scope => send(scope))
      streams.add(close)
      request.signal.addEventListener('abort', close, { once: true })
      if (request.signal.aborted) close()
      else send({ ready: true })
    },
    cancel() { close() },
  })
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
}
