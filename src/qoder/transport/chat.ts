/** Qoder chat request encoding, queue recovery, timeout lifecycle, and SSE streaming. */

import { randomUUID } from 'node:crypto'

import {
  attributionHeaders,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { QoderRequestCompression } from './request-compression.ts'
import type { QoderCatalogModel } from '../catalog.ts'
import { ModelQueue, queueFailure, type QueueClock } from './queue.ts'
import type { QoderQueueLease, QoderQueueUpdate } from '../queue.ts'
import { queuedError } from './wire/queue.ts'
import { QoderLlmError, QoderModelQueuedError, qoderModelError, canRefreshModelCredentials, qoderRequestId } from '../errors.ts'
import type { QoderRegion } from '../region.ts'
import { getQoderChatUrl } from './endpoints.ts'
import { defaultMaxErrorBytes, readLimitedText } from './request.ts'
import { redactLogValue, type QoderLogger } from './logging.ts'
import { buildAuthHeaders, type CosyCredentials } from './wire/cosy.ts'
import { qoderEncodeBodyBytes } from './wire/encoding.ts'
import { buildQoderRequestBody } from './wire/serialize.ts'
import { parseQoderSse } from './wire/sse.ts'
import type { QoderWireMessage, QoderWireRequest } from './wire/wire-types.ts'

export interface QoderChatDependencies {
  fetch: typeof fetch
  logger?: QoderLogger
  region: QoderRegion
  requestCompression?: boolean
  responseHeaderTimeoutMs: number
  streamIdleTimeoutMs: number
  modelQueueMaxWaitMs?: number
  /** Immutable boundary captured before I/O, independent of message-history inference. */
  hostRunId?: string
  onQueueUpdate?: (update: QoderQueueUpdate) => void
  onQueueLease?: (lease: QoderQueueLease) => boolean
  queueClock?: QueueClock
  resolveCredentials?: (refresh: boolean, signal: AbortSignal) => Promise<CosyCredentials>
  refreshCredentials?: (rejected: CosyCredentials, signal?: AbortSignal) => Promise<CosyCredentials>
}

function aborted(message: string): QoderLlmError {
  return new QoderLlmError(message, 'ABORTED')
}

export async function* streamQoderChat(
  options: GenerateOptions,
  model: QoderCatalogModel | undefined,
  credentials: CosyCredentials,
  messages: QoderWireMessage[],
  dependencies: QoderChatDependencies,
): AsyncGenerator<StreamChunk> {
  // The host boundary prevents a compacted, identical next turn from reusing a
  // queue key that an older asynchronous finish can still release.
  const identityScope = options.purpose === undefined && dependencies.hostRunId !== undefined
    ? JSON.stringify([dependencies.region, dependencies.hostRunId]) : dependencies.region
  const request = await buildQoderRequestBody(options, credentials.userID, messages, model, undefined, undefined, identityScope)
  request.session_type = dependencies.region === 'china' ? 'qoderclicn' : 'qodercli'
  const startedAt = performance.now()
  let activeCredentials = credentials
  const resolveCredentials = async (refresh: boolean, signal: AbortSignal): Promise<CosyCredentials> => {
    const next = dependencies.resolveCredentials
      ? await dependencies.resolveCredentials(refresh, signal)
      : refresh && dependencies.refreshCredentials
        ? await dependencies.refreshCredentials(activeCredentials, signal) : activeCredentials
    if (next.userID !== credentials.userID) throw queueFailure('Qoder subscriber changed during queue recovery.', 'QODER_QUEUE_IDENTITY')
    activeCredentials = next
    return next
  }
  const queue = new ModelQueue({
    region: dependencies.region, fetch: dependencies.fetch,
    subscriberId: credentials.userID,
    requestSetId: request.request_set_id, sessionId: request.session_id,
    dshSessionId: options.purpose === undefined && options.sessionId !== undefined ? String(options.sessionId) : undefined,
    runStartedAt: request.business.begin_at,
    model: request.model_config.key, modelName: model?.name, signal: options.signal,
    maxWaitMs: dependencies.modelQueueMaxWaitMs, credentials: resolveCredentials,
    onUpdate: dependencies.onQueueUpdate, onLease: dependencies.onQueueLease,
    logger: dependencies.logger, clock: dependencies.queueClock,
  })
  let sawOutput = false
  const clear = (): void => queue.clear()
  options.signal?.addEventListener('abort', clear, { once: true })
  try {
    for (;;) {
      if (options.signal?.aborted) throw aborted('Request was aborted.')
      try {
        for await (const chunk of streamAttempt(options, model, activeCredentials, request, dependencies)) {
          if (chunk.type !== 'usage' && chunk.type !== 'finish') sawOutput = true
          yield chunk
        }
        return
      } catch (error) {
        if (!(error instanceof QoderModelQueuedError)) throw error
        queue.entered(error.queue)
        if (sawOutput) throw queueFailure('Qoder queued a request after output began; replay was stopped.', 'QODER_QUEUE_AFTER_OUTPUT')
        await queue.wait(error.queue, request.request_id)
        await resolveCredentials(false, options.signal ?? new AbortController().signal)
        request.request_id = randomUUID()
        request.chat_record_id = request.request_id
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', clear)
    await queue.finish(performance.now() - startedAt)
  }
}

async function* streamAttempt(
  options: GenerateOptions,
  model: QoderCatalogModel | undefined,
  credentials: CosyCredentials,
  request: QoderWireRequest,
  dependencies: QoderChatDependencies,
): AsyncGenerator<StreamChunk> {
  const encodedBytes = qoderEncodeBodyBytes(JSON.stringify(request))
  const chatUrl = getQoderChatUrl(dependencies.region)
  const requestController = new AbortController()
  let headerTimedOut = false
  let idleTimedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let chunkCount = 0
  let reqId: ReturnType<typeof qoderRequestId> | undefined
  const startedAt = performance.now()
  let lastActivityAt = startedAt
  const onCallerAbort = (): void => requestController.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  let headerTimer: ReturnType<typeof setTimeout> | undefined
  const resetIdleTimer = (): void => {
    lastActivityAt = performance.now()
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      requestController.abort('stream idle timeout')
    }, dependencies.streamIdleTimeoutMs)
  }

  try {
    const markedTiers = Object.entries(request.model_config.context_config ?? {})
      .filter(([, tier]) => tier.is_default === true)
    dependencies.logger?.debug?.('[Qoder Stream] Request context', redactLogValue({
      sessionId: options.sessionId ?? null,
      requestId: request.request_id,
      model: request.model_config.key,
      region: dependencies.region,
      purpose: options.purpose ?? 'chat',
      contextTier: markedTiers.length === 1 ? markedTiers[0][0] : null,
      context_length: request.parameters.context_length ?? null,
    }))
    const compression = new QoderRequestCompression()
    let response: Response | undefined
    let activeCredentials = credentials
    for (let attempt = 0; attempt < 2; attempt++) {
      if (options.signal?.aborted) throw aborted('Request was aborted.')
      response = await compression.send({
        url: chatUrl, protocol: 'legacy', body: encodedBytes.toString('latin1'),
        enabled: dependencies.requestCompression, signal: requestController.signal,
        logger: dependencies.logger, requestId: request.request_id,
        dispatch: async (wireBody, headers) => {
          headerTimer = setTimeout(() => {
            headerTimedOut = true
            requestController.abort('response header timeout')
          }, dependencies.responseHeaderTimeoutMs)
          try {
            return await dependencies.fetch(chatUrl, {
              method: 'POST', headers, body: wireBody, signal: requestController.signal,
            })
          } finally { clearTimeout(headerTimer) }
        },
        headers: {
          'content-type': 'application/json',
          'accept': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'accept-encoding': 'identity',
          'x-model-key': options.model || 'cmodel',
          'x-model-source': model?.source || 'system',
          ...attributionHeaders(),
          ...buildAuthHeaders(encodedBytes, chatUrl, activeCredentials),
          'X-Request-Id': request.request_id,
          'X-Session-ID': request.session_id,
        },
      })
      clearTimeout(headerTimer)
      reqId = qoderRequestId(response.headers)
      dependencies.logger?.debug?.('[Qoder Stream] Response headers received', {
        region: dependencies.region,
        status: response.status,
        attempt: attempt + 1,
        durationMs: Math.round(performance.now() - startedAt),
        ...reqId === undefined ? {} : { requestId: reqId },
      })
      resetIdleTimer()
      if (response.ok) break

      let bodyText = ''
      try {
        bodyText = (await readLimitedText(response, defaultMaxErrorBytes, 'Qoder model error response')).trim()
      } catch (error) {
        if (requestController.signal.aborted) throw error
        // Diagnostics are optional; the HTTP status still governs recovery and errors.
      }
      const queued = queuedError(bodyText)
      if (queued) throw queued
      const failure = qoderModelError(`Qoder upstream service returned HTTP ${response.status}`, {
        status: response.status,
        headers: response.headers,
        cause: bodyText || undefined,
        source: 'http',
      })
      // Only an HTTP authentication rejection before SSE starts can be retried.
      // Reuse the prepared envelope and turn identity; never replay a partial stream.
      if (attempt === 0 && dependencies.refreshCredentials && canRefreshModelCredentials(failure)) {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        activeCredentials = await dependencies.refreshCredentials(activeCredentials, options.signal)
        if (activeCredentials.userID !== credentials.userID) {
          throw new QoderLlmError('Qoder subscriber identity changed during authentication recovery.', 'AUTH')
        }
        continue
      }
      throw failure
    }
    if (!response) throw new QoderLlmError('Qoder response is missing.', 'EMPTY_RESPONSE')
    if (!response.body) {
      throw new QoderLlmError('Qoder response contains no readable body stream.', 'EMPTY_RESPONSE')
    }

    let firstChunkDurationMs: number | undefined
    let tokenUsage: TokenUsage | undefined
    let finishReason: string | undefined
    const streamStartedAt = performance.now()

    try {
      for await (const chunk of parseQoderSse(response.body, {
        queueRecovery: true,
        onActivity: resetIdleTimer,
        headers: response.headers,
        httpStatus: response.status,
        onControlFrame: kind => {
          if (kind !== 'done') dependencies.logger?.warn?.('[Qoder Stream] Control frame skipped', {
            transport: 'legacy',
            kind,
            ...reqId === undefined ? {} : { requestId: reqId },
          })
        },
      })) {
        compression.confirm()
        chunkCount++
        if (firstChunkDurationMs === undefined) {
          firstChunkDurationMs = Math.round(performance.now() - startedAt)
          dependencies.logger?.debug?.('[Qoder Stream] First chunk received', {
            durationMs: firstChunkDurationMs,
            ...reqId === undefined ? {} : { requestId: reqId },
          })
        }
        if (chunk.type === 'usage') {
          tokenUsage = chunk.usage
        }
        if (chunk.type === 'finish') {
          finishReason = chunk.reason.kind
        }
        yield chunk
      }
    } catch (error) {
      if (chunkCount === 0) compression.rejectLegacyError(error)
      throw error
    }

    dependencies.logger?.debug?.('[Qoder Stream] Stream completed', {
      durationMs: Math.round(performance.now() - startedAt),
      streamDurationMs: Math.round(performance.now() - streamStartedAt),
      chunkCount,
      ...finishReason === undefined ? {} : { finishReason },
      ...tokenUsage === undefined ? {} : { usage: tokenUsage },
      ...reqId === undefined ? {} : { requestId: reqId },
    })
  } catch (error: unknown) {
    if (options.signal?.aborted) throw aborted('Request was aborted.')
    const elapsedMs = Math.round(performance.now() - startedAt)
    if (headerTimedOut) {
      const failure = new QoderLlmError('Qoder model request exceeded its response header timeout.', 'TIMEOUT')
      dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
        phase: 'header',
        elapsedMs,
        timeoutMs: dependencies.responseHeaderTimeoutMs,
      })
      throw failure
    }
    if (idleTimedOut) {
      const failure = new QoderLlmError('Qoder model stream exceeded its idle timeout.', 'TIMEOUT')
      dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
        phase: 'stream-idle',
        chunkCount,
        idleDurationMs: Math.round(performance.now() - lastActivityAt),
        elapsedMs,
        ...reqId === undefined ? {} : { requestId: reqId },
      })
      throw failure
    }
    if (error instanceof QoderModelQueuedError) throw error
    if (error instanceof QoderLlmError) {
      dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(error), {
        chunkCount,
        elapsedMs,
        ...reqId === undefined ? {} : { requestId: reqId },
      })
      throw error
    }
    const failure = new QoderLlmError('Qoder transport request failed.', 'TRANSPORT', { cause: error })
    dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
      chunkCount,
      elapsedMs,
      ...reqId === undefined ? {} : { requestId: reqId },
      cause: redactLogValue(error),
    })
    throw failure
  } finally {
    clearTimeout(headerTimer)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    options.signal?.removeEventListener('abort', onCallerAbort)
    requestController.abort('request complete')
  }
}
