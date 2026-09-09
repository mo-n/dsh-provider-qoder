/** Deep module owning all communication with Qoder. */

import {
  attributionHeaders,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { QoderAuthService } from './auth.ts'
import type { QoderCatalogModel } from './catalog.ts'
import { buildAuthHeaders } from './cosy.ts'
import { qoderEncodeBody } from './encoding.ts'
import { getQoderChatUrl, type QoderRegion } from './endpoints.ts'
import { QoderLlmError, qoderHttpError, qoderRequestId } from './errors.ts'
import { redactLogValue, type QoderLogger } from './logging.ts'
import { fetchQoderModels } from './models.ts'
import {
  defaultResponseHeaderTimeoutMs,
  opaqueCredentialKey,
  retryMetadataRead,
  SingleFlight,
} from './request.ts'
import { buildQoderRequestBody, validateQoderRequest } from './serialize.ts'
import { parseQoderSse } from './sse.ts'
import { QoderUsageReader, type QoderAccountInfo } from './usage.ts'

export const defaultStreamIdleTimeoutMs = 5 * 60 * 1000

export interface QoderTransport {
  stream(options: GenerateOptions, model?: QoderCatalogModel): AsyncIterable<StreamChunk>
  discoverModels(signal?: AbortSignal): Promise<readonly QoderCatalogModel[]>
  readAccount(options?: { force?: boolean; signal?: AbortSignal }): Promise<QoderAccountInfo>
}

export interface QoderTransportOptions {
  region: QoderRegion
  resolvePat: () => Promise<string>
  fetch?: typeof fetch
  logger?: QoderLogger
  streamIdleTimeoutMs?: number
  responseHeaderTimeoutMs?: number
  metadataTimeoutMs?: number
  resolveMachineId?: () => string
}

function aborted(message: string): QoderLlmError {
  return new QoderLlmError(message, 'ABORTED')
}

export class DefaultQoderTransport implements QoderTransport {
  private readonly region: QoderRegion
  private readonly resolvePat: () => Promise<string>
  private readonly fetchImpl: typeof fetch
  private readonly logger?: QoderLogger
  private readonly streamIdleTimeoutMs: number
  private readonly responseHeaderTimeoutMs: number
  private readonly metadataTimeoutMs?: number
  private readonly auth: QoderAuthService
  private readonly usage: QoderUsageReader
  private readonly modelFlights = new SingleFlight<readonly QoderCatalogModel[]>()

  constructor(options: QoderTransportOptions) {
    this.region = options.region
    this.resolvePat = options.resolvePat
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.logger = options.logger
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs
    this.responseHeaderTimeoutMs = options.responseHeaderTimeoutMs ?? defaultResponseHeaderTimeoutMs
    this.metadataTimeoutMs = options.metadataTimeoutMs
    this.auth = new QoderAuthService({
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      resolveMachineId: options.resolveMachineId,
    })
    this.usage = new QoderUsageReader({
      authService: this.auth,
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      timeoutMs: this.metadataTimeoutMs,
    })
  }

  stream(options: GenerateOptions, model?: QoderCatalogModel): AsyncIterable<StreamChunk> {
    return this.generate(options, model)
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly QoderCatalogModel[]> {
    const pat = await this.requirePat(signal)
    const key = opaqueCredentialKey(pat)
    return this.modelFlights.run(
      key,
      signal,
      async (sharedSignal) => {
        const credentials = await this.auth.getCredentials(pat, sharedSignal)
        return retryMetadataRead(sharedSignal, () => fetchQoderModels(credentials, {
          fetch: this.fetchImpl,
          signal: sharedSignal,
          logger: this.logger,
          region: this.region,
          timeoutMs: this.metadataTimeoutMs,
        }))
      },
      () => aborted('Qoder model discovery was aborted.'),
    )
  }

  async readAccount(options?: { force?: boolean; signal?: AbortSignal }): Promise<QoderAccountInfo> {
    const pat = await this.requirePat(options?.signal)
    return this.usage.readAccount(pat, {
      force: options?.force,
      signal: options?.signal,
    })
  }

  private async requirePat(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw aborted('Qoder request was aborted.')
    const pat = (await this.resolvePat()).trim()
    if (!pat) {
      throw new QoderLlmError(
        'Qoder Personal Access Token is missing. Configure Qoder in the Qoder settings page.',
        'MISSING_CREDENTIAL',
      )
    }
    if (signal?.aborted) throw aborted('Qoder request was aborted.')
    return pat
  }

  private async * generate(
    options: GenerateOptions,
    model?: QoderCatalogModel,
  ): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) throw aborted('Request was aborted prior to generation.')

    // Validation finishes before credential resolution or any provider I/O.
    const messages = validateQoderRequest(options, model)
    const pat = await this.requirePat(options.signal)
    const credentials = await this.auth.getCredentials(pat, options.signal)
    const request = buildQoderRequestBody(options, credentials.userID, messages, model)
    const encodedBody = qoderEncodeBody(JSON.stringify(request))
    const encodedBytes = Buffer.from(encodedBody, 'utf8')
    const chatUrl = getQoderChatUrl(this.region)
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
    }, this.responseHeaderTimeoutMs)
    const resetIdleTimer = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimedOut = true
        requestController.abort('stream idle timeout')
      }, this.streamIdleTimeoutMs)
    }

    try {
      const response = await this.fetchImpl(chatUrl, {
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
      this.logger?.debug?.('[Qoder Stream] Response headers received', {
        region: this.region,
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
        this.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure))
        throw failure
      }
      if (idleTimedOut) {
        const failure = new QoderLlmError('Qoder model stream exceeded its idle timeout.', 'TIMEOUT')
        this.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure))
        throw failure
      }
      if (error instanceof QoderLlmError) {
        this.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(error))
        throw error
      }
      const failure = new QoderLlmError('Qoder transport request failed.', 'TRANSPORT', { cause: error })
      this.logger?.error?.('[Qoder Stream] Request failed', redactLogValue(failure), {
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
}

export function createQoderTransport(options: QoderTransportOptions): QoderTransport {
  return new DefaultQoderTransport(options)
}
