/** Thin DSH adapter over the Qoder transport seam. */

import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type PreparedAdapterCall,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  contextTiersOf,
  resolveContextTier,
  defaultModels,
  effectiveContextWindow,
  formatModelRate,
  type QoderCatalogModel,
} from '../qoder/catalog.ts'
import type { QoderRegion } from '../qoder/region.ts'
import { QoderCatalogLifecycle } from './catalog-lifecycle.ts'
import type { QoderSessionTierScope, QoderSessionTierSelection } from './rpc-channel.ts'
import { QODER_PROVIDER_ID } from './provider.ts'
import { QoderLlmError } from '../qoder/errors.ts'
import type { QoderTransport } from '../qoder/transport/index.ts'

export interface QoderAdapterSessionStore {
  get(id: string): {
    requestContext(): { provider?: string; model?: string; contextWindow?: number } | undefined
  } | undefined
}

export interface QoderAdapterAgentStore {
  currentInitiator(): { session?: { id: string } } | undefined
}

export interface QoderAdapterOptions {
  resolveTransport: () => QoderTransport
  catalog?: QoderCatalogLifecycle
  region?: () => QoderRegion
  models?: readonly QoderCatalogModel[]
  providerId?: string
  providerName?: string
  sessions?: QoderAdapterSessionStore
  agents?: QoderAdapterAgentStore
  /**
   * Publish accepted discoveries to the host's settings catalog.
   *
   * The return value is ignored: a catalog read never waits for this
   * notification, so a host that persists settings owns its own background
   * scheduling and error handling.
   */
  onModelsDiscovered?: (transport: QoderTransport, models: readonly QoderCatalogModel[]) => unknown
}

function modelInfo(provider: string, model: QoderCatalogModel): LlmModelInfo {
  const rate = formatModelRate(model, true)
  return {
    provider,
    id: model.id,
    name: rate === undefined
      ? model.name
      : `${model.name} （${rate}）`,
    description: model.description,
    inputModalities: model.supportsImages === true ? ['text', 'image'] : ['text'],
  }
}

export class QoderAdapter extends LlmAdapter {
  private readonly resolveTransport: () => QoderTransport
  private catalogModels: readonly QoderCatalogModel[]
  private readonly providerId: string
  private readonly providerName: string
  private readonly catalog: QoderCatalogLifecycle

  private historyRegion: QoderRegion
  private historyRegionChanged = false
  private readonly region: () => QoderRegion
  private readonly sessionTiers = new Map<string, string>()
  private readonly tierListeners = new Set<(scope: QoderSessionTierScope) => void>()
  private readonly sessions?: QoderAdapterSessionStore
  private readonly agents?: QoderAdapterAgentStore

  constructor(options: QoderAdapterOptions) {
    super()
    this.resolveTransport = options.resolveTransport
    this.catalogModels = options.models && options.models.length > 0 ? options.models : defaultModels
    this.providerId = options.providerId ?? QODER_PROVIDER_ID
    this.providerName = options.providerName ?? 'Qoder'
    this.region = options.region ?? (() => 'global')
    this.catalog = options.catalog ?? new QoderCatalogLifecycle({
      resolveTransport: this.resolveTransport,
      region: this.region,
      configuredModels: () => this.catalogModels,
      onDiscovered: options.onModelsDiscovered,
    })
    this.historyRegion = this.region()
    this.sessions = options.sessions
    this.agents = options.agents
  }

  setSessionTier(sessionId: string, modelId: string, tierKey: string, region = this.region()): void {
    const model = this.effectiveModels().find(candidate => candidate.id === modelId)
    if (region !== this.region() || !sessionId || !model
      || !contextTiersOf(model).some(tier => tier.key === tierKey)
      || (this.sessions && !this.sessions.get(sessionId))) {
      throw new QoderLlmError('Invalid session context tier selection.', 'INVALID_REQUEST')
    }
    this.sessionTiers.set(JSON.stringify([region, sessionId, modelId]), tierKey)
    for (const listener of this.tierListeners) {
      try { listener({ region, sessionId, modelId }) } catch { /* A disconnected view cannot reject a committed selection. */ }
    }
  }

