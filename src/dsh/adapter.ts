/** Thin DSH adapter over the Qoder transport seam. */

import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  defaultModels,
  effectiveContextWindow,
  mergeQoderDiscoveryMetadata,
  type QoderCatalogModel,
} from '../qoder/catalog.ts'
import { QODER_PROVIDER_ID } from './provider.ts'
import { QoderLlmError } from '../qoder/errors.ts'
import type { QoderTransport } from '../qoder/transport/index.ts'

export { defaultMaxTokens, defaultModels, type QoderCatalogModel } from '../qoder/catalog.ts'
export { defaultResponseHeaderTimeoutMs, defaultStreamIdleTimeoutMs } from '../qoder/transport/index.ts'

export interface QoderAdapterOptions {
  resolveTransport: () => QoderTransport
  models?: readonly QoderCatalogModel[]
  providerId?: string
  providerName?: string
  /**
   * Publish accepted automatic discoveries to the host's settings catalog.
   *
   * The return value is ignored: a catalog read never waits for this
   * notification, so a host that persists settings owns its own background
   * scheduling and error handling.
   */
  onModelsDiscovered?: (transport: QoderTransport, models: readonly QoderCatalogModel[]) => unknown
}

function modelInfo(provider: string, model: QoderCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.priceFactor === undefined
      ? model.name
      : `${model.name} （${model.priceFactor}x）`,
    description: model.description,
    inputModalities: model.supportsImages === true ? ['text', 'image'] : ['text'],
  }
}

export class QoderAdapter extends LlmAdapter {
  private readonly resolveTransport: () => QoderTransport
  private catalogModels: readonly QoderCatalogModel[]
  private readonly providerId: string
  private readonly providerName: string
  private readonly onModelsDiscovered?: QoderAdapterOptions['onModelsDiscovered']
  private readonly discoveries = new WeakMap<QoderTransport, {
    models?: readonly QoderCatalogModel[]
    expiresAt: number
    inflight?: Promise<void>
  }>()

  constructor(options: QoderAdapterOptions) {
    super()
    this.resolveTransport = options.resolveTransport
    this.catalogModels = options.models && options.models.length > 0 ? options.models : defaultModels
    this.providerId = options.providerId ?? QODER_PROVIDER_ID
    this.providerName = options.providerName ?? 'Qoder'
    this.onModelsDiscovered = options.onModelsDiscovered
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.providerName }
  }

  /** Refresh advertised metadata on catalog reads, sharing a five-minute transport-local cache. */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const transport = this.resolveTransport()
    let cached = this.discoveries.get(transport)
    if (cached === undefined) {
      cached = { expiresAt: 0 }
      this.discoveries.set(transport, cached)
    }
    const entry = cached
    if (entry.inflight === undefined && Date.now() >= entry.expiresAt) {
      entry.inflight = Promise.resolve().then(() => transport.discoverModels()).then(models => {
        // Explicit discovery replaces this entry; a region switch replaces the transport.
        // Neither obsolete result may overwrite the host's current settings catalog.
        if (this.discoveries.get(transport) !== entry || this.resolveTransport() !== transport) return
        entry.models = models
        entry.expiresAt = Date.now() + 5 * 60 * 1000
        this.publishDiscoveredModels(transport, models)
      }).catch(() => {
        // Discovery is advisory: retain the configured or last advertised models on failure.
      }).finally(() => { entry.inflight = undefined })
    }
    await entry.inflight
    if (this.resolveTransport() !== transport) return this.listModels(provider)
    return this.effectiveModels().map(model => modelInfo(provider, model))
  }

  /**
   * Announce one accepted discovery without joining the catalog read.
   *
   * Persisting metadata can queue behind unrelated settings writes, so awaiting
   * it here would stall every `listModels` call on settings storage.
   */
  private publishDiscoveredModels(transport: QoderTransport, models: readonly QoderCatalogModel[]): void {
    try {
      const pending: unknown = this.onModelsDiscovered?.(transport, models)
      if (pending !== undefined && pending !== null && typeof (pending as Promise<unknown>).catch === 'function') {
        void (pending as Promise<unknown>).catch(() => {})
      }
    } catch {
      // Discovery is advisory: a notification failure never affects catalog reads.
    }
  }

  private effectiveModels(): readonly QoderCatalogModel[] {
    return mergeQoderDiscoveryMetadata(
      this.catalogModels,
      this.discoveries.get(this.resolveTransport())?.models ?? [],
    )
  }

  replaceModels(models: readonly QoderCatalogModel[]): void {
    this.catalogModels = models
  }

  /** Publish an explicit discovery without letting older in-flight reads overwrite it. */
  updateDiscoveredModels(transport: QoderTransport, models: readonly QoderCatalogModel[]): void {
    this.discoveries.set(transport, {
      models,
      expiresAt: Date.now() + 5 * 60 * 1000,
    })
  }

  override resolveModel(
    provider: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) {
      return Promise.reject(new QoderLlmError('Qoder model resolution was aborted.', 'ABORTED'))
    }
    const configured = this.effectiveModels().find(model => model.id === modelId)
    if (configured === undefined) {
      return Promise.resolve({ provider, id: modelId, name: modelId, inputModalities: ['text'] })
    }
    const contextWindow = effectiveContextWindow(configured)
    return Promise.resolve({
      ...modelInfo(provider, configured),
      ...contextWindow === undefined
        ? {}
        : { context: { contextWindow } },
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
              ...configured.isReasoning === false || configured.defaultReasoningEffort === undefined
                ? {}
                : { defaultEffort: ReasoningEffortId(configured.defaultReasoningEffort) },
            },
          },
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== this.providerId) {
      throw new QoderLlmError(`Qoder adapter does not own provider "${options.provider}".`, 'INVALID_PROVIDER')
    }
    const model = this.effectiveModels().find(candidate => candidate.id === (options.model || 'cmodel'))
    return this.resolveTransport().stream(options, model)
  }
}
