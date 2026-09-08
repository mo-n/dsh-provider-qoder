/** DSH LlmAdapter for the Global Qoder subscription transport. */

import {
  attributionHeaders,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { QoderAuthService } from './auth.ts'
import { buildAuthHeaders } from './cosy.ts'
import { qoderEncodeBody } from './encoding.ts'
import { getQoderChatUrl, type QoderRegion } from './endpoints.ts'
import { QoderLlmError, qoderHttpError } from './errors.ts'
import { redactLogValue, type QoderLogger } from './logging.ts'
import { buildQoderRequestBody, validateQoderRequest } from './serialize.ts'
import { parseQoderSse } from './sse.ts'

export interface QoderCatalogModel {
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  source?: string
  isReasoning?: boolean
  supportsEffort?: boolean
  reasoningEfforts?: Array<{
    id: string
    name: string
    description?: string
  }>
  defaultReasoningEffort?: string
  priceFactor?: number
  contextOptions?: Record<string, { tokenCount?: number; isDefault?: boolean }>
}

export const defaultMaxTokens = 32_768
export const defaultStreamIdleTimeoutMs = 5 * 60 * 1000
export const defaultModels: QoderCatalogModel[] = [
  {
    id: 'cmodel',
    name: 'Cantus (Qoder)',
    description: 'Default Global Qoder subscription model for quick validation',
    contextWindow: 1_000_000,
    maxTokens: defaultMaxTokens,
  },
  {
    id: 'auto',
    name: 'Qoder Auto',
    description: 'Server-routed Global Qoder model pool',
    contextWindow: 180_000,
    maxTokens: defaultMaxTokens,
  },
  {
    id: 'ultimate',
    name: 'Qoder Ultimate',
    description: 'Highest-capability Global Qoder model pool',
    contextWindow: 1_000_000,
    maxTokens: defaultMaxTokens,
  },
  {
    id: 'performance',
    name: 'Qoder Performance',
    description: 'Performance-oriented Global Qoder model pool',
    contextWindow: 1_000_000,
    maxTokens: defaultMaxTokens,
  },
  {
    id: 'efficient',
    name: 'Qoder Efficient',
    description: 'Efficiency-oriented Global Qoder model pool',
    contextWindow: 180_000,
    maxTokens: defaultMaxTokens,
  },
  {
    id: 'lite',
    name: 'Qoder Lite',
    description: 'Basic Global Qoder model pool',
    contextWindow: 180_000,
    maxTokens: defaultMaxTokens,
  },
]

export interface QoderAdapterOptions {
  resolvePat: () => Promise<string>
  models?: readonly QoderCatalogModel[]
  providerId?: string
  providerName?: string
  authService?: QoderAuthService
  fetch?: typeof fetch
  logger?: QoderLogger
  streamIdleTimeoutMs?: number
  region?: QoderRegion
}

function modelInfo(provider: string, model: QoderCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.priceFactor === undefined
      ? model.name
      : `${model.name} （${model.priceFactor}x）`,
    description: model.description,
    inputModalities: ['text'],
  }
}

export class QoderAdapter extends LlmAdapter {
  private readonly resolvePat: () => Promise<string>
  private catalogModels: readonly QoderCatalogModel[]
  private readonly authService: QoderAuthService
  private readonly fetchImpl: typeof fetch
  private readonly logger?: QoderLogger
  private streamIdleTimeoutMs: number
  private readonly providerId: string
  private readonly providerName: string
  private region: QoderRegion

  constructor(options: QoderAdapterOptions) {
    super()
    this.resolvePat = options.resolvePat
    this.catalogModels = options.models && options.models.length > 0 ? options.models : defaultModels
    this.authService = options.authService ?? new QoderAuthService({ fetch: options.fetch })
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.logger = options.logger
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs
    this.providerId = options.providerId ?? 'qoder-official'
    this.providerName = options.providerName ?? 'Qoder'
    this.region = options.region ?? 'global'
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.providerName }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.catalogModels.map(model => modelInfo(provider, model)))
  }

  replaceConfig(
    models: readonly QoderCatalogModel[],
    streamIdleTimeoutMs: number,
    region: QoderRegion = 'global',
  ): void {
    this.catalogModels = models
    this.streamIdleTimeoutMs = streamIdleTimeoutMs
    this.region = region
  }

  override resolveModel(
    provider: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) {
      return Promise.reject(new QoderLlmError('Qoder model resolution was aborted.', 'ABORTED'))
    }
    const configured = this.catalogModels.find(model => model.id === modelId)
    if (configured === undefined) {
      return Promise.resolve({ provider, id: modelId, name: modelId, inputModalities: ['text'] })
    }
    return Promise.resolve({
      ...modelInfo(provider, configured),
      ...configured.contextWindow === undefined
        ? {}
        : { context: { contextWindow: configured.contextWindow } },
      ...configured.maxTokens === undefined
        ? {}
        : { defaultMaxTokens: configured.maxTokens },
      ...configured.reasoningEfforts === undefined || configured.reasoningEfforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: configured.reasoningEfforts.map(effort => ({
                id: ReasoningEffortId(effort.id),
                name: effort.name,
                ...effort.description === undefined ? {} : { description: effort.description },
              })),
              ...configured.defaultReasoningEffort === undefined
                ? {}
                : { defaultEffort: ReasoningEffortId(configured.defaultReasoningEffort) },
            },
          },
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.generate(options)
  }

  private async * generate(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.provider !== this.providerId) {
      throw new QoderLlmError(`Qoder adapter does not own provider "${options.provider}".`, 'INVALID_PROVIDER')
    }
    if (options.signal?.aborted) throw new QoderLlmError('Request was aborted prior to generation.', 'ABORTED')

    // Content validation must finish before PAT exchange or any provider I/O.
    const model = this.catalogModels.find(candidate => candidate.id === (options.model || 'cmodel'))
    const messages = validateQoderRequest(options, model)
    const pat = await this.resolvePat()
    if (!pat) {
      throw new QoderLlmError(
        'Qoder Personal Access Token is missing. Configure Qoder in the Qoder settings page.',
        'MISSING_CREDENTIAL',
      )
    }
    if (options.signal?.aborted) throw new QoderLlmError('Request was aborted.', 'ABORTED')

    const credentials = await this.authService.getCredentials(pat, options.signal, this.region)
    const request = buildQoderRequestBody(options, credentials.userID, messages, model)
    const encodedBody = qoderEncodeBody(JSON.stringify(request))
    const encodedBytes = Buffer.from(encodedBody, 'utf8')
    const chatUrl = getQoderChatUrl(this.region)
    const requestController = new AbortController()
    let idleTimedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const onCallerAbort = (): void => requestController.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onCallerAbort, { once: true })
    const resetIdleTimer = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimedOut = true
        requestController.abort('stream idle timeout')
      }, this.streamIdleTimeoutMs)
    }
    resetIdleTimer()

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
      resetIdleTimer()
      if (!response.ok) {
        throw qoderHttpError(
          `Qoder upstream service returned HTTP ${response.status}.`,
          response,
        )
      }
      if (!response.body) {
        throw new QoderLlmError('Qoder response contains no readable body stream.', 'EMPTY_RESPONSE')
      }
      yield* parseQoderSse(response.body, { onActivity: resetIdleTimer })
    } catch (error: unknown) {
      if (options.signal?.aborted) throw new QoderLlmError('Request was aborted.', 'ABORTED')
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
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      options.signal?.removeEventListener('abort', onCallerAbort)
      requestController.abort('request complete')
    }
  }
}