  subscribeSessionTiers(listener: (scope: QoderSessionTierScope) => void): () => void {
    this.tierListeners.add(listener)
    return () => { this.tierListeners.delete(listener) }
  }

  readSessionTier(scope: QoderSessionTierScope): QoderSessionTierSelection {
    const { region, sessionId, modelId } = scope
    if (region !== this.region() || !sessionId || (this.sessions && !this.sessions.get(sessionId))) {
      throw new QoderLlmError('Invalid session context tier scope.', 'INVALID_REQUEST')
    }
    const model = this.resolveEffectiveModelForSession(modelId, sessionId)
    const tier = model && resolveContextTier(model, model.contextTier)
    if (!tier) throw new QoderLlmError('Model has no context tiers.', 'INVALID_REQUEST')
    return { ...scope, tierKey: tier.key, tokenCount: tier.tokenCount }
  }

  getSessionTier(sessionId: string, modelId: string): string | undefined {
    return this.sessionTiers.get(JSON.stringify([this.region(), sessionId, modelId]))
  }

  private observeRegion(): void {
    if (this.region() !== this.historyRegion) {
      this.historyRegionChanged = true
      this.historyRegion = this.region()
    }
  }

  resolveEffectiveModelForSession(modelId: string, sessionId?: string): QoderCatalogModel | undefined {
    this.observeRegion()
    const base = this.effectiveModels().find(candidate => candidate.id === modelId)
    if (base === undefined) return undefined
    if (sessionId) {
      const manualTierKey = this.getSessionTier(sessionId, modelId)
      const reqCtx = this.sessions?.get(sessionId)?.requestContext?.()
      const historicalWindow = !this.historyRegionChanged && reqCtx?.provider === this.providerId && reqCtx.model === modelId
        ? reqCtx.contextWindow : undefined
      const tier = resolveContextTier(base, manualTierKey, historicalWindow)
      if (tier) return { ...base, contextTier: tier.key, contextWindow: tier.tokenCount }
    }
    return base
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.providerName }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    await this.catalog.refresh()
    return this.effectiveModels().map(model => modelInfo(provider, model))
  }

  private effectiveModels(): readonly QoderCatalogModel[] {
    return this.catalog.models()
  }

  replaceModels(models: readonly QoderCatalogModel[]): void {
    this.observeRegion()
    this.catalogModels = models
  }

  override resolveModel(
    provider: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) {
      return Promise.reject(new QoderLlmError('Qoder model resolution was aborted.', 'ABORTED'))
    }
    const sessionId = this.agents?.currentInitiator()?.session?.id
    const configured = this.resolveEffectiveModelForSession(modelId, sessionId)
    return this.resolvedModel(provider, modelId, configured)
  }

  override prepareCall(provider: string, modelId: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    if (signal?.aborted) return Promise.reject(new QoderLlmError('Qoder model resolution was aborted.', 'ABORTED'))
    const configured = this.resolveEffectiveModelForSession(modelId, this.agents?.currentInitiator()?.session?.id)
    const snapshot = configured === undefined ? undefined : structuredClone(configured)
    const transport = this.resolveTransport()
    return this.resolvedModel(provider, modelId, snapshot).then(model => ({
      model,
      stream: options => {
        if (options.provider !== this.providerId) {
          throw new QoderLlmError(`Qoder adapter does not own provider "${options.provider}".`, 'INVALID_PROVIDER')
        }
        return transport.stream(options, snapshot)
      },
    }))
  }

  private resolvedModel(provider: string, modelId: string, configured?: QoderCatalogModel): Promise<LlmResolvedModelInfo> {
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
    const model = this.resolveEffectiveModelForSession(options.model || 'cmodel', options.sessionId)
    return this.resolveTransport().stream(options, model)
  }
}
