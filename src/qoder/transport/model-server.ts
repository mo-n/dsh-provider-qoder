/** Bearer-authenticated model-server HTTP SSE transport. */

import { attributionHeaders, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { QoderRequestCompression } from './request-compression.ts'
import type { QoderCatalogModel } from '../catalog.ts'
import { canRefreshModelCredentials, qoderModelServerError, qoderRequestId, QoderLlmError } from '../errors.ts'
import { getQoderModelServerUrl, type QoderRegion } from './endpoints.ts'
import { defaultMaxErrorBytes, readLimitedText } from './request.ts'
import { type QoderLogger } from './logging.ts'
import { prepareQoderRequest, type PreparedQoderRequest } from './wire/prepare.ts'
import { parseModelServerSse } from './wire/model-server-sse.ts'
import { qoderClientType, qoderModelClientHeaders } from './wire/client-identity.ts'
import type { QoderCredentials } from './wire/credentials.ts'
import type { QoderWireMessage } from './wire/model-types.ts'

export interface QoderModelServerDependencies {
  fetch: typeof fetch
  logger?: QoderLogger
  region: QoderRegion
  requestCompression?: boolean
  /** Immutable host turn boundary captured before provider I/O. */
  hostRunId?: string
  responseHeaderTimeoutMs: number
  streamIdleTimeoutMs: number
  refreshCredentials: (rejected: QoderCredentials, signal?: AbortSignal) => Promise<QoderCredentials>
}

/** Convert the shared Qoder turn into the model-server's OpenAI-shaped request. */
export function modelServerBody(request: PreparedQoderRequest): Record<string, unknown> {
  return {
    model: request.modelKey,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    metadata: {
      context: {
        request_id: request.requestId,
        request_set_id: request.requestSetId,
        session_id: request.sessionId,
        task_id: request.taskId,
        client_type: qoderClientType,
      },
      business: request.business,
    },
    ...request.tools.length > 0 ? { tools: request.tools } : {},
    max_tokens: request.maxTokens,
    ...request.contextLength === undefined ? {} : { context_length: request.contextLength },
    ...request.reasoningEffort === undefined ? {} : { reasoning_effort: request.reasoningEffort },
  }
}

export async function* streamModelServerChat(
  options: GenerateOptions,
  model: QoderCatalogModel | undefined,
  credentials: QoderCredentials,
  messages: QoderWireMessage[],
  dependencies: QoderModelServerDependencies,
): AsyncGenerator<StreamChunk> {
  const identityScope = options.purpose === undefined && dependencies.hostRunId !== undefined
    ? JSON.stringify([dependencies.region, dependencies.hostRunId]) : dependencies.region
  const request = await prepareQoderRequest(options, credentials.userID, messages, model, undefined, undefined, identityScope)
  const body = JSON.stringify(modelServerBody(request))
  const startedAt = performance.now()
  dependencies.logger?.debug?.('[Qoder Stream] Request context', {
    requestId: request.requestId,
    model: request.modelKey,
    region: dependencies.region,
    purpose: options.purpose ?? 'chat',
    transport: 'http',
  })
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  let headerTimedOut = false
  let idleTimedOut = false
  let headerTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const clearTimers = (): void => {
    if (headerTimer) clearTimeout(headerTimer)
    if (idleTimer) clearTimeout(idleTimer)
  }
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { idleTimedOut = true; controller.abort('stream idle timeout') }, dependencies.streamIdleTimeoutMs)
  }

  try {
    const compression = new QoderRequestCompression()
    let activeCredentials = credentials
    for (let attempt = 0; attempt < 2; attempt++) {
      if (controller.signal.aborted) throw new QoderLlmError('Qoder model request was aborted.', 'ABORTED')
      let response: Response
      try {
        response = await compression.send({
          url: getQoderModelServerUrl(dependencies.region), protocol: 'http', body,
          enabled: dependencies.requestCompression, signal: controller.signal,
          logger: dependencies.logger, requestId: request.requestId,
          onRejection: async rejection => {
            dependencies.logger?.warn?.('[Qoder Stream] Compression rejected', {
              requestId: request.requestId,
              status: rejection.status,
              contentType: rejection.contentType,
              serverRequestId: rejection.serverRequestId,
              bodyTruncated: rejection.bodyTruncated,
              reason: rejection.reason,
              request: compression.diagnostics,
            })
          },
          dispatch: async (wireBody, headers) => {
            headerTimer = setTimeout(() => { headerTimedOut = true; controller.abort('response header timeout') }, dependencies.responseHeaderTimeoutMs)
            try {
              return await dependencies.fetch(getQoderModelServerUrl(dependencies.region), {
                method: 'POST', headers, body: wireBody, signal: controller.signal,
              })
            } finally { if (headerTimer) clearTimeout(headerTimer) }
          },
          headers: {
            ...attributionHeaders(),
            ...qoderModelClientHeaders(),
            'Accept': 'text/event-stream',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${activeCredentials.authToken}`,
            'X-Request-ID': request.requestId,
            'X-Session-ID': request.sessionId,
          },
        })
      } finally {
        if (headerTimer) clearTimeout(headerTimer)
      }
      const responseRequestId = qoderRequestId(response.headers)
      dependencies.logger?.debug?.('[Qoder Stream] Response headers received', {
        region: dependencies.region,
        transport: 'http',
        status: response.status,
        contentType: response.headers.get('content-type'),
        contentEncoding: response.headers.get('content-encoding'),
        attempt: attempt + 1,
        durationMs: Math.round(performance.now() - startedAt),
        ...responseRequestId === undefined ? {} : { requestId: responseRequestId },
      })
      if (!response.ok) {
        let cause: unknown
        resetIdle()
        try { cause = await readLimitedText(response, defaultMaxErrorBytes, 'Qoder model-server error') }
        catch { cause = undefined }
        if (idleTimer) clearTimeout(idleTimer)
        if (controller.signal.aborted) throw new QoderLlmError('Qoder model-server error body was interrupted.', 'ABORTED')
        dependencies.logger?.warn?.('[Qoder Stream] HTTP request rejected', {
          requestId: request.requestId,
          status: response.status,
          contentType: response.headers.get('content-type'),
          serverRequestId: responseRequestId,
          request: compression.diagnostics,
          bodyAvailable: typeof cause === 'string',
        })
        const error = qoderModelServerError(response.status, cause, 'http', response.headers)
        if (attempt === 0 && canRefreshModelCredentials(error)) {
          activeCredentials = await dependencies.refreshCredentials(activeCredentials, options.signal)
          if (activeCredentials.userID !== credentials.userID) {
            throw new QoderLlmError('Qoder subscriber identity changed during authentication recovery.', 'AUTH')
          }
          continue
        }
        throw error
      }
      if (!response.body) throw new QoderLlmError('Qoder model-server response has no body.', 'EMPTY_RESPONSE')
      resetIdle()
      const streamStartedAt = performance.now()
      let chunkCount = 0
      let firstChunkReceived = false
      let finishReason: string | undefined
      for await (const chunk of parseModelServerSse(response.body, {
        headers: response.headers,
        httpStatus: response.status,
        onActivity: resetIdle,
        onControlFrame: kind => {
          if (kind !== 'done') dependencies.logger?.warn?.('[Qoder Stream] Control frame skipped', {
            transport: 'http',
            kind,
            ...responseRequestId === undefined ? {} : { requestId: responseRequestId },
          })
        },
        onMalformedFrame: details => dependencies.logger?.warn?.('[Qoder Stream] Malformed SSE frame', {
          transport: 'http',
          ...details,
          ...responseRequestId === undefined ? {} : { requestId: responseRequestId },
        }),
      })) {
        compression.confirm()
        chunkCount++
        if (!firstChunkReceived) {
          firstChunkReceived = true
          dependencies.logger?.debug?.('[Qoder Stream] First chunk received', {
            transport: 'http',
            durationMs: Math.round(performance.now() - startedAt),
            ...responseRequestId === undefined ? {} : { requestId: responseRequestId },
          })
        }
        if (chunk.type === 'finish') finishReason = chunk.reason.kind
        yield chunk
      }
      dependencies.logger?.debug?.('[Qoder Stream] Stream completed', {
        transport: 'http',
        durationMs: Math.round(performance.now() - startedAt),
        streamDurationMs: Math.round(performance.now() - streamStartedAt),
        chunkCount,
        ...finishReason === undefined ? {} : { finishReason },
        ...responseRequestId === undefined ? {} : { requestId: responseRequestId },
      })
      return
    }
  } catch (error) {
    if (options.signal?.aborted) throw new QoderLlmError('Qoder model request was aborted.', 'ABORTED')
    if (headerTimedOut) throw new QoderLlmError('Qoder model-server response header timeout.', 'TIMEOUT')
    if (idleTimedOut) throw new QoderLlmError('Qoder model-server stream idle timeout.', 'TIMEOUT')
    throw error
  } finally {
    clearTimers()
    options.signal?.removeEventListener('abort', onAbort)
    controller.abort('stream finished')
  }
}
