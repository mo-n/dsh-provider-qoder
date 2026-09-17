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
import { defaultModels, effectiveContextWindow, type QoderCatalogModel } from '../qoder/catalog.ts'
import { QoderLlmError } from '../qoder/errors.ts'
import type { QoderTransport } from '../qoder/transport/index.ts'

export { defaultMaxTokens, defaultModels, type QoderCatalogModel } from '../qoder/catalog.ts'
export { defaultResponseHeaderTimeoutMs, defaultStreamIdleTimeoutMs } from '../qoder/transport/index.ts'

export interface QoderAdapterOptions {
  resolveTransport: () => QoderTransport
  models?: readonly QoderCatalogModel[]
  providerId?: string
  providerName?: string
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

  constructor(options: QoderAdapterOptions) {
    super()
    this.resolveTransport = options.resolveTransport
    this.catalogModels = options.models && options.models.length > 0 ? options.models : defaultModels
    this.providerId = options.providerId ?? 'qoder-official'
    this.providerName = options.providerName ?? 'Qoder'
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.providerName }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.catalogModels.map(model => modelInfo(provider, model)))
  }

  replaceModels(models: readonly QoderCatalogModel[]): void {
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
    const configured = this.catalogModels.find(model => model.id === modelId)
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
    const model = this.catalogModels.find(candidate => candidate.id === (options.model || 'cmodel'))
    return this.resolveTransport().stream(options, model)
  }
}
