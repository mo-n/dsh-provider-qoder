/** Qoder chat request encoding, timeout lifecycle, and SSE streaming. */

import {
  attributionHeaders,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { QoderCatalogModel } from '../catalog.ts'
import { QoderLlmError, qoderModelError, canRefreshModelCredentials, qoderRequestId } from '../errors.ts'
import type { QoderRegion } from '../region.ts'
import { getQoderChatUrl } from './endpoints.ts'
import { defaultMaxErrorBytes, readLimitedText } from './request.ts'
import { redactLogValue, type QoderLogger } from './logging.ts'
import { buildAuthHeaders, type CosyCredentials } from './wire/cosy.ts'
import { qoderEncodeBody } from './wire/encoding.ts'
import { buildQoderRequestBody } from './wire/serialize.ts'
import { parseQoderSse } from './wire/sse.ts'
import type { QoderWireMessage } from './wire/wire-types.ts'

export interface QoderChatDependencies {
  fetch: typeof fetch
  logger?: QoderLogger
  region: QoderRegion
  responseHeaderTimeoutMs: number
  streamIdleTimeoutMs: number
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
  const request = await buildQoderRequestBody(options, credentials.userID, messages, model)
  request.session_type = dependencies.region === 'china' ? 'qoderclicn' : 'qodercli'
  const encodedBody = qoderEncodeBody(JSON.stringify(request))
  const encodedBytes = Buffer.from(encodedBody, 'utf8')
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
  let headerTimer = setTimeout(() => {
    headerTimedOut = true
    requestController.abort('response header timeout')
  }, dependencies.responseHeaderTimeoutMs)
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
    let response: Response | undefined
    let activeCredentials = credentials
    for (let attempt = 0; attempt < 2; attempt++) {
      if (options.signal?.aborted) throw aborted('Request was aborted.')
      if (attempt > 0) {
        headerTimer = setTimeout(() => {
          headerTimedOut = true
          requestController.abort('response header timeout')
        }, dependencies.responseHeaderTimeoutMs)
      }
      response = await dependencies.fetch(chatUrl, {
        method: 'POST',
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
        },
        body: encodedBytes,
        signal: requestController.signal,
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

    for await (const chunk of parseQoderSse(response.body, { onActivity: resetIdleTimer, headers: response.headers, httpStatus: response.status })) {
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
