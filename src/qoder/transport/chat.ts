/** Qoder chat request encoding, timeout lifecycle, and SSE streaming. */

import {
  attributionHeaders,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { QoderCatalogModel } from '../catalog.ts'
import { QoderLlmError, qoderHttpError, qoderRequestId } from '../errors.ts'
import type { QoderRegion } from '../region.ts'
import { getQoderChatUrl } from './endpoints.ts'
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
  const encodedBody = qoderEncodeBody(JSON.stringify(request))
  const encodedBytes = Buffer.from(encodedBody, 'utf8')
  const chatUrl = getQoderChatUrl(dependencies.region)
  const requestController = new AbortController()
  let headerTimedOut = false
  let idleTimedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const startedAt = performance.now()
  const onCallerAbort = (): void => requestController.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const headerTimer = setTimeout(() => {
    headerTimedOut = true
    requestController.abort('response header timeout')
  }, dependencies.responseHeaderTimeoutMs)
  const resetIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      requestController.abort('stream idle timeout')
    }, dependencies.streamIdleTimeoutMs)
  }

  try {
    const response = await dependencies.fetch(chatUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'cache-control': 'no-cache',
        'accept-encoding': 'identity',
        'x-model-key': options.model || 'cmodel',
        'x-model-source': model?.source || 'system',
        ...attributionHeaders(),
        ...buildAuthHeaders(encodedBytes, chatUrl, credentials),
      },
      body: encodedBytes,
      signal: requestController.signal,
    })
    clearTimeout(headerTimer)
    dependencies.logger?.debug?.('[Qoder Stream] Response headers received', {
      region: dependencies.region,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      ...qoderRequestId(response.headers) === undefined ? {} : { requestId: qoderRequestId(response.headers) },
    })
    resetIdleTimer()
    if (!response.ok) {
      throw qoderHttpError(`Qoder upstream service returned HTTP ${response.status}.`, response)
    }
    if (!response.body) {
      throw new QoderLlmError('Qoder response contains no readable body stream.', 'EMPTY_RESPONSE')
    }
    yield* parseQoderSse(response.body, { onActivity: resetIdleTimer })
  } catch (error: unknown) {
    if (options.signal?.aborted) throw aborted('Request was aborted.')
    if (headerTimedOut) {
      const failure = new QoderLlmError('Qoder model request exceeded its response header timeout.', 'TIMEOUT')
      dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure))
      throw failure
    }
    if (idleTimedOut) {
      const failure = new QoderLlmError('Qoder model stream exceeded its idle timeout.', 'TIMEOUT')
      dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure))
      throw failure
    }
    if (error instanceof QoderLlmError) {
      dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(error))
      throw error
    }
    const failure = new QoderLlmError('Qoder transport request failed.', 'TRANSPORT', { cause: error })
    dependencies.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
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
