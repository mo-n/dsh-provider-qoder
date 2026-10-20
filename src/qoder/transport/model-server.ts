/** Bearer-authenticated model-server HTTP SSE transport. */

import { attributionHeaders, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdir, open, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QoderCatalogModel } from '../catalog.ts'
import { canRefreshModelCredentials, qoderModelServerError, qoderRequestId, QoderLlmError } from '../errors.ts'
import { getQoderModelServerUrl, type QoderRegion } from './endpoints.ts'
import { defaultMaxErrorBytes, readLimitedText } from './request.ts'
import { type QoderLogger } from './logging.ts'
import { prepareQoderRequest, type PreparedQoderRequest } from './wire/prepare.ts'
import { parseModelServerSse } from './wire/model-server-sse.ts'
import { qoderClientType } from './wire/client-identity.ts'
import type { QoderCredentials } from './wire/credentials.ts'
import type { QoderWireMessage } from './wire/model-types.ts'

export interface QoderModelServerDependencies {
  fetch: typeof fetch
  logger?: QoderLogger
  region: QoderRegion
  responseHeaderTimeoutMs: number
  streamIdleTimeoutMs: number
  refreshCredentials: (rejected: QoderCredentials, signal?: AbortSignal) => Promise<QoderCredentials>
}

interface ModelServerCapture {
  directory: string
  requestPath: string
  responsePath: string
  done: Promise<void>
}

/** Temporary local capture for diagnosing malformed model-server tool arguments. */
async function captureModelServerStream(requestId: string, requestBody: string, stream: ReadableStream<Uint8Array>, onActivity: () => void): Promise<{
  modelStream: ReadableStream<Uint8Array>
  capture: ModelServerCapture
}> {
  const directory = join(tmpdir(), 'dsh-provider-qoder', 'sse-captures', `${requestId}-${crypto.randomUUID()}`)
  const requestPath = join(directory, 'request.json')
  const responsePath = join(directory, 'response.sse')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = await (async () => {
    try {
      await writeFile(requestPath, requestBody, { flag: 'wx', mode: 0o600 })
      return await open(responsePath, 'wx', 0o600)
    } catch (error) {
      await unlink(requestPath).catch(() => undefined)
      await rmdir(directory).catch(() => undefined)
      throw error
    }
  })()
  const [modelStream, captureStream] = stream.tee()
  const reader = captureStream.getReader()
  const done = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        onActivity()
        let offset = 0
        while (offset < value.byteLength) {
          const result = await file.write(value, offset, value.byteLength - offset)
          if (result.bytesWritten === 0) throw new Error('Qoder SSE capture write made no progress.')
          offset += result.bytesWritten
        }
      }
    } finally {
      reader.releaseLock()
      await file.close()
    }
  })()
  // The model parser may still be running when the capture branch settles.
  void done.catch(() => undefined)
  return { modelStream, capture: { directory, requestPath, responsePath, done } }
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
  const request = await prepareQoderRequest(options, credentials.userID, messages, model)
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
    let activeCredentials = credentials
    for (let attempt = 0; attempt < 2; attempt++) {
      if (controller.signal.aborted) throw new QoderLlmError('Qoder model request was aborted.', 'ABORTED')
      headerTimer = setTimeout(() => { headerTimedOut = true; controller.abort('response header timeout') }, dependencies.responseHeaderTimeoutMs)
      let response: Response
      try {
        response = await dependencies.fetch(getQoderModelServerUrl(dependencies.region), {
          method: 'POST',
          headers: {
            ...attributionHeaders(),
            'Accept': 'text/event-stream',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${activeCredentials.authToken}`,
            'X-Request-ID': request.requestId,
            'X-Session-ID': request.sessionId,
          },
          body,
          signal: controller.signal,
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
      let modelStream: ReadableStream<Uint8Array> = response.body
      let capture: ModelServerCapture | undefined
      try {
        const started = await captureModelServerStream(request.requestId, body, response.body, resetIdle)
        modelStream = started.modelStream
        capture = started.capture
      } catch (error) {
        dependencies.logger?.warn?.('[Qoder Stream] SSE capture could not start', {
          requestId: request.requestId,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      resetIdle()
      const streamStartedAt = performance.now()
      let chunkCount = 0
      let firstChunkReceived = false
      let finishReason: string | undefined
      let streamCompleted = false
      try {
        for await (const chunk of parseModelServerSse(modelStream, {
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
        streamCompleted = true
      } finally {
        if (capture !== undefined) {
          let captureComplete = true
          try { await capture.done }
          catch (error) {
            captureComplete = false
            dependencies.logger?.warn?.('[Qoder Stream] SSE capture ended early', {
              requestId: request.requestId,
              reason: error instanceof Error ? error.message : String(error),
            })
          }
          const details = {
            requestId: request.requestId,
            requestPath: capture.requestPath,
            responsePath: capture.responsePath,
            complete: captureComplete,
          }
          if (streamCompleted && captureComplete) dependencies.logger?.debug?.('[Qoder Stream] SSE capture saved', details)
          else dependencies.logger?.warn?.('[Qoder Stream] SSE capture saved', details)
        }
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
