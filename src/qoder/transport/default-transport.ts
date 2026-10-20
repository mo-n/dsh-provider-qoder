/** Deep module owning all communication with Qoder. */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { QoderAuthManager } from './auth.ts'
import type { QoderCatalogModel } from '../catalog.ts'
import type { QoderRegion } from './endpoints.ts'
import { QoderLlmError } from '../errors.ts'
import type { QoderLogger } from './logging.ts'
import { fetchQoderModels } from './catalog-reader.ts'
import {
  defaultResponseHeaderTimeoutMs,
  opaqueCredentialKey,
  retryMetadataRead,
  SingleFlight,
} from './request.ts'
import { translateQoderMessages, validateQoderRequestShape } from './wire/prepare.ts'
import { QoderImageUploader } from './image-upload.ts'
import { QoderUsageReader } from './account-reader.ts'
import { QoderSearchClient } from './search.ts'
import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import type { QoderAccountInfo } from '../account.ts'
import type { QoderModelTransport, QoderTransport, QoderTransportOptions } from './index.ts'
import { streamQoderChat } from './chat.ts'
import { QoderBrowserAuthorization } from './browser-authorization.ts'
import type { QoderCredentialLease } from '../authorization.ts'
import type { CosyCredentials } from './wire/cosy.ts'
import { streamModelServerChat } from './model-server.ts'

export const defaultStreamIdleTimeoutMs = 5 * 60 * 1000

function aborted(message: string): QoderLlmError {
  return new QoderLlmError(message, 'ABORTED')
}

export class DefaultQoderTransport implements QoderTransport {
  readonly authorization: QoderBrowserAuthorization
  private readonly resolveCredential: QoderTransportOptions['resolveCredential']
  private readonly region: QoderRegion
  private readonly requestCompression: boolean
  private readonly modelTransport: QoderModelTransport
  private readonly resolvePat: () => Promise<string>
  private readonly fetchImpl: typeof fetch
  private readonly logger?: QoderLogger
  private readonly streamIdleTimeoutMs: number
  private readonly responseHeaderTimeoutMs: number
  private readonly metadataTimeoutMs?: number
  private readonly auth: QoderAuthManager
  private readonly usage: QoderUsageReader
  private readonly modelFlights = new SingleFlight<readonly QoderCatalogModel[]>()
  private readonly attachments?: Pick<AttachmentStore, 'imageLimits' | 'readImageRequest'>
  private readonly imageUploader: QoderImageUploader
  private readonly credentialLeases = new WeakMap<CosyCredentials, QoderCredentialLease>()
  private readonly preserveThinking?: boolean
  private readonly modelQueueMaxWaitMs?: number
  private readonly onQueueUpdate: QoderTransportOptions['onQueueUpdate']
  private readonly captureQueueLeaseOwner: QoderTransportOptions['captureQueueLeaseOwner']

