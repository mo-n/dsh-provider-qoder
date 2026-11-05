/**
 * Loopback settings RPC for the Qoder cards.
 *
 * Endpoints use Connection exact Fetch routes on its shared `/api` channel.
 * This keeps the provider behind DSH's platform boundary (ADR-0001) while
 * leaving authentication and route ownership with Connection.
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
 * @returns an idempotent disposer that settles after every route is removed.
 * @throws when Connection exposes no exact Fetch registry.
 */
export function registerQoderRpc(
  ctx: Context,
  handler: QoderRpcHandler,
  subscribeTiers?: (listener: (scope: QoderSessionTierScope) => void) => () => void,
): () => Promise<void> {
  const registry = ctx.connection?.fetch
  if (typeof registry?.register !== 'function') {
    throw new Error('provider-qoder: connection exposes no exact Fetch route registry')
  }
  const streams = new Set<() => void>()
  const disposers: Array<() => unknown> = []
  let closing = false
  try {
    for (const endpoint of qoderRpcEndpoints) disposers.push(registry.register({
      path: qoderRpcPath(endpoint),
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => endpoint === 'sessionTierEvents' && subscribeTiers
        ? closing
          ? Promise.resolve(new Response('provider-qoder: settings RPC is closing', { status: 503 }))
          : Promise.resolve(sessionTierEvents(request, subscribeTiers, streams))
        : handleQoderRpcRequest(endpoint, handler, request),
    }))
  } catch (error) {
    // Registration is synchronous, so rollback cannot be awaited here. Start
    // every cleanup, attach a rejection handler, and preserve the registration
    // failure as the error observed by the caller.
    closing = true
    void disposeResources(streams, [...disposers].reverse()).catch(cleanupError => {
      try {
        // Report the incomplete rollback without logging arbitrary disposer
        // messages or replacing the original synchronous registration error.
        ctx.logger?.warn('[Qoder RPC] Registration rollback cleanup failed', {
          failedCleanups: cleanupError instanceof AggregateError ? cleanupError.errors.length : 1,
        })
      } catch { /* A logger failure must not create an unhandled rejection. */ }
    })
    throw error
  }
  let cleanup: Promise<void> | undefined
  return () => {
    closing = true
    cleanup ??= disposeResources(streams, disposers)
    return cleanup
  }
}

/** Close streams before unregistering routes, while collecting every failure. */
async function disposeResources(streams: Set<() => unknown>, disposers: readonly (() => unknown)[]): Promise<void> {
  const streamClosures = [...streams]
  streams.clear()
  const invoke = (dispose: () => unknown) => {
    try { return Promise.resolve(dispose()) } catch (error) { return Promise.reject(error) }
  }
  const streamPromises = streamClosures.map(invoke)
  const streamResults = streamPromises.length > 0 ? await Promise.allSettled(streamPromises) : []
  const routeResults = await Promise.allSettled(disposers.map(invoke))
  const errors = [
    ...streamResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason),
    ...routeResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason),
  ]
  if (errors.length > 0) throw new AggregateError(errors, 'provider-qoder: failed to dispose settings RPC routes')
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
        const errors: unknown[] = []
        try { unsubscribe() } catch (error) { errors.push(error) }
        try { request.signal.removeEventListener('abort', onAbort) } catch (error) { errors.push(error) }
        streams.delete(close)
        try { controller.close() } catch { /* The reader may already have cancelled. */ }
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) throw new AggregateError(errors, 'provider-qoder: failed to close a session tier stream')
      }
      unsubscribe = subscribe(scope => send(scope))
      streams.add(close)
      const onAbort = () => { try { close() } catch { /* The request has no teardown caller to report to. */ } }
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) onAbort()
      else send({ ready: true })
    },
    cancel() { close() },
  })
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
}