  constructor(options: QoderTransportOptions) {
    this.modelQueueMaxWaitMs = options.modelQueueMaxWaitMs
    this.onQueueUpdate = options.onQueueUpdate
    this.captureQueueLeaseOwner = options.captureQueueLeaseOwner
    this.region = options.region
    this.requestCompression = options.requestCompression ?? true
    this.modelTransport = options.modelTransport ?? 'http'
    this.resolvePat = options.resolvePat
    this.resolveCredential = options.resolveCredential
    this.authorization = new QoderBrowserAuthorization(options)
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.logger = options.logger
    this.logger?.debug?.('[Qoder Transport] Request compression configuration', {
      implementation: 'zstd-v1', node: process.version,
      requestCompression: this.requestCompression,
      environmentOverrideConfigured: process.env.QODER_ZSTD_REQUEST_BODIES !== undefined,
    })
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs
    this.responseHeaderTimeoutMs = options.responseHeaderTimeoutMs ?? defaultResponseHeaderTimeoutMs
    this.metadataTimeoutMs = options.metadataTimeoutMs
    this.attachments = options.attachments
    this.preserveThinking = options.preserveThinking
    this.auth = new QoderAuthManager({
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
    this.imageUploader = new QoderImageUploader({
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      ...options.imageUploadTimeoutMs === undefined ? {} : { timeoutMs: options.imageUploadTimeoutMs },
      ...options.imageUrlCacheTtlMs === undefined ? {} : { cacheTtlMs: options.imageUrlCacheTtlMs },
      refreshCredentials: async (rejected, signal) => {
        const lease = rejected && this.credentialLeases.get(rejected)
        if (!lease) throw aborted('Qoder image credentials are no longer available.')
        return lease.resolve(signal, rejected.authToken)
      },
    })
  }

  stream(options: GenerateOptions, model?: QoderCatalogModel): AsyncIterable<StreamChunk> {
    return this.generate(options, model)
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly QoderCatalogModel[]> {
    const lease = await this.lease(signal)
    const key = lease.key
    return this.modelFlights.run(
      key,
      signal,
      async (sharedSignal) => {
        const credentials = await lease.resolve(sharedSignal)
        const read = (resolved: CosyCredentials) => retryMetadataRead(sharedSignal, () => fetchQoderModels(resolved, {
          fetch: this.fetchImpl,
          signal: sharedSignal,
          logger: this.logger,
          region: this.region,
          timeoutMs: this.metadataTimeoutMs,
        }))
        try { return await read(credentials) } catch (error) {
          if (!(error instanceof QoderLlmError) || error.code !== 'AUTH') throw error
          return read(await lease.resolve(sharedSignal, credentials.authToken))
        }
      },
      () => aborted('Qoder model discovery was aborted.'),
    )
  }

  async readAccount(options?: { force?: boolean; signal?: AbortSignal }): Promise<QoderAccountInfo> {
    const lease = await this.lease(options?.signal)
    let used: CosyCredentials | undefined
    const read = (force = options?.force) => this.usage.readWithCredentials(lease.key, async signal => {
      used = await lease.resolve(signal)
      return used
    }, {
      force,
      signal: options?.signal,
    })
    try { return await read() } catch (error) {
      if (!(error instanceof QoderLlmError) || error.code !== 'AUTH' || !used) throw error
      await lease.resolve(options?.signal, used.authToken)
      return read(true)
    }
  }

  async searchWeb(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const lease = await this.lease(signal)
    let token: string | undefined
    const client = new QoderSearchClient({ fetch: this.fetchImpl, logger: this.logger, region: this.region,
      resolveCredentials: async nextSignal => {
        const credentials = await lease.resolve(nextSignal)
        token = credentials.authToken
        return credentials
      },
      refreshCredentials: (rejected, nextSignal) => lease.resolve(nextSignal, rejected.authToken),
    })
    return client.search(request, signal)
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

  private async lease(signal?: AbortSignal): Promise<QoderCredentialLease> {
    if (signal?.aborted) throw aborted('Qoder request was aborted.')
    const managed = await this.resolveCredential?.(signal)
    if (managed) return managed
    const pat = await this.requirePat(signal)
    return { key: opaqueCredentialKey(pat), resolve: async (nextSignal, rejectedToken) => {
      const current = await this.auth.getCredentials(pat, nextSignal)
      if (rejectedToken !== undefined && current.authToken === rejectedToken) {
        return this.auth.refreshCredentials(pat, current, nextSignal)
      }
      return current
    } }
  }

  private async * generate(
    options: GenerateOptions,
    model?: QoderCatalogModel,
  ): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) throw aborted('Request was aborted prior to generation.')
    const queueOwner = options.sessionId === undefined ? undefined : this.captureQueueLeaseOwner?.(String(options.sessionId))

    // Phase 1: static validation finishes before credential resolution or any
    // provider I/O, so an unusable request never consumes a subscription.
    validateQoderRequestShape(options, model)
    // Phase 2: credentials, which the center image exchange must be able to sign with.
    const lease = await this.lease(options.signal)
    const credentials = await lease.resolve(options.signal)
    this.credentialLeases.set(credentials, lease)
    // Phase 3: read attachments, publish images, and assemble wire messages.
    const messages = await translateQoderMessages(options, this.attachments, {
      uploader: this.imageUploader,
      credentials,
      preserveThinking: this.preserveThinking,
    })
    // Image publication may have refreshed a rejected job token.
    const chatCredentials = await lease.resolve(options.signal)
    const stream = this.modelTransport === 'legacy' ? streamQoderChat : streamModelServerChat
    yield* stream(options, model, chatCredentials, messages, {
      fetch: this.fetchImpl,
      logger: this.logger,
      region: this.region,
      requestCompression: this.requestCompression,
      responseHeaderTimeoutMs: this.responseHeaderTimeoutMs,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
      modelQueueMaxWaitMs: this.modelQueueMaxWaitMs,
      onQueueUpdate: this.onQueueUpdate,
      hostRunId: queueOwner?.runId,
      onQueueLease: queueOwner?.retain,
      resolveCredentials: async (refresh, signal) => {
        const current = await lease.resolve(signal)
        return refresh ? lease.resolve(signal, current.authToken) : current
      },
      refreshCredentials: async (rejected, signal) => {
        return lease.resolve(signal, rejected.authToken)
      },
    })
  }
}
